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
function setup({ adapter = {}, forge = null, locked = false, pipeline, killed = new Set() } = {}) {
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
  const queue = createQueue(1, () => new Promise(() => {}), undefined, { onAdd: (j) => store.addQueued(j), onRemove: (j) => store.removeQueued(j) });
  const ops = createOps({
    cfg, store, forge, queue,
    adapter: /** @type {any} */ (adapter),
    cancelRun: (ref) => killed.has(ref),
    intake: (jobs, o) => intaken.push([jobs, o]),
    emit: (e, ref, step, x) => events.push([e, ref, step, x]),
    heartbeat: { update: (p) => beats.push(p) },
    pull: async () => {},
    isLocked: () => locked,
  });
  const audit = () => fs.readFileSync(path.join(dir, "control-audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  return { dir, cfg, store, queue, ops, intaken, events, beats, audit };
}

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
  assert.deepEqual(c, { ref: "W", killed: false, dequeued: ["code"] });
  assert.equal(s.store.listQueued().length, 0, "queue.json follows");
  assert.deepEqual(s.events.at(-1).slice(0, 3), ["dequeued", "W", "code"]);
  const k = await s.ops.cancel({ ref: "RUN" });
  assert.equal(k.killed, true);
  await assert.rejects(() => s.ops.cancel({ ref: "NOPE" }), /neither running nor queued/);
  await assert.rejects(() => s.ops.cancel({}), /ref is required/);
});

test("run: guards against a ref already in the pipeline, enters the first step, force skips the guard", async () => {
  /** @type {any[]} */ const entered = [];
  let stage = null;
  const s = setup({
    adapter: {
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
  assert.match(a[1].error, /neither running nor queued/);
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
    assert.deepEqual(refused, { ok: false, error: "ghost is neither running nor queued here" });
    const unknown = await controlRequest(sock, "rm-rf", {}, { timeoutMs: 2000 });
    assert.equal(unknown.ok, false);
  } finally {
    control?.close();
  }
});
