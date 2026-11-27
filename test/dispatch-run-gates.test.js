import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// Unit tests for run-gates.js preRunGates (#864): each early return, and the `{repo, tookLock}`
// pass-through once every gate clears. Integration coverage of the same gates through the real
// dispatcher lives in test/dispatch-gates.test.js (epic) and test/overlap.test.js (overlap hold).
import test from "node:test";
import assert from "node:assert/strict";
import { preRunGates } from "../src/dispatch/run-gates.js";
import { createStore } from "../src/store/index.js";
import { tmpDir } from "./_dispatch-helpers.js";

/** @param {{store?: any, cfgOver?: any, adapterOver?: any, resolveRoute?: Function}} [o] */
function deps({ store, cfgOver, adapterOver, resolveRoute } = {}) {
  /** @type {any[]} */
  const events = [];
  const cfg = { overlapGuard: false, ...cfgOver };
  const adapter = {
    advance: async () => {},
    ...adapterOver,
  };
  const emit = (event, ref, step, extra) => events.push({ event, ref, step, ...extra });
  const leaveCalls = [];
  const leavePipeline = (ref) => leaveCalls.push(ref);
  return { cfg, store, emit, adapter, resolveRoute: resolveRoute ?? (() => ({ repo: { id: "r", path: "/repo" } })), leavePipeline, events, leaveCalls };
}

const job = { kind: "pipeline", ref: "42", stepId: "code", dedupKey: "k:code" };
const task = { ref: "42", name: "t", url: "u", completed: false, assignedToUs: true };

test("preRunGates: an epic returns done, no setRefMeta, one epic_skipped event", async () => {
  const dir = tmpDir();
  const store = createStore(dir);
  const d = deps({ store });
  const result = await preRunGates(d, job, { id: "code" }, { ...task, isEpic: true });
  assert.deepEqual(result, { done: { kind: "pipeline", ref: "42", name: "t", url: "u", code: 0 } });
  assert.equal(store.getRefMeta("42"), undefined, "setRefMeta never ran for an epic");
  assert.deepEqual(d.events.map((e) => e.event), ["epic_skipped"]);
});

test("preRunGates: unrouted holds — advance(hold), setHeld, blocked event, done", async () => {
  const dir = tmpDir();
  const store = createStore(dir);
  /** @type {any[]} */
  const advanced = [];
  const d = deps({
    store,
    adapterOver: { advance: async (ref, stepId, verdict) => advanced.push([ref, stepId, verdict.outcome]) },
    resolveRoute: () => ({ error: "ambiguous", message: "no repo matched" }),
  });
  const result = await preRunGates(d, job, { id: "code" }, task);
  assert.deepEqual(result, { done: { kind: "pipeline", ref: "42", name: "t", url: "u", code: 0 } });
  assert.equal(store.getHeld("42")?.reason, "no repo matched");
  assert.deepEqual(advanced, [["42", "code", "hold"]]);
  assert.deepEqual(d.events.map((e) => e.event), ["blocked"]);
});

test("preRunGates: a manual step drains and leaves the pipeline, done, no agent gates reached", async () => {
  const dir = tmpDir();
  const store = createStore(dir);
  const d = deps({ store });
  const step = { id: "done", manual: true, drainWorktree: false };
  const result = await preRunGates(d, job, step, task);
  assert.deepEqual(result, { done: { kind: "pipeline", ref: "42", name: "t", url: "u", code: 0 } });
  assert.deepEqual(d.leaveCalls, [], "drainWorktree:false never calls leavePipeline");
});

test("preRunGates: an overlap-release reply for a reassigned/completed ref is skipped — done, no store mutation", async () => {
  const dir = tmpDir();
  const store = createStore(dir);
  const d = deps({ store, cfgOver: { overlapGuard: true } });
  const releaseJob = { ...job, dedupKey: "overlap:A" };
  const result = await preRunGates(d, releaseJob, { id: "code", createsWorktree: true }, { ...task, assignedToUs: false });
  assert.deepEqual(result, { done: { kind: "pipeline", ref: "42", name: "t", url: "u", code: 0 } });
  assert.equal(store.getLock("42"), undefined, "no lock taken for a skipped release");
  assert.equal(store.getAttempt("42", "code"), 0, "no attempt bump for a skipped release");
  assert.deepEqual(d.events, [], "no event for the fail-closed assignee skip");
});

test("preRunGates: a manual step with drainWorktree:true drains, clears, leaves the pipeline, done", async () => {
  const dir = tmpDir();
  const store = createStore(dir);
  store.bumpAttempt("42", "done");
  store.setFindings("42", { target: "done", fromStep: "code", text: "x" });
  store.setHeld("42", { stepId: "done", reason: "r", heldAt: new Date().toISOString() });
  const d = deps({ store, resolveRoute: () => ({ repo: { id: "r", path: "/tmp/does-not-exist-864" } }) });
  const step = { id: "done", manual: true, drainWorktree: true };
  const result = await preRunGates(d, job, step, { ...task, completed: true });
  assert.deepEqual(result, { done: { kind: "pipeline", ref: "42", name: "t", url: "u", code: 0 } });
  assert.deepEqual(d.leaveCalls, ["42"], "drainWorktree:true calls leavePipeline");
  assert.equal(store.getAttempt("42", "done"), 0, "attempts cleared");
  assert.equal(store.getFindings("42"), undefined, "findings cleared");
  assert.equal(store.getHeld("42"), undefined, "held cleared");
  assert.deepEqual(d.events.map((e) => e.event), ["pipeline_done", "board_done"]);
});

test("preRunGates: an open blocker rests the ref — done, no store mutation", async () => {
  const dir = tmpDir();
  const store = createStore(dir);
  const d = deps({ store, adapterOver: { openBlockers: async () => ["#1"] } });
  const result = await preRunGates(d, job, { id: "code" }, task);
  assert.deepEqual(result, { done: { kind: "pipeline", ref: "42", name: "t", url: "u", code: 0 } });
  assert.equal(store.getAttempt("42", "code"), 0);
});

test("preRunGates: an overlap lock rests the ref — done, overlap.json, overlap_held, no lock taken", async () => {
  const dir = tmpDir();
  const store = createStore(dir);
  store.setLock("A", { paths: ["src/"], stepId: "code" });
  store.setPredictedPaths("42", ["src/a.js"]);
  const d = deps({ store, cfgOver: { overlapGuard: true } });
  const step = { id: "code", createsWorktree: true };
  const result = await preRunGates(d, job, step, task);
  assert.deepEqual(result, { done: { kind: "pipeline", ref: "42", name: "t", url: "u", code: 0 } });
  assert.equal(store.getLock("42"), undefined, "a held ref takes no lock");
  assert.equal(store.getOverlap("42")?.blockedBy, "A");
  assert.deepEqual(d.events.map((e) => e.event), ["overlap_held"]);
});

test("preRunGates: every gate clears — returns {repo, tookLock:true} when a lock was taken", async () => {
  const dir = tmpDir();
  const store = createStore(dir);
  store.setPredictedPaths("42", ["src/a.js"]);
  const d = deps({ store, cfgOver: { overlapGuard: true } });
  const step = { id: "code", createsWorktree: true };
  const result = await preRunGates(d, job, step, task);
  assert.deepEqual(result, { repo: { id: "r", path: "/repo" }, tookLock: true });
  assert.deepEqual(store.getLock("42")?.paths, ["src/a.js"]);
});

test("preRunGates: every gate clears with overlapGuard off — {repo, tookLock:false}", async () => {
  const dir = tmpDir();
  const store = createStore(dir);
  const d = deps({ store });
  const result = await preRunGates(d, job, { id: "code" }, task);
  assert.deepEqual(result, { repo: { id: "r", path: "/repo" }, tookLock: false });
});
