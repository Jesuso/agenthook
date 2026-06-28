import { test } from "node:test";
import assert from "node:assert/strict";
import { createQueue } from "../src/queue.js";

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
