import { test } from "node:test";
import assert from "node:assert/strict";
import { createQueue, planRestore } from "../src/queue.js";

/** @param {any} job */
const info = (job) => ({ kind: job.kind, ref: job.ref, name: job.ref, url: "", code: 0 });
/** @param {any} job @param {number} ms */
const job = (ref, stepId = "s") => ({ kind: "pipeline", ref, stepId, dedupKey: `${ref}:${stepId}` });

test("never exceeds max concurrency and still runs every job", async () => {
  let active = 0;
  let peak = 0;
  let completed = 0;
  const run = (j) =>
    new Promise((resolve) => {
      active++;
      peak = Math.max(peak, active);
      setTimeout(() => {
        active--;
        completed++;
        resolve(info(j));
      }, 5);
    });
  const q = createQueue(2, run);
  for (let i = 0; i < 6; i++) assert.equal(q.enqueue(job(`T${i}`)), true);
  assert.deepEqual(q.state(), { active: 2, queued: 4 }, "only max start immediately");
  await q.onIdle();
  assert.equal(peak, 2, "concurrency cap held");
  assert.equal(completed, 6, "all jobs ran");
});

test("coalesces a duplicate (ref,stepId) already queued/running; a different step is allowed", async () => {
  let runs = 0;
  const run = (j) =>
    new Promise((resolve) => {
      runs++;
      setTimeout(() => resolve(info(j)), 5);
    });
  const q = createQueue(1, run);
  assert.equal(q.enqueue(job("T1", "code")), true);
  assert.equal(q.enqueue(job("T1", "code")), false, "same ref+step in flight → dropped");
  assert.equal(q.enqueue(job("T1", "review")), true, "different step → accepted");
  await q.onIdle();
  assert.equal(runs, 2);
});

test("close() refuses new jobs", () => {
  const q = createQueue(1, () => new Promise(() => {}));
  q.close();
  assert.equal(q.enqueue(job("T1")), false);
});

test("onIdle resolves immediately when nothing is running", async () => {
  const q = createQueue(1, () => Promise.resolve(info({ kind: "x", ref: "r" })));
  await q.onIdle();
});

test("persist hooks: onAdd on accept, onRemove on start; not for coalesced/closed", async () => {
  const adds = [];
  const removes = [];
  const q = createQueue(1, (j) => new Promise((r) => setTimeout(() => r(info(j)), 5)), undefined, {
    onAdd: (j) => adds.push(j.ref),
    onRemove: (j) => removes.push(j.ref),
  });
  q.enqueue(job("A"));
  q.enqueue(job("B"));
  q.enqueue(job("C"));
  assert.equal(q.enqueue(job("B")), false, "coalesced");
  assert.deepEqual(adds, ["A", "B", "C"]);
  assert.deepEqual(removes, ["A"], "only A started so far");
  q.close();
  assert.equal(q.enqueue(job("D")), false);
  assert.deepEqual(adds, ["A", "B", "C"]);
  await q.onIdle();
  assert.deepEqual(removes, ["A", "B", "C"]);
});

test("planRestore keeps order, drops running refs and unknown steps", () => {
  const jobs = [job("A", "code"), job("B", "code"), job("C", "gone"), job("D", "review")];
  const { keep, drop } = planRestore(jobs, ["B"], ["code", "review"]);
  assert.deepEqual(keep.map((j) => j.ref), ["A", "D"]);
  assert.deepEqual(drop.map((j) => j.ref), ["B", "C"]);
});

test("planRestore keeps merge jobs (stepId \"\", running ref) in order", () => {
  const m = (ref, stepId) => ({ kind: "merge", ref, stepId, dedupKey: `merged:${ref}` });
  const jobs = [job("A", "code"), m("B", ""), m("C", "done"), job("D", "gone")];
  const { keep, drop } = planRestore(jobs, ["C"], ["code", "done"]);
  assert.deepEqual(keep.map((j) => `${j.kind}:${j.ref}`), ["pipeline:A", "merge:B", "merge:C"]);
  assert.deepEqual(drop.map((j) => j.ref), ["D"]);
});

test("a merge job does not coalesce the same ref's pipeline job for its completeOnMerge step", async () => {
  const run = (j) => new Promise((resolve) => setTimeout(() => resolve(info(j)), 5));
  const q = createQueue(1, run);
  assert.equal(q.enqueue({ kind: "merge", ref: "T1", stepId: "done", dedupKey: "merged:1" }), true);
  assert.equal(q.enqueue(job("T1", "done")), true, "the done step fired by the merge move still runs");
  assert.equal(q.enqueue({ kind: "merge", ref: "T1", stepId: "done", dedupKey: "merged:2" }), false, "a second merge for the same ref coalesces");
  await q.onIdle();
});
