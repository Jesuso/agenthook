import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// ops.js control-plane: ttlCache, pause/resume, cancel, set_concurrency, run, retry, catchup,
// release, dismiss, audit log, reload and the control socket transport — the mutating/transport
// side of the operator surface (board/prs/digest/summary/epics/tickets live in the sibling files).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ttlCache } from "../src/ops.js";
import { createLocalAdapter, seedBoard } from "../src/trackers/local.js";
import { startControl } from "../src/control.js";
import { controlRequest } from "../src/ui/control-client.js";
import { setup } from "./_ops-helpers.js";

test("ttlCache: reset() also discards an in-flight fetch (fresh must not return the pre-write read)", async () => {
  /** @type {((v: string) => void)[]} */
  const resolvers = [];
  const c = ttlCache(() => new Promise((r) => resolvers.push(r)), 1000, () => 0);
  const stale = c(); // fetch #1 in flight
  c.reset();
  const fresh = c(); // must start fetch #2, not share #1
  assert.equal(resolvers.length, 2);
  resolvers[1]("new");
  resolvers[0]("old");
  assert.equal(await fresh, "new");
  assert.equal(await stale, "old");
  assert.equal(await c(), "new", "the stale fetch must not overwrite the cache");
});
test("ttlCache: caches within ttl, shares in-flight fetches, never caches failures, reset forces refetch", async () => {
  let n = 0;
  let t = 0;
  const c = ttlCache(async () => ++n, 100, () => t);
  const [a, b] = await Promise.all([c(), c()]);
  assert.equal(a, 1);
  assert.equal(b, 1, "concurrent calls share one fetch");
  t = 50;
  assert.equal(await c(), 1);
  t = 150;
  assert.equal(await c(), 2, "expired");
  c.reset();
  assert.equal(await c(), 3);
  let fail = true;
  const f = ttlCache(async () => { if (fail) throw new Error("x"); return "ok"; }, 1000, () => t);
  await assert.rejects(f, /x/);
  fail = false;
  assert.equal(await f(), "ok", "failure was not cached");
});
test("pause / resume: queue holds, heartbeat flag, resume is refused while a restart owns the queue", async () => {
  const s = setup();
  s.queue.enqueue({ kind: "pipeline", ref: "A", stepId: "code", dedupKey: "a" });
  s.queue.enqueue({ kind: "pipeline", ref: "B", stepId: "code", dedupKey: "b" });
  const p = await s.ops.pause({ actor: "test" });
  assert.equal(p.paused, true);
  assert.equal(s.queue.isPaused(), true);
  assert.ok(s.beats.some((b) => b.paused === true), "heartbeat paused flag set");
  assert.deepEqual(s.beats.at(-1), { overrides: { paused: true } }, "the persisted override is published too");
  const r = await s.ops.resume({});
  assert.equal(r.paused, false);
  assert.equal(s.queue.isPaused(), false);

  const locked = setup({ locked: true });
  await locked.ops.pause({});
  const r2 = await locked.ops.resume({});
  assert.equal(r2.paused, true);
  assert.match(r2.note, /restart/);
  assert.equal(locked.queue.isPaused(), true, "operator resume must not undo a restart's pause");
});
test("cancel + forge.autoMerge: a held ref's auto-merge is turned off before it moves to the failure lane", async () => {
  /** @type {string[]} */
  const order = [];
  const forge = {
    prHead: async () => ({ number: 7, sha: "abc", open: true }),
    disableAutoMerge: async (/** @type {number} */ n) => (order.push(`disable ${n}`), { status: "disabled" }),
  };
  const adapter = { advance: async (/** @type {string} */ ref, /** @type {string} */ s, /** @type {any} */ v) => order.push(`advance ${v.outcome}`) };
  const s = setup({ forge, adapter });
  s.cfg.forge = { type: "github", autoMerge: { tiers: ["low"] } };
  s.store.setHeld("H", { stepId: "code", heldAt: "t" });
  const log = console.log;
  console.log = () => {};
  try {
    await s.ops.cancel({ ref: "H" });
  } finally {
    console.log = log;
  }
  assert.deepEqual(order, ["disable 7", "advance fail"]);
  assert.ok(s.events.some((e) => e[0] === "auto_merge_disabled" && e[1] === "H"));
});
test("set_concurrency {harness}: changes that harness's cap live, never the global one; 0 drains; unknown names reject", async () => {
  const s = setup({ harnessing: { steps: { code: { harnesses: ["qwen"] } }, caps: { qwen: 1, opus: undefined } } });
  s.cfg.harnesses = { qwen: { maxConcurrent: 1 }, opus: { maxConcurrent: undefined } };
  s.cfg.maxConcurrent = 5;
  s.queue.setMax(5);
  s.queue.enqueue({ kind: "pipeline", ref: "A", stepId: "code", dedupKey: "a" }); // runs on qwen (never settles)
  s.queue.enqueue({ kind: "pipeline", ref: "B", stepId: "code", dedupKey: "b" }); // waits on qwen
  assert.equal(s.queue.state().active, 1);
  const r = await s.ops.set_concurrency({ max: 3, harness: "qwen" });
  assert.equal(r.harness, "qwen");
  assert.equal(r.maxConcurrent, 3);
  assert.match(r.note, /persists until reset/);
  assert.deepEqual(s.queue.state().harnesses?.qwen, { active: 2, max: 3, state: "up" }, "the raise started the waiting job");
  assert.equal(s.queue.max(), 5, "global maxConcurrent unchanged");
  assert.ok(!s.beats.some((b) => "maxConcurrent" in b), "heartbeat.maxConcurrent is not touched");
  // 0 drains the harness: no new starts until re-enabled; running agents finish
  const d = await s.ops.set_concurrency({ max: 0, harness: "qwen" });
  assert.equal(d.maxConcurrent, 0);
  assert.match(d.note, /draining/);
  assert.deepEqual(s.queue.state().harnesses?.qwen, { active: 2, max: 0, state: "up" });
  const re = await s.ops.set_concurrency({ max: 2, harness: "qwen" });
  assert.equal(re.maxConcurrent, 2);
  assert.match(re.note, /persists until reset/);
  assert.ok(!s.beats.some((b) => "maxConcurrent" in b), "drain/re-enable never touches heartbeat.maxConcurrent");
  await assert.rejects(() => s.ops.set_concurrency({ max: 0 }), /1\.\.64/); // 0 without a harness
  await assert.rejects(() => s.ops.set_concurrency({ max: 2, harness: "nope" }), /no harness "nope"/);
  await assert.rejects(() => s.ops.set_concurrency({ max: 99, harness: "qwen" }), /0\.\.64/);
  await assert.rejects(() => s.ops.set_concurrency({ max: 2, harness: "" }), /harness is required/);
  // a profile without harnesses: any name rejects
  await assert.rejects(() => setup().ops.set_concurrency({ max: 2, harness: "qwen" }), /no harness "qwen"/);
});
test("set_concurrency validates and applies; cancel kills a running ref and/or dequeues waiting ones", async () => {
  const killed = new Set(["RUN"]);
  const s = setup({ killed });
  await assert.rejects(() => s.ops.set_concurrency({ max: 0 }), /1\.\.64/);
  await assert.rejects(() => s.ops.set_concurrency({ max: 1.5 }), /1\.\.64/);
  const r = await s.ops.set_concurrency({ max: 5 });
  assert.equal(r.maxConcurrent, 5);
  assert.equal(s.queue.max(), 5);

  s.queue.setMax(1);
  s.queue.enqueue({ kind: "pipeline", ref: "X", stepId: "code", dedupKey: "x" }); // runs (never settles)
  s.queue.enqueue({ kind: "pipeline", ref: "W", stepId: "code", dedupKey: "w" }); // waits
  const c = await s.ops.cancel({ ref: "W" });
  assert.equal(c.killed, false);
  assert.deepEqual(c.dequeued, ["code"]);
  assert.equal(s.store.listQueued().length, 0, "queue.json follows");
  assert.ok(s.events.some((e) => e[0] === "dequeued" && e[1] === "W" && e[2] === "code"));
  const k = await s.ops.cancel({ ref: "RUN" });
  assert.equal(k.killed, true);
  assert.equal(k.moved, undefined, "a killed agent moves via dispatch, not here");
  await assert.rejects(() => s.ops.cancel({ ref: "NOPE" }), /not running, queued or held/);
  await assert.rejects(() => s.ops.cancel({}), /ref is required/);
});
test("run: guards against a ref already in the pipeline, enters the first step, force skips the guard", async () => {
  /** @type {any[]} */ const entered = [];
  let stage = null;
  const s = setup({
    adapter: {
      fetchTask: async (ref) => {
        if (ref === "404") throw new Error("no such task");
        return { ref, name: "T", completed: ref === "done" };
      },
      currentStage: async () => stage,
      enterStage: async (ref, step, o) => { entered.push([ref, step, o]); return { stage: `src-${step}` }; },
    },
  });
  const r = await s.ops.run({ ref: "9" });
  assert.equal(r.step, "triage");
  assert.deepEqual(entered[0], ["9", "triage", { assign: true }]);
  await s.ops.run({ ref: "9", step: "code", assign: false });
  assert.deepEqual(entered[1], ["9", "code", { assign: false }]);
  stage = "label:code";
  await assert.rejects(() => s.ops.run({ ref: "9" }), /already in the pipeline/);
  await s.ops.run({ ref: "9", force: true });
  assert.equal(entered.length, 3);
  await assert.rejects(() => s.ops.run({ ref: "9", step: "nope" }), /no step "nope"/);
  await assert.rejects(() => s.ops.run({ ref: "404" }), /404 not found \(no such task\)/);
  await assert.rejects(() => s.ops.run({ ref: "done" }), /already completed/);
  assert.equal(entered.length, 3, "neither refusal reached enterStage");
  await s.ops.run({ ref: "done", force: true });
  assert.equal(entered.length, 4);
});
test("retry: a failed LOCAL ticket (resting in the failure stage) is not \"already completed\" — it re-enters the step (#585)", async () => {
  const pipeline = [
    { id: "code", sourceStatus: "code", successStatus: "done", failureStatus: "blocked" },
    { id: "done", manual: true, sourceStatus: "done" },
  ];
  const boardCfg = /** @type {any} */ ({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "agenthook-ops-local-")), pipeline });
  seedBoard(boardCfg, [{ ref: "7", name: "T" }], "blocked");
  const s = setup({ adapter: createLocalAdapter(boardCfg, /** @type {any} */ ({})), pipeline });
  fs.writeFileSync(
    path.join(s.dir, "events.jsonl"),
    [{ event: "run_start", ref: "7", step: "code" }, { event: "failed", ref: "7", step: "code", reason: "x" }].map((l) => JSON.stringify({ ts: "2026-10-25T00:00:00Z", ...l })).join("\n") + "\n",
  );
  const r = await s.ops.retry({ ref: "7" });
  assert.equal(r.step, "code");
  assert.equal(r.stage, "code");
});
test("retry: re-enters a failed ticket's failed step without assigning; refuses anything not failed or not ours", async () => {
  /** @type {any[]} */ const entered = [];
  let stage = "label:failed";
  const s = setup({
    adapter: {
      describe: () => ({ stageKeys: { source: "sourceLabel" } }),
      fetchTask: async (ref) => ({ ref, name: "T", assignedToUs: ref !== "theirs", completed: false }),
      currentStage: async () => stage,
      enterStage: async (ref, step, o) => { entered.push([ref, step, o]); return { stage: `src-${step}` }; },
    },
    pipeline: [{ id: "triage", sourceLabel: "label:triage" }, { id: "code", sourceLabel: "label:code" }, { id: "done", manual: true }],
  });
  const ev = (/** @type {any[]} */ ...lines) => fs.writeFileSync(path.join(s.dir, "events.jsonl"), lines.map((l) => JSON.stringify({ ts: "2026-10-25T00:00:00Z", ...l })).join("\n") + "\n");
  ev(
    { event: "run_start", ref: "7", step: "code" },
    { event: "failed", ref: "7", step: "code", reason: "non-zero exit (1)" },
    { event: "run_start", ref: "theirs", step: "code" },
    { event: "failed", ref: "theirs", step: "code", reason: "x" },
    { event: "run_start", ref: "ok", step: "code" },
    { event: "pipeline_done", ref: "ok", step: "code" },
  );
  const r = await s.ops.retry({ ref: "7" });
  assert.deepEqual(r, { ref: "7", step: "code", stage: "src-code", note: r.note });
  assert.deepEqual(entered[0], ["7", "code", { assign: false }], "retry never assigns");
  await assert.rejects(() => s.ops.retry({ ref: "theirs" }), /not assigned to us/);
  await assert.rejects(() => s.ops.retry({ ref: "ok" }), /not failed/);
  await assert.rejects(() => s.ops.retry({ ref: "nope" }), /not failed/);
  await assert.rejects(() => s.ops.retry({}), /ref is required/);
  assert.equal(entered.length, 1, "no refusal reached the tracker");
  // Still resting in the source stage (no failure lane): a no-op move fires no webhook — queue it.
  stage = "label:code";
  const q = await s.ops.retry({ ref: "7" });
  assert.deepEqual(q, { ref: "7", step: "code", queued: true });
  assert.equal(entered.length, 1);
  assert.equal(s.intaken.at(-1)[0][0].stepId, "code");
  assert.deepEqual(s.intaken.at(-1)[1], { force: true });
  // Dismissed since, held, running: nothing to retry.
  ev({ event: "failed", ref: "7", step: "code", reason: "x" }, { event: "dismissed", ref: "7", step: "" });
  await assert.rejects(() => s.ops.retry({ ref: "7" }), /not failed/);
  s.store.setHeld("h", { stepId: "code", heldAt: "t" });
  await assert.rejects(() => s.ops.retry({ ref: "h" }), /is held/);
  assert.equal(s.audit().filter((l) => l.cmd === "retry").length, 8);
});
test("catchup: dispatches an unseen ref resting in a source stage; dedup-skips without force; force clears and re-fires", async () => {
  const s = setup({
    adapter: {
      fetchTask: async (ref) => ({ ref, name: "T", assignedToUs: true }),
      forgeCatchup: async (ref) => ({ stepId: "code", dedupKey: `step:code:${ref}` }),
    },
  });
  const r = await s.ops.catchup({ ref: "9" });
  assert.equal(r.step, "code");
  assert.equal(r.dispatched, true);
  assert.deepEqual(s.intaken[0], [[{ kind: "pipeline", ref: "9", stepId: "code", dedupKey: "step:code:9" }], { force: false }]);

  s.store.markSeen("step:code:9");
  const seen = await s.ops.catchup({ ref: "9" });
  assert.equal(seen.dispatched, false);
  assert.match(seen.reason, /already seen/);
  assert.equal(s.intaken.length, 1, "no intake when dedup-skipped");

  const forced = await s.ops.catchup({ ref: "9", force: true });
  assert.equal(forced.dispatched, true);
  assert.equal(forced.clearedDedup, true);
  assert.deepEqual(s.intaken[1][1], { force: true });
});
test("catchup: refuses when not assigned to us, when resting in no source stage, or when the tracker has no support", async () => {
  const s = setup({
    adapter: {
      fetchTask: async (ref) => ({ ref, name: "T", assignedToUs: ref !== "theirs" }),
      forgeCatchup: async (ref) => (ref === "idle" ? { dedupKey: "x" } : { stepId: "code", dedupKey: "x" }),
    },
  });
  await assert.rejects(() => s.ops.catchup({ ref: "theirs" }), /not assigned to us/);
  await assert.rejects(() => s.ops.catchup({ ref: "idle" }), /not in any pipeline source stage/);
  assert.equal(s.intaken.length, 0);

  const noSupport = setup({ adapter: { fetchTask: async () => ({ assignedToUs: true }) } });
  await assert.rejects(() => noSupport.ops.catchup({ ref: "1" }), /no catchup support/);
});
test("catchup: not accepted (coalesced) is reported as dispatched:false, not success", async () => {
  const s = setup({
    accept: false,
    adapter: {
      fetchTask: async (ref) => ({ ref, assignedToUs: true }),
      forgeCatchup: async (ref) => ({ stepId: "code", dedupKey: `step:code:${ref}` }),
    },
  });
  const r = await s.ops.catchup({ ref: "9" });
  assert.equal(r.dispatched, false);
  assert.match(r.reason, /queued or running/);
});
test("release: resumes a held ref through the @agent gate with the comment; refuses otherwise", async () => {
  const s = setup();
  await assert.rejects(() => s.ops.release({ ref: "5", comment: "go" }), /cannot be released/);
  s.store.setHeld("5", { stepId: "code", reason: "which db?", heldAt: "x" });
  const r = await s.ops.release({ ref: "5", comment: "use postgres", actor: "mcp" });
  assert.equal(r.step, "code");
  const [jobs, opts] = s.intaken[0];
  assert.equal(jobs[0].comment, "use postgres");
  assert.equal(jobs[0].stepId, "code");
  assert.match(jobs[0].dedupKey, /^trigger:mcp-/);
  assert.deepEqual(opts, { force: true });
  s.store.setHeld("6", { stepId: "done", heldAt: "x" }); // manual step
  await assert.rejects(() => s.ops.release({ ref: "6", comment: "x" }), /cannot be released/);
});
test("audit: every write is logged (ok and failed) with actor, never the comment text", async () => {
  const s = setup();
  s.store.setHeld("5", { stepId: "code", heldAt: "x" });
  await s.ops.release({ ref: "5", comment: "SECRET-ANSWER", actor: "mcp" });
  await assert.rejects(() => s.ops.cancel({ ref: "nope", actor: "mcp" }));
  const a = s.audit();
  assert.equal(a[0].cmd, "release");
  assert.equal(a[0].ok, true);
  assert.equal(a[0].actor, "mcp");
  assert.equal(a[0].args.commentChars, 13);
  assert.ok(!JSON.stringify(a).includes("SECRET-ANSWER"));
  assert.equal(a[1].ok, false);
  assert.match(a[1].error, /not running, queued or held/);
  if (process.platform !== "win32") assert.equal(fs.statSync(path.join(s.dir, "control-audit.jsonl")).mode & 0o777, 0o600);
});
test("reload: delegates to the engine's reload dep (audited); no dep → refused; a thrown error is audited failed", async () => {
  let calls = 0;
  const s = setup({ reload: async () => (calls++, { changed: ["maxConcurrent", "pipeline[code].model"], note: "reloaded 2 key(s)" }) });
  const r = await s.ops.reload({ actor: "mcp" });
  assert.equal(calls, 1);
  assert.deepEqual(r, { changed: ["maxConcurrent", "pipeline[code].model"], note: "reloaded 2 key(s)" });
  assert.deepEqual(s.audit().map((l) => [l.cmd, l.actor, l.ok]), [["reload", "mcp", true]]);

  await assert.rejects(() => setup().ops.reload({}), /not available/);

  const failing = setup({ reload: async () => { throw new Error("restart required for: pipeline"); } });
  await assert.rejects(() => failing.ops.reload({ actor: "mcp" }), /restart required/);
  assert.deepEqual(failing.audit().map((l) => [l.cmd, l.ok]), [["reload", false]]);
});
test("control socket: ops commands are reachable and their refusals are exposed (not masked)", async () => {
  const s = setup();
  const sock = path.join(s.dir, "c.sock");
  const control = await startControl(/** @type {any} */ ({ name: "t", controlSock: sock, pidFile: path.join(s.dir, "pid") }), { startedAt: "x", commands: s.ops });
  try {
    const ok = await controlRequest(sock, "pause", { actor: "t" }, { timeoutMs: 2000 });
    assert.equal(ok.ok, true);
    const refused = await controlRequest(sock, "cancel", { ref: "ghost" }, { timeoutMs: 2000 });
    assert.deepEqual(refused, { ok: false, error: "ghost is not running, queued or held here" });
    const unknown = await controlRequest(sock, "rm-rf", {}, { timeoutMs: 2000 });
    assert.equal(unknown.ok, false);
  } finally {
    control?.close();
  }
});
test("cancel of a WAITING job finishes the abandon: ticket moved to the failure lane, state cleared, seen key freed", async () => {
  /** @type {any[]} */ const advanced = [];
  const s = setup({ adapter: { advance: async (ref, step, v) => void advanced.push([ref, step, v]) } });
  s.queue.enqueue({ kind: "pipeline", ref: "X", stepId: "code", dedupKey: "x" }); // takes the only slot
  s.queue.enqueue({ kind: "pipeline", ref: "W", stepId: "code", dedupKey: "step:code:W" });
  s.store.markSeen("step:code:W");
  s.store.setDifficulty("W", "hard");
  const r = await s.ops.cancel({ ref: "W" });
  assert.equal(r.moved, true);
  assert.deepEqual(advanced, [["W", "code", { outcome: "fail", reason: "cancelled by operator" }]]);
  assert.equal(s.store.hasSeen("step:code:W"), false, "a later re-entry of the stage must not be deduped away");
  assert.equal(s.store.getDifficulty("W"), undefined);
  assert.deepEqual(s.left, ["W"]);
  assert.ok(s.events.some((e) => e[0] === "failed" && e[1] === "W" && e[3]?.reason === "cancelled by operator"));
});
test("cancel of a HELD ref abandons it (hold cleared, moved to failure lane); a tracker error is reported, state still cleared", async () => {
  const ok = setup({ adapter: { advance: async () => {} } });
  ok.store.setHeld("H", { stepId: "code", heldAt: "x" });
  const r = await ok.ops.cancel({ ref: "H" });
  assert.deepEqual([r.killed, r.releasedHold, r.moved], [false, true, true]);
  assert.equal(ok.store.getHeld("H"), undefined);

  const bad = setup({ adapter: { advance: async () => { throw new Error("tracker 500"); } } });
  bad.store.setHeld("H", { stepId: "code", heldAt: "x" });
  const r2 = await bad.ops.cancel({ ref: "H" });
  assert.equal(r2.moved, false);
  assert.match(r2.moveError, /tracker 500/);
  assert.equal(bad.store.getHeld("H"), undefined, "the stale hold is gone even when the tracker move failed");
});
test("resume pulls the backlog (pulls were skipped while paused), but not while a restart owns the queue", async () => {
  const s = setup();
  await s.ops.pause({});
  await s.ops.resume({});
  assert.deepEqual(s.pulls, ["pull"]);
  const locked = setup({ locked: true });
  await locked.ops.resume({});
  assert.deepEqual(locked.pulls, []);
});
test("exposed error text is bounded (adapter errors can embed whole API bodies)", async () => {
  const s = setup({ adapter: { fetchTask: async (ref) => ({ ref, name: "T", completed: false }), currentStage: async () => { throw new Error("GitHub 422: " + "x".repeat(5000)); }, enterStage: async () => ({ stage: "s" }) } });
  await assert.rejects(
    () => s.ops.run({ ref: "1" }),
    (e) => e.expose === true && e.message.length <= 500 && e.message.endsWith("…") && e.message.startsWith("GitHub 422:"),
  );
});
test("release right after the hold event waits for the previous run to settle instead of being coalesced away", async () => {
  /** @type {() => void} */
  let finish = () => {};
  const s = setup({ queueRun: (j) => new Promise((r) => (finish = () => r({ kind: j.kind, ref: j.ref, name: "n", url: "", code: 0 }))) });
  s.queue.enqueue({ kind: "pipeline", ref: "5", stepId: "code", dedupKey: "orig" }); // the held run, still in its cleanup
  s.store.setHeld("5", { stepId: "code", heldAt: "x" });
  const p = s.ops.release({ ref: "5", comment: "go" });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(s.intaken.length, 0, "not enqueued while the previous run is still finishing");
  finish();
  const r = await p;
  assert.equal(r.queued, true);
  assert.equal(s.intaken.length, 1);
});
test("release reports a dropped resume job instead of claiming it was queued", async () => {
  const s = setup({ accept: false });
  s.store.setHeld("5", { stepId: "code", heldAt: "x" });
  await assert.rejects(() => s.ops.release({ ref: "5", comment: "go" }), /resume job was not accepted/);
});
test("dismiss writes a dismissed event; refuses running, queued and held refs", async () => {
  const killed = new Set(["RUN"]);
  const s = setup({ killed });
  const ok = await s.ops.dismiss({ ref: "F" });
  assert.deepEqual(ok, { ref: "F", dismissed: true });
  assert.deepEqual(s.events.at(-1), ["dismissed", "F", "", { by: "operator" }]);
  await assert.rejects(() => s.ops.dismiss({}), /ref is required/);
  s.store.setHeld("H", { stepId: "code", heldAt: "x" });
  await assert.rejects(() => s.ops.dismiss({ ref: "H" }), /is held/);
  s.store.setRunning("R", { stepId: "code", startedAt: "x" });
  await assert.rejects(() => s.ops.dismiss({ ref: "R" }), /is running/);
  s.queue.enqueue({ kind: "pipeline", ref: "X", stepId: "code", dedupKey: "x" });
  s.queue.enqueue({ kind: "pipeline", ref: "Q", stepId: "code", dedupKey: "q" });
  await assert.rejects(() => s.ops.dismiss({ ref: "Q" }), /is queued/);
  assert.equal(s.events.filter((e) => e[0] === "dismissed").length, 1, "refusals write nothing");
  assert.ok(s.audit().some((l) => l.cmd === "dismiss" && l.ok === true));
});

