import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createOps, ttlCache } from "../src/ops.js";
import { createEpicChanged } from "../src/epic-changed.js";
import { createStore } from "../src/store.js";
import { createQueue } from "../src/queue.js";
import { startControl } from "../src/control.js";
import { controlRequest } from "../src/ui/control-client.js";

/** @param {{adapter?: any, forge?: any, locked?: boolean, pipeline?: any[], killed?: Set<string>, tracker?: any, onEpicChanged?: (reset: () => void) => void}} [o] */
function setup({ adapter = {}, forge = null, locked = false, pipeline, killed = new Set(), accept = true, queueRun, tracker, onEpicChanged } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthook-ops-"));
  const cfg = /** @type {any} */ ({
    name: "t",
    provider: "github",
    stateDir: dir,
    dataDir: dir,
    tracker,
    pipeline: pipeline ?? [{ id: "triage", queueLabel: "backlog" }, { id: "code" }, { id: "done", manual: true }],
  });
  const store = createStore(dir);
  /** @type {any[]} */ const intaken = [];
  /** @type {any[]} */ const events = [];
  /** @type {any[]} */ const beats = [];
  const queue = createQueue(1, queueRun ?? (() => new Promise(() => {})), undefined, { onAdd: (j) => store.addQueued(j), onRemove: (j) => store.removeQueued(j) });
  /** @type {string[]} */ const pulls = [];
  /** @type {string[]} */ const left = [];
  const ops = createOps({
    cfg, store, forge, queue,
    leavePipeline: (ref) => left.push(ref),
    adapter: /** @type {any} */ (adapter),
    cancelRun: (ref) => killed.has(ref),
    intake: (jobs, o) => (intaken.push([jobs, o]), accept ? jobs.length : 0),
    emit: (e, ref, step, x) => events.push([e, ref, step, x]),
    heartbeat: { update: (p) => beats.push(p) },
    pull: async () => void pulls.push("pull"),
    isLocked: () => locked,
    onEpicChanged,
  });
  const audit = () => fs.readFileSync(path.join(dir, "control-audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  return { dir, cfg, store, queue, ops, intaken, events, beats, audit, pulls, left };
}

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
  assert.deepEqual(s.beats.at(-1), { paused: true });
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

test("board: resting + backlog per step with refmeta labels, cached; prs needs a forge", async () => {
  let calls = 0;
  const s = setup({
    adapter: {
      listResting: async () => { calls++; return [{ kind: "pipeline", ref: "1", stepId: "code" }, { kind: "pipeline", ref: "2", stepId: "triage" }]; },
      listQueued: async () => ["3"],
    },
  });
  s.store.setRefMeta("1", { displayId: "#1", title: "One" });
  const b = await s.ops.board({});
  assert.deepEqual(b.steps.map((x) => x.step), ["triage", "code"], "manual steps excluded");
  assert.deepEqual(b.steps[1].resting, [{ ref: "1", id: "#1", title: "One" }]);
  assert.deepEqual(b.steps[0].backlog, [{ ref: "3" }]);
  await s.ops.board({});
  assert.equal(calls, 1, "cached");
  await s.ops.board({ fresh: true });
  assert.equal(calls, 2);
  await assert.rejects(() => s.ops.prs({}), /no forge/);
  const withForge = setup({ forge: { listAgentPrs: async () => [{ number: 4, ref: "1", ci: "success" }] } });
  assert.equal((await withForge.ops.prs({})).prs[0].number, 4);
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

test("writes drop the cached board/prs, so the next read sees the post-write board", async () => {
  let calls = 0;
  const s = setup({
    adapter: { listResting: async () => { calls++; return []; }, advance: async () => {} },
    forge: { listAgentPrs: async () => [] },
  });
  await s.ops.board({});
  await s.ops.board({});
  assert.equal(calls, 1, "cached");
  s.store.setHeld("H", { stepId: "code", heldAt: "x" });
  await s.ops.cancel({ ref: "H" });
  await s.ops.board({});
  assert.equal(calls, 2, "cancel invalidated the cache");
});

test("board fetches the per-step backlogs in parallel", async () => {
  let inFlight = 0;
  let peak = 0;
  const s = setup({
    pipeline: [{ id: "a", queueLabel: "qa" }, { id: "b", queueLabel: "qb" }, { id: "c", queueLabel: "qc" }, { id: "done", manual: true }],
    adapter: {
      listResting: async () => [],
      listQueued: async () => { inFlight++; peak = Math.max(peak, inFlight); await new Promise((r) => setTimeout(r, 15)); inFlight--; return []; },
    },
  });
  await s.ops.board({});
  assert.equal(peak, 3);
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

test("prs: marks mine from adapter.ownership; a non-fresh repeat within 5 min does not re-resolve; fresh:true does", async () => {
  /** @type {string[]} */
  const calls = [];
  const adapter = {
    ownership: async (/** @type {string} */ ref) => {
      calls.push(ref);
      return ref === "1" ? "ours" : "not_ours";
    },
  };
  const forge = { listAgentPrs: async () => [{ number: 1, ref: "1", ci: "success" }, { number: 2, ref: "2", ci: "success" }] };
  const s = setup({ adapter, forge });
  const r1 = await s.ops.prs({});
  assert.deepEqual(r1.prs.map((/** @type {any} */ p) => p.mine), [true, false]);
  assert.deepEqual(calls, ["1", "2"]);
  s.store.setHeld("ZZ", { stepId: "code", heldAt: "x" }); // bust the 30s board/prs ttl without fresh
  await s.ops.cancel({ ref: "ZZ" });
  await s.ops.prs({});
  assert.deepEqual(calls, ["1", "2"], "within 5 min, a repeat uncached-board read still reuses the ownership cache");
  await s.ops.prs({ fresh: true });
  assert.deepEqual(calls, ["1", "2", "1", "2"], "fresh:true clears the ownership cache and re-resolves");
});

test("prs: learns merged/closed for known PRs missing from the open list; open ones are not looked up; a failed lookup changes nothing", async () => {
  /** @type {number[]} */
  const looked = [];
  const forge = {
    listAgentPrs: async () => [{ number: 1, ref: "1", ci: "success" }],
    prState: async (/** @type {number} */ n) => {
      looked.push(n);
      if (n === 4) throw new Error("boom");
      return n === 2 ? "merged" : n === 3 ? "closed" : "open";
    },
  };
  const s = setup({ forge });
  s.store.setRefMeta("1", { pr: 1, title: "open one" });
  s.store.setRefMeta("2", { pr: 2, title: "merged one" });
  s.store.setRefMeta("3", { pr: 3 });
  s.store.setRefMeta("4", { pr: 4, title: "lookup fails" });
  s.store.setRefMeta("5", { pr: 5 });
  s.store.setRefMeta("6", { pr: 6, prState: "merged" });
  s.store.setRefMeta("7", { title: "no PR" });
  const r = await s.ops.prs({});
  assert.deepEqual(r.prs.map((/** @type {any} */ p) => p.number), [1]);
  assert.deepEqual(looked.sort(), [2, 3, 4, 5], "open (#1), already-terminal (#6) and PR-less refs are not looked up");
  const meta = s.store.listRefMeta();
  assert.deepEqual(meta["2"], { pr: 2, title: "merged one", prState: "merged" });
  assert.equal(meta["3"].prState, "closed");
  assert.deepEqual(meta["4"], { pr: 4, title: "lookup fails" });
  assert.equal(meta["5"].prState, undefined, "still open → nothing written");
  looked.length = 0;
  await s.ops.prs({ fresh: true });
  assert.deepEqual(looked.sort(), [4, 5], "terminal states are not re-looked up");
});

test("prs: a learned terminal state whose PR shows open again (reopened) is dropped", async () => {
  const s = setup({ forge: { listAgentPrs: async () => [{ number: 1, ref: "1", ci: "success" }], prState: async () => "closed" } });
  s.store.setRefMeta("1", { pr: 1, title: "reopened", prState: "closed" });
  await s.ops.prs({});
  assert.deepEqual(s.store.getRefMeta("1"), { pr: 1, title: "reopened" });
});

test("prs: a forge without prState still lists PRs; lookups are bounded per fill", async () => {
  const plain = setup({ forge: { listAgentPrs: async () => [] } });
  plain.store.setRefMeta("1", { pr: 1 });
  assert.deepEqual((await plain.ops.prs({})).prs, []);
  let n = 0;
  const s = setup({ forge: { listAgentPrs: async () => [], prState: async () => (n++, "open") } });
  for (let i = 1; i <= 30; i++) s.store.setRefMeta(String(i), { pr: i });
  await s.ops.prs({});
  assert.equal(n, 20);
});

test("prs: fresh:true clears the ownership cache so a reassignment is re-resolved", async () => {
  /** @type {string[]} */
  const calls = [];
  let flip = "ours";
  const adapter = { ownership: async (/** @type {string} */ ref) => (calls.push(ref), flip) };
  const forge = { listAgentPrs: async () => [{ number: 1, ref: "1", ci: "success" }] };
  const s = setup({ adapter, forge });
  assert.equal((await s.ops.prs({})).prs[0].mine, true);
  flip = "not_ours";
  assert.equal((await s.ops.prs({})).prs[0].mine, true, "cached within 5 min, old board cache too");
  assert.equal((await s.ops.prs({ fresh: true })).prs[0].mine, false, "fresh clears both caches");
  assert.equal(calls.length, 2);
});

test("prs: check_failed (or a thrown error) omits mine and is never cached", async () => {
  let fail = true;
  const adapter = {
    ownership: async (/** @type {string} */ ref) => {
      if (fail) throw new Error("boom");
      return "ours";
    },
  };
  const forge = { listAgentPrs: async () => [{ number: 1, ref: "1", ci: "success" }] };
  const s = setup({ adapter, forge });
  const r1 = await s.ops.prs({});
  assert.equal("mine" in r1.prs[0], false);
  fail = false;
  const r2 = await s.ops.prs({ fresh: true });
  assert.equal(r2.prs[0].mine, true, "a failed lookup was not cached, so the retry succeeds");
});

test("prs: assigneeFilter:false or no adapter.ownership omits mine on every row", async () => {
  const forge = { listAgentPrs: async () => [{ number: 1, ref: "1", ci: "success" }] };
  const scopedOff = setup({ adapter: { ownership: async () => "ours" }, forge, tracker: { assigneeFilter: false } });
  assert.equal("mine" in (await scopedOff.ops.prs({})).prs[0], false);
  const noMethod = setup({ adapter: {}, forge });
  assert.equal("mine" in (await noMethod.ops.prs({})).prs[0], false);
});

test("prs: {mine:true}/{mine:false} filter after the cache; unfiltered cache is reused", async () => {
  const adapter = { ownership: async (/** @type {string} */ ref) => (ref === "1" ? "ours" : "not_ours") };
  const forge = { listAgentPrs: async () => [{ number: 1, ref: "1", ci: "success" }, { number: 2, ref: "2", ci: "success" }] };
  const s = setup({ adapter, forge });
  const mine = await s.ops.prs({ mine: true });
  assert.deepEqual(mine.prs.map((/** @type {any} */ p) => p.number), [1]);
  const notMine = await s.ops.prs({ mine: false });
  assert.deepEqual(notMine.prs.map((/** @type {any} */ p) => p.number), [2]);
});

test("prs: attaches review from the newest review-kind step's summary (receiver keys win), fresh outside the cache; absent → unchanged", async () => {
  const forge = { listAgentPrs: async () => [{ number: 1, ref: "1", ci: "success" }, { number: 2, ref: "2", ci: "success" }] };
  const s = setup({ forge, pipeline: [{ id: "code" }, { id: "review", kind: "review" }, { id: "audit", kind: "review" }, { id: "done", manual: true }] });
  const r0 = await s.ops.prs({});
  assert.ok(r0.prs.every((/** @type {any} */ p) => !("review" in p)));
  s.store.setSummary("1", "code", { summary: { tier: "code" }, outcome: "advance", run: "c", at: "2026-01-01T00:00:09Z" });
  s.store.setSummary("1", "review", { summary: { tier: "low", outcome: "spoof", at: "spoof" }, outcome: "advance", run: "r", at: "2026-01-01T00:00:02Z" });
  s.store.setSummary("1", "audit", { summary: { tier: "high" }, outcome: "hold", run: "a", at: "2026-01-01T00:00:01Z" });
  const r1 = await s.ops.prs({}); // still inside the ttl — the summary read is not cached
  assert.deepEqual(r1.prs[0].review, { tier: "low", outcome: "advance", at: "2026-01-01T00:00:02Z" });
  assert.equal("review" in r1.prs[1], false);
  s.store.clearSummaries("1");
  assert.equal("review" in (await s.ops.prs({})).prs[0], false);
});

test("cancel of a waiting/held ref clears its summaries", async () => {
  const s = setup({ adapter: { advance: async () => {} } });
  s.store.setHeld("H", { stepId: "code", heldAt: "x" });
  s.store.setSummary("H", "code", { summary: { a: 1 }, outcome: "hold", run: "r", at: "t" });
  await s.ops.cancel({ ref: "H" });
  assert.equal(s.store.getSummaries("H"), undefined);
});

test("digest: delegates to the digester, audited; no digester → refused; not a board write", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthook-ops-"));
  const cfg = /** @type {any} */ ({ name: "t", provider: "github", stateDir: dir, dataDir: dir, pipeline: [{ id: "code" }] });
  const store = createStore(dir);
  const queue = createQueue(1, () => new Promise(() => {}), undefined, {});
  const base = { cfg, store, forge: null, queue, leavePipeline() {}, adapter: /** @type {any} */ ({}), cancelRun: () => false, intake: () => 0, emit() {}, heartbeat: { update() {} }, pull: async () => {}, isLocked: () => false };
  const rec = { text: "hi", generatedAt: "t", basedOnEvents: 0, needsYou: 0 };
  const ok = createOps({ ...base, digester: { request: async () => rec } });
  assert.deepEqual(await ok.digest({ actor: "ui" }), rec);
  const none = createOps(base);
  await assert.rejects(none.digest({}), /not available/);
  const lines = fs.readFileSync(path.join(dir, "control-audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => [l.cmd, l.ok, l.actor]), [["digest", true, "ui"], ["digest", false, "unknown"]]);
});

/** A fake epic-capable adapter counting its tracker reads. */
function epicAdapter() {
  const calls = { listEpics: 0, listEpicTickets: /** @type {string[]} */ ([]) };
  /** @type {Record<string, any[]>} */
  const members = {
    E1: [
      { ref: "11", name: "a", completed: false, stage: "Backlog" },
      { ref: "12", name: "b", completed: true, stage: "Done" },
    ],
    E2: [{ ref: "21", name: "c", completed: false, stage: null }],
  };
  return {
    calls,
    adapter: {
      async listEpics() {
        calls.listEpics++;
        return [
          { ref: "E1", name: "Epic one", url: "u1", status: null, completed: false },
          { ref: "E2", name: "Epic two", url: "u2", status: "On track", completed: false },
        ];
      },
      /** @param {string} ref */
      async listEpicTickets(ref) {
        calls.listEpicTickets.push(ref);
        return members[ref];
      },
    },
  };
}

test("epics: one EpicStats per listed epic, total = its listEpicTickets length", async () => {
  const { adapter, calls } = epicAdapter();
  const { ops } = setup({ adapter });
  const r = await ops.epics({});
  assert.equal(r.live, true);
  assert.equal(r.supported, true);
  assert.deepEqual(r.epics.map((/** @type {any} */ e) => [e.ref, e.total]), [["E1", 2], ["E2", 1]]);
  assert.deepEqual(r.epics[0].byStage, { backlog: 1, running: 0, needsYou: 0, finished: 1, merged: 0, untracked: 0 });
  assert.equal(r.epics[1].status, "On track");
  assert.deepEqual(calls.listEpicTickets.sort(), ["E1", "E2"], "fans out to every epic");
});

test("epics: cached within the TTL, fresh refetches, a write invalidates", async () => {
  const { adapter, calls } = epicAdapter();
  const { ops } = setup({ adapter });
  await ops.epics({});
  await ops.epics({ ref: "E1" });
  assert.equal(calls.listEpics, 1, "second call is served from the cache");
  await ops.epics({ fresh: true });
  assert.equal(calls.listEpics, 2);
  await ops.pause({});
  await ops.epics({});
  assert.equal(calls.listEpics, 3, "a write drops the cached read");
});

test("epics: onEpicChanged hands over a cache reset that is not a control op", async () => {
  const { adapter, calls } = epicAdapter();
  /** @type {(() => void) | undefined} */
  let reset;
  const { ops } = setup({ adapter, onEpicChanged: (r) => { reset = r; } });
  assert.equal(typeof reset, "function");
  assert.ok(!Object.keys(ops).some((k) => /epic_?changed|reset|invalidate/i.test(k)), "no invalidation own property on the commands map");
  await ops.epics({});
  await ops.epics({});
  assert.equal(calls.listEpics, 1);
  reset?.();
  await ops.epics({});
  assert.equal(calls.listEpics, 2, "the next epics call refetches from the tracker");
});

test("epic_changed (engine wiring): one emit, never queued, redelivery deduped, next epics call refetches, no tracker write", async () => {
  const { adapter, calls } = epicAdapter();
  /** @type {string[]} */ const writes = [];
  for (const m of ["advance", "enterStage", "complete", "registerWebhook"]) /** @type {any} */ (adapter)[m] = async () => void writes.push(m);
  /** @type {(() => void) | undefined} */
  let reset;
  const { ops, store, queue, events } = setup({ adapter, onEpicChanged: (r) => { reset = r; } });
  const epicChanged = createEpicChanged({ store, emit: (e, ref, step, x) => events.push([e, ref, step, x]), invalidate: () => reset?.() });
  await ops.epics({});
  const job = { kind: /** @type {const} */ ("epic_changed"), ref: "E1", stepId: "", dedupKey: "epic:guid-1" };
  assert.equal(epicChanged(job), true);
  assert.equal(epicChanged({ ...job }), false, "a redelivery with the same dedupKey emits nothing");
  assert.deepEqual(events, [["epic_changed", "E1", "", undefined]]);
  assert.equal(queue.state().queued, 0);
  assert.equal(queue.state().active, 0);
  assert.equal(store.listQueued().length, 0);
  await ops.epics({});
  assert.equal(calls.listEpics, 2, "the cached epics read was dropped");
  assert.deepEqual(writes, []);
});

test("epics: the local join is fresh on every call (outside the cache)", async () => {
  const { adapter } = epicAdapter();
  const { ops, store } = setup({ adapter });
  assert.equal((await ops.epics({})).epics[0].byStage.running, 0);
  store.setRunning("11", { stepId: "code", dedupKey: "k", startedAt: new Date().toISOString() });
  const r = await ops.epics({});
  assert.equal(r.epics[0].byStage.running, 1);
  assert.equal(r.epics[0].byStage.backlog, 0);
});

test("epics: an adapter without epic readers → supported:false, no throw", async () => {
  const { ops } = setup({ adapter: {} });
  const list = await ops.epics({});
  assert.deepEqual({ ...list, at: undefined }, { at: undefined, live: true, supported: false, epics: [] });
  const one = await ops.epics({ ref: "E1" });
  assert.deepEqual({ ...one, at: undefined }, { at: undefined, live: true, supported: false, epic: null });
});

test("epics {ref}: per-ticket bucket + status; unknown ref → no epic; unsafe ref never reaches the adapter", async () => {
  const { adapter, calls } = epicAdapter();
  const { ops, store } = setup({ adapter });
  store.setRunning("11", { stepId: "code", dedupKey: "k", startedAt: new Date().toISOString() });
  const r = await ops.epics({ ref: "E1" });
  assert.equal(r.epic.ref, "E1");
  assert.equal(r.epic.total, 2);
  assert.deepEqual(r.epic.tickets.map((/** @type {any} */ t) => [t.ref, t.bucket, t.status]), [["11", "running", "running"], ["12", "finished", null]]);
  await assert.rejects(ops.epics({ ref: "E9" }), /no epic E9/);
  const before = calls.listEpics;
  await assert.rejects(ops.epics({ ref: "../x" }), /invalid epic ref/);
  await assert.rejects(ops.epics({ ref: 7 }), /invalid epic ref/);
  await assert.rejects(ops.epics({ tz: 9999 }), /invalid tz/);
  assert.equal(calls.listEpics, before, "adapter never called for a bad ref");
});

test("ticket_add: creates the item through adapter.createTask; audit logs the body's length, never its text", async () => {
  /** @type {any[]} */
  const created = [];
  const s = setup({
    adapter: {
      createTask: async (/** @type {any} */ t) => (created.push(t), { ref: "4", stage: "review", stepId: t.stepId ?? "code" }),
    },
  });
  const r = await s.ops.ticket_add({ actor: "cli", title: "  fix the thing ", body: "secret spec text", step: "review" });
  assert.deepEqual(r, { ref: "4", step: "review", stage: "review" });
  assert.deepEqual(created, [{ name: "fix the thing", description: "secret spec text", stepId: "review" }]);
  const [line] = s.audit();
  assert.equal(line.cmd, "ticket_add");
  assert.equal(line.ok, true);
  assert.equal(line.args.bodyChars, 16);
  assert.equal(line.args.title, "  fix the thing ");
  assert.ok(!JSON.stringify(line).includes("secret spec text"), "body text must not reach the audit log");
});

test("ticket_add: refuses (exposed) without createTask or without a title; adapter errors surface", async () => {
  const none = setup();
  await assert.rejects(() => none.ops.ticket_add({ title: "x" }), (e) => e.expose === true && /has no ticket add/.test(e.message));
  assert.equal(none.audit()[0].ok, false);
  const s = setup({ adapter: { createTask: async () => { throw new Error('local: step "done" is manual'); } } });
  await assert.rejects(() => s.ops.ticket_add({ title: " " }), /title is required/);
  await assert.rejects(() => s.ops.ticket_add({ title: "x", step: "done" }), /is manual/);
});
