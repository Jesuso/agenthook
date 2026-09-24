// Queue-stage pull — pure-unit coverage of the slot math, the pull planner, and the
// single-flight puller (injected deps; no network, no engine).
import { test } from "node:test";
import assert from "node:assert/strict";
import { freeSlots, planPull, createPuller, PULL_TTL_MS } from "../src/pull.js";

test("freeSlots: full → 0, pending counted, never negative", () => {
  assert.equal(freeSlots({ max: 2, active: 2, queued: 0, pending: 0 }), 0);
  assert.equal(freeSlots({ max: 3, active: 1, queued: 0, pending: 1 }), 1);
  assert.equal(freeSlots({ max: 1, active: 1, queued: 3, pending: 2 }), 0);
});

test("planPull: no free slots → no picks", () => {
  assert.deepEqual(planPull({ free: 0, pending: [], inflightRefs: [], candidates: [{ stepId: "code", refs: ["1", "2"] }] }), []);
});

test("planPull: board order preserved, capped at free", () => {
  const picks = planPull({ free: 2, pending: [], inflightRefs: [], candidates: [{ stepId: "code", refs: ["7", "3", "9"] }] });
  assert.deepEqual(picks, [
    { ref: "7", stepId: "code", rank: 0 },
    { ref: "3", stepId: "code", rank: 1 },
  ]);
});

test("planPull: pending and in-flight refs are skipped (rank keeps board position)", () => {
  const picks = planPull({ free: 2, pending: ["7"], inflightRefs: ["3"], candidates: [{ stepId: "code", refs: ["7", "3", "9", "4"] }] });
  assert.deepEqual(picks, [
    { ref: "9", stepId: "code", rank: 2 },
    { ref: "4", stepId: "code", rank: 3 },
  ]);
});

test("planPull: multiple queue steps drain in pipeline order; a ref is picked once", () => {
  const picks = planPull({
    free: 3,
    pending: [],
    inflightRefs: [],
    candidates: [
      { stepId: "triage", refs: ["1", "2"] },
      { stepId: "code", refs: ["2", "5", "6"] },
    ],
  });
  assert.deepEqual(picks, [
    { ref: "1", stepId: "triage", rank: 0 },
    { ref: "2", stepId: "triage", rank: 1 },
    { ref: "5", stepId: "code", rank: 1 },
  ]);
});

/** A puller over fakes. @param {any} [o] */
function harness(o = {}) {
  const state = { active: 0, queued: 0, ...o.state };
  /** @type {string[]} */ const entered = [];
  /** @type {any[]} */ const events = [];
  let lists = 0;
  let clock = 0;
  const board = o.board || { code: ["10", "11", "12"] };
  const p = createPuller({
    steps: o.steps || [{ id: "code", queueLabel: "queue:code", sourceLabel: "agent:code" }],
    max: o.max ?? 2,
    queueState: () => state,
    inflightRefs: () => o.inflight || [],
    listQueued: async (stepId) => {
      lists++;
      await new Promise((r) => setImmediate(r));
      if (o.listThrows) throw new Error("boom");
      return board[stepId] || [];
    },
    enterStage: async (ref, stepId, opts) => {
      if (o.enterThrows?.includes(ref)) throw new Error("nope");
      entered.push(`${ref}:${stepId}:assign=${opts.assign}`);
    },
    stageOf: (s) => s.queueLabel,
    isDraining: () => !!o.draining,
    emit: (event, ref, step, extra) => events.push({ event, ref, step, ...extra }),
    now: () => clock,
  });
  return { p, state, entered, events, lists: () => lists, tick: (/** @type {number} */ ms) => (clock += ms) };
}

test("puller: no queue steps → never lists", async () => {
  const h = harness({ steps: [] });
  await h.p.pull();
  assert.equal(h.lists(), 0);
});

test("puller: full → no list, no pull", async () => {
  const h = harness({ state: { active: 2 } });
  await h.p.pull();
  assert.equal(h.lists(), 0);
  assert.deepEqual(h.entered, []);
});

test("puller: pulls top items into free slots with assign:false and emits pulled", async () => {
  const h = harness();
  await h.p.pull();
  assert.deepEqual(h.entered, ["10:code:assign=false", "11:code:assign=false"]);
  assert.deepEqual(h.events[0], { event: "pulled", ref: "10", step: "code", from: "queue:code", rank: 0 });
  assert.deepEqual(h.p.pending(), ["10", "11"]);
});

test("puller: pending holds the slot until the job arrives (no over-pull)", async () => {
  const h = harness({ max: 1 });
  await h.p.pull();
  await h.p.pull(); // webhook not yet landed: pending counts, nothing more pulled
  assert.deepEqual(h.entered, ["10:code:assign=false"]);
  h.p.arrived("10");
  h.state.queued = 1; // the arrived job now occupies the slot
  await h.p.pull();
  assert.deepEqual(h.entered, ["10:code:assign=false"]);
});

test("puller: a pending ref expires after the TTL (lost webhook can't hold a slot forever)", async () => {
  const h = harness({ max: 1, board: { code: ["10", "11"] } });
  await h.p.pull();
  h.tick(PULL_TTL_MS + 1);
  await h.p.pull();
  // 10 is still listed (its move's webhook was lost); it's skipped only while pending,
  // so after expiry the top item is retried.
  assert.deepEqual(h.entered, ["10:code:assign=false", "10:code:assign=false"]);
});

test("puller: concurrent triggers are single-flight (no double pull)", async () => {
  const h = harness({ max: 3 });
  await Promise.all([h.p.pull(), h.p.pull(), h.p.pull()]);
  assert.deepEqual(h.entered, ["10:code:assign=false", "11:code:assign=false", "12:code:assign=false"]);
  // The two overlapping triggers collapse into ONE follow-up pass, which sees every slot
  // held by `pending` and returns before listing again.
  assert.equal(h.lists(), 1);
});

test("puller: skips refs already in flight", async () => {
  const h = harness({ inflight: ["10"] });
  await h.p.pull();
  assert.deepEqual(h.entered, ["11:code:assign=false", "12:code:assign=false"]);
});

test("puller: draining → no pull", async () => {
  const h = harness({ draining: true });
  await h.p.pull();
  assert.equal(h.lists(), 0);
});

test("puller: listQueued/enterStage failures are logged and skipped (best-effort)", async () => {
  const h1 = harness({ listThrows: true });
  await h1.p.pull();
  assert.deepEqual(h1.entered, []);
  const h2 = harness({ enterThrows: ["10"] });
  await h2.p.pull();
  assert.deepEqual(h2.entered, ["11:code:assign=false"]);
  assert.deepEqual(h2.p.pending(), ["11"], "a failed move frees its pending slot");
});
