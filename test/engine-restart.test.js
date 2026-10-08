import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRestartRequester } from "../src/engine.js";
import { createQueue } from "../src/queue.js";

const info = (j) => ({ kind: j.kind, ref: j.ref, name: j.ref, url: "", code: 0 });
const job = (ref) => ({ kind: "pipeline", ref, stepId: "s", dedupKey: `${ref}:s` });

/** Requester over a real queue; `release()` settles the one running job. */
function harness({ draining = false, badConfig = false } = {}) {
  /** @type {(() => void)[]} */
  const releases = [];
  const run = (j) => new Promise((resolve) => releases.push(() => resolve(info(j))));
  const queue = createQueue(1, run);
  const h = {
    queue,
    draining,
    pendingCalls: /** @type {any[]} */ ([]),
    fired: 0,
    release: () => releases.shift()?.(),
  };
  h.r = createRestartRequester({
    queue,
    isDraining: () => h.draining,
    validateConfig: () => {
      if (badConfig) throw new Error("bad config");
    },
    onPending: (s) => h.pendingCalls.push(s),
    fire: () => {
      h.fired++;
    },
  });
  return h;
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("restart: rejects any when other than 'idle', changing nothing", async () => {
  const h = harness();
  for (const args of [undefined, {}, { when: "now" }, { when: "IDLE" }]) {
    await assert.rejects(h.r.request(args));
  }
  assert.equal(h.r.isPending(), false);
  assert.deepEqual(h.pendingCalls, []);
});

test("restart: an invalid config on disk rejects, queue not paused", async () => {
  const h = harness({ badConfig: true });
  await assert.rejects(h.r.request({ when: "idle" }), /bad config/);
  assert.equal(h.r.isPending(), false);
  h.queue.enqueue(job("A"));
  assert.equal(h.queue.state().active, 1, "queue still pumps");
});

test("restart: rejected while a signal shutdown is draining", async () => {
  const h = harness({ draining: true });
  await assert.rejects(h.r.request({ when: "idle" }));
  assert.equal(h.r.isPending(), false);
});

test("restart: accepts immediately, pauses, fires only at 0 active; second call is alreadyPending", async () => {
  const h = harness();
  h.queue.enqueue(job("A")); // running
  const res = await h.r.request({ when: "idle" });
  assert.deepEqual(res, { accepted: true, active: 1, queued: 0 });
  assert.deepEqual(h.pendingCalls, [{ active: 1, queued: 0 }]);
  assert.equal(h.queue.enqueue(job("B")), true, "incoming jobs still enqueue");
  assert.deepEqual(h.queue.state(), { active: 1, queued: 1 }, "but don't start");
  assert.deepEqual(await h.r.request({ when: "idle" }), { accepted: true, alreadyPending: true, active: 1, queued: 1 });
  await tick();
  assert.equal(h.fired, 0, "not while an agent runs");
  h.release();
  await tick();
  await tick();
  assert.equal(h.fired, 1);
  assert.deepEqual(h.queue.state(), { active: 0, queued: 1 }, "B left queued for the successor");
  assert.equal(h.pendingCalls.length, 1);
});

test("restart: fires right away when nothing is running", async () => {
  const h = harness();
  await h.r.request({ when: "idle" });
  await tick();
  await tick();
  assert.equal(h.fired, 1);
});

test("restart: a signal shutdown before 0 active cancels the fire", async () => {
  const h = harness();
  h.queue.enqueue(job("A"));
  await h.r.request({ when: "idle" });
  h.draining = true; // SIGTERM arrived
  h.release();
  await tick();
  await tick();
  assert.equal(h.fired, 0);
});
