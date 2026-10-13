import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createOps, ttlCache } from "../src/ops.js";
import { createStore } from "../src/store.js";
import { createQueue } from "../src/queue.js";
import { startControl } from "../src/control.js";
import { controlRequest } from "../src/ui/control-client.js";

/** @param {{adapter?: any, forge?: any, locked?: boolean, pipeline?: any[], killed?: Set<string>}} [o] */
function setup({ adapter = {}, forge = null, locked = false, pipeline, killed = new Set(), accept = true, queueRun } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthook-ops-"));
  const cfg = /** @type {any} */ ({
    name: "t",
    provider: "github",
    stateDir: dir,
    dataDir: dir,
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
