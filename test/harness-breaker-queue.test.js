import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// Queue-level check for the breaker's deadline timer (#887): a job queued only for a tripped
// harness must start on its own once the cooldown ends — no other event (enqueue, settle on
// another harness, reload) should be required. test/queue.test.js already covers the lazy-read
// breaker behavior; this file stays separate so it doesn't grow past the ~25 KB guideline.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createQueue } from "../src/queue.js";

/** @param {any} job */
const info = (job) => ({ kind: job.kind, ref: job.ref, name: job.ref, url: "", code: 0 });
const job = (ref, stepId = "code") => ({ kind: "pipeline", ref, stepId, dedupKey: `${ref}:${stepId}` });
const MIN = 60000;

/** A fake clock + one-shot timers fired by hand (same style as test/harness-breaker.test.js). */
function clock() {
  let t = Date.parse("2026-11-08T12:00:00Z");
  /** @type {Map<number, {fn: () => void, at: number}>} */
  const timers = new Map();
  let id = 0;
  return {
    now: () => t,
    setTimer: (/** @type {() => void} */ fn, /** @type {number} */ ms) => (timers.set(++id, { fn, at: t + ms }), id),
    clearTimer: (/** @type {number} */ i) => void timers.delete(i),
    /** Advance to `to`, firing due timers (and any newly armed by an earlier one). @param {number} to */
    advance(to) {
      t = to;
      for (const [i, x] of [...timers]) if (x.at <= t) (timers.delete(i), x.fn());
    },
  };
}

test("breaker: the only harness of a step trips while a job is queued for it; once the cooldown ends, the deadline timer alone starts it", async () => {
  const c = clock();
  /** @type {string[]} */ const started = [];
  /** @type {Map<string, (h?: any) => void>} */ const settle = new Map();
  const run = (/** @type {any} */ j) =>
    new Promise((resolve) => {
      started.push(`${j.ref}:${j.harness}`);
      settle.set(j.ref, (h) => resolve({ ...info(j), ...(h ? { health: h } : {}) }));
    });
  const q = createQueue(4, run, undefined, undefined, {}, {
    steps: { code: { harnesses: ["local"] } },
    caps: { local: 1 },
    cooldowns: { local: 10 },
    now: c.now,
    setTimer: c.setTimer,
    clearTimer: c.clearTimer,
  });
  q.enqueue(job("A"));
  const w = console.warn;
  console.warn = () => {};
  try {
    settle.get("A")?.({ harness: "local", reason: "worker unreachable: host (timeout)", requeue: false });
    await new Promise((r) => setImmediate(r));
  } finally {
    console.warn = w;
  }
  assert.equal(q.harnessState().local.state, "down");
  q.enqueue(job("B")); // queued only for the tripped harness
  assert.deepEqual(started, ["A:local"], "B never started while local is down");
  assert.equal(q.state().queued, 1);

  const until = Date.parse(/** @type {string} */ (q.harnessState().local.until));
  c.advance(until); // no enqueue, no settle on another harness, no reload — just the clock passing
  assert.equal(q.harnessState().local.state, "probing");
  assert.deepEqual(started, ["A:local", "B:local"], "the deadline timer's wake alone started B's run");
});
