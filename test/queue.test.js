import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
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

test("planRestore keeps ci jobs (stepId \"\", running ref)", () => {
  const c = { kind: "ci", ref: "B", stepId: "", dedupKey: "ci:9:1" };
  const { keep, drop } = planRestore([job("A", "code"), c, job("B", "code")], ["B"], ["code"]);
  assert.deepEqual(keep.map((j) => `${j.kind}:${j.ref}`), ["pipeline:A", "ci:B"]);
  assert.deepEqual(drop.map((j) => j.ref), ["B"]);
});

test("two ci jobs for one ref don't coalesce; a redelivered one does", async () => {
  const run = (j) => new Promise((resolve) => setTimeout(() => resolve(info(j)), 5));
  const q = createQueue(1, run);
  const ci = (k) => ({ kind: "ci", ref: "T1", stepId: "", dedupKey: k });
  assert.equal(q.enqueue(ci("ci:1:1")), true);
  assert.equal(q.enqueue(ci("ci:2:1")), true, "a second workflow's red run still gets handled");
  assert.equal(q.enqueue(ci("ci:1:1")), false);
  assert.equal(q.enqueue(job("T1", "review")), true, "and never blocks the ref's pipeline job");
  await q.onIdle();
});

test("onSettle fires after each job settles with its slot already released; not once closed", async () => {
  /** @type {any[]} */
  const seen = [];
  /** @type {any} */
  let q;
  const run = (j) => new Promise((resolve) => setTimeout(() => resolve(info(j)), 2));
  q = createQueue(1, run, undefined, { onSettle: () => seen.push(q.state()) });
  q.enqueue(job("A"));
  q.enqueue(job("B"));
  await q.onIdle();
  // After A settles B has already started from the wait list; after B nothing is left.
  assert.deepEqual(seen, [{ active: 1, queued: 0 }, { active: 0, queued: 0 }]);
  q.enqueue(job("C"));
  q.close();
  await q.onIdle();
  assert.equal(seen.length, 2, "no settle callback while draining");
});

test("pause blocks the pump but not enqueue/onAdd; resume drains", async () => {
  /** @type {string[]} */
  const started = [];
  /** @type {string[]} */
  const added = [];
  const run = (j) => {
    started.push(j.ref);
    return new Promise((resolve) => setTimeout(() => resolve(info(j)), 2));
  };
  const q = createQueue(2, run, undefined, { onAdd: (j) => added.push(j.ref) });
  q.pause();
  assert.equal(q.enqueue(job("A")), true);
  assert.equal(q.enqueue(job("B")), true);
  assert.equal(q.enqueue(job("A")), false, "coalescing unchanged while paused");
  assert.deepEqual(added, ["A", "B"], "accepted jobs still persist");
  assert.deepEqual(started, [], "nothing starts while paused");
  assert.deepEqual(q.state(), { active: 0, queued: 2 });
  q.resume();
  assert.deepEqual(started, ["A", "B"]);
  await q.onIdle();
});

test("pause lets running jobs finish but starts no queued ones on settle", async () => {
  /** @type {string[]} */
  const started = [];
  const run = (j) => {
    started.push(j.ref);
    return new Promise((resolve) => setTimeout(() => resolve(info(j)), 2));
  };
  const q = createQueue(1, run);
  q.enqueue(job("A"));
  q.enqueue(job("B"));
  q.pause();
  await q.onActiveIdle();
  assert.deepEqual(started, ["A"]);
  assert.deepEqual(q.state(), { active: 0, queued: 1 }, "B left queued");
});

test("onActiveIdle resolves immediately at 0 active even with jobs queued", async () => {
  const q = createQueue(1, (j) => Promise.resolve(info(j)));
  q.pause();
  q.enqueue(job("A"));
  let resolved = false;
  await q.onActiveIdle().then(() => (resolved = true));
  assert.equal(resolved, true);
  assert.deepEqual(q.state(), { active: 0, queued: 1 });
});

test("remove drops waiting jobs only (never the running one), persists, and frees the coalesce key", async () => {
  /** @type {(() => void)[]} */
  const releases = [];
  const run = (j) => new Promise((resolve) => releases.push(() => resolve(info(j))));
  /** @type {string[]} */
  const removed = [];
  const q = createQueue(1, run, undefined, { onRemove: (j) => removed.push(j.ref) });
  q.enqueue(job("A"));
  q.enqueue(job("B"));
  q.enqueue(job("B", "other"));
  assert.deepEqual(q.state(), { active: 1, queued: 2 });
  assert.equal(q.remove("A").length, 0, "A is running — not removable here");
  const dropped = q.remove("B", "other");
  assert.deepEqual(dropped.map((j) => j.stepId), ["other"]);
  assert.deepEqual(q.state(), { active: 1, queued: 1 });
  assert.equal(q.remove("B").length, 1);
  assert.equal(q.enqueue(job("B")), true, "key freed — B can be queued again");
  releases.shift()?.(); // A finishes -> B starts
  await new Promise((r) => setTimeout(r, 5));
  releases.shift()?.();
  await q.onIdle();
  assert.ok(removed.includes("B"));
});

test("setMax raises the cap live and starts waiting jobs; isPaused reflects pause/resume", async () => {
  /** @type {(() => void)[]} */
  const releases = [];
  const run = (j) => new Promise((resolve) => releases.push(() => resolve(info(j))));
  const q = createQueue(1, run);
  q.enqueue(job("A"));
  q.enqueue(job("B"));
  assert.equal(q.max(), 1);
  assert.deepEqual(q.state(), { active: 1, queued: 1 });
  q.setMax(2);
  assert.equal(q.max(), 2);
  assert.deepEqual(q.state(), { active: 2, queued: 0 });
  assert.equal(q.isPaused(), false);
  q.pause();
  assert.equal(q.isPaused(), true);
  q.resume();
  assert.equal(q.isPaused(), false);
  for (const r of releases) r();
  await q.onIdle();
});

test("has / whenFree: true once the (ref,step) leaves the queue; immediate when idle; false on timeout", async () => {
  /** @type {(() => void)[]} */
  const releases = [];
  const run = (j) => new Promise((resolve) => releases.push(() => resolve(info(j))));
  const q = createQueue(1, run);
  const a = job("A");
  assert.equal(q.has(a), false);
  assert.equal(await q.whenFree(a, 1000), true, "nothing in flight -> immediately free");
  q.enqueue(a);
  assert.equal(q.has(a), true);
  assert.equal(q.has(job("A", "other")), false, "a different step is independent");
  assert.equal(await q.whenFree(a, 20), false, "still running -> false after the timeout");
  const waiting = q.whenFree(a, 5000);
  releases.shift()?.();
  assert.equal(await waiting, true, "woken by the run settling");
  assert.equal(q.has(a), false);
  assert.equal(q.enqueue(a), true, "and the key can be enqueued again");
  releases.shift()?.();
  await q.onIdle();
});

/** A queue whose jobs settle only when the test says so. @param {number} max @param {Record<string, number>} caps */
function manual(max, caps) {
  /** @type {Map<string, () => void>} */ const settle = new Map();
  /** @type {string[]} */ const started = [];
  let peak = 0;
  let live = 0;
  const run = (/** @type {any} */ j) =>
    new Promise((resolve) => {
      started.push(`${j.kind === "pipeline" ? "" : `${j.kind}:`}${j.ref}:${j.stepId}`);
      peak = Math.max(peak, ++live);
      settle.set(j.ref, () => {
        live--;
        resolve(info(j));
      });
    });
  const q = createQueue(max, run, undefined, undefined, caps);
  const done = async (/** @type {string} */ ref) => {
    settle.get(ref)?.();
    settle.delete(ref);
    await new Promise((r) => setImmediate(r));
  };
  return { q, started, done, peak: () => peak };
}

test("step cap: 3 triage + 1 code under max 3 / triage cap 1 → 1 triage + code run; next triage starts on settle", async () => {
  const { q, started, done, peak } = manual(3, { triage: 1 });
  for (const r of ["T1", "T2", "T3"]) q.enqueue(job(r, "triage"));
  q.enqueue(job("C1", "code"));
  assert.deepEqual(started, ["T1:triage", "C1:code"]);
  assert.deepEqual(q.state(), { active: 2, queued: 2, capped: 2 }, "two triage wait on their cap with a slot free");
  assert.deepEqual(q.stepState(), { triage: { active: 1, queued: 2 }, code: { active: 1, queued: 0 } });
  await done("T1");
  assert.deepEqual(started, ["T1:triage", "C1:code", "T2:triage"]);
  await done("C1");
  await done("T2");
  await done("T3");
  await q.onIdle();
  assert.deepEqual(started, ["T1:triage", "C1:code", "T2:triage", "T3:triage"]);
  assert.ok(peak() <= 3, "global active never exceeds max");
  assert.deepEqual(q.state(), { active: 0, queued: 0, capped: 0 });
  assert.deepEqual(q.stepState(), {});
});

test("step cap: global max still bounds uncapped work; capped head doesn't block, capped jobs keep FIFO", async () => {
  const { q, started, done, peak } = manual(2, { triage: 1 });
  q.enqueue(job("T1", "triage"));
  q.enqueue(job("T2", "triage")); // capped head of the wait list
  q.enqueue(job("T3", "triage"));
  q.enqueue(job("C1", "code"));
  q.enqueue(job("C2", "code"));
  assert.deepEqual(started, ["T1:triage", "C1:code"], "C1 jumps the capped T2/T3");
  assert.deepEqual(q.state(), { active: 2, queued: 3, capped: 2 });
  await done("C1");
  assert.deepEqual(started.slice(2), ["C2:code"], "slot goes to the runnable job, not the capped head");
  await done("T1");
  assert.deepEqual(started.slice(3), ["T2:triage"], "capped jobs keep their FIFO order");
  await done("C2");
  await done("T2");
  assert.deepEqual(started.slice(4), ["T3:triage"]);
  await done("T3");
  await q.onIdle();
  assert.equal(peak(), 2);
});

test("step cap: merge/ci jobs are never counted against or blocked by a cap", async () => {
  const { q, started, done } = manual(3, { code: 1 });
  q.enqueue(job("C1", "code"));
  q.enqueue({ kind: "merge", ref: "M1", stepId: "code", dedupKey: "merged:1" });
  q.enqueue({ kind: "ci", ref: "X1", stepId: "code", dedupKey: "ci:1:1" });
  assert.deepEqual(started, ["C1:code", "merge:M1:code", "ci:X1:code"]);
  assert.deepEqual(q.state(), { active: 3, queued: 0, capped: 0 });
  assert.deepEqual(q.stepState(), { code: { active: 1, queued: 0 } }, "only the pipeline job counts");
  await done("C1");
  await done("M1");
  await done("X1");
  await q.onIdle();
});

test("no step caps: state() keeps its {active, queued} shape", () => {
  const q = createQueue(1, () => new Promise(() => {}), undefined, undefined, {});
  q.enqueue(job("T1"));
  q.enqueue(job("T2"));
  assert.deepEqual(q.state(), { active: 1, queued: 1 });
});

// --- named harnesses (#619): a slot pool per backend, picked when the job starts ---

/**
 * A queue whose jobs settle (or reject) only when the test says so; `started` records
 * `ref:harness` per start. @param {number} max @param {any} harnessing @param {Record<string, number>} [caps]
 */
function harnessed(max, harnessing, caps = {}) {
  /** @type {Map<string, {ok: () => void, fail: () => void}>} */ const settle = new Map();
  /** @type {string[]} */ const started = [];
  const run = (/** @type {any} */ j) =>
    new Promise((resolve, reject) => {
      started.push(`${j.ref}:${j.harness ?? "-"}`);
      settle.set(j.ref, { ok: () => resolve(info(j)), fail: () => reject(new Error("boom")) });
    });
  const q = createQueue(max, run, undefined, undefined, caps, harnessing);
  /** @param {string} ref @param {"ok"|"fail"} [how] */
  const done = async (ref, how = "ok") => {
    const err = console.error;
    console.error = () => {};
    try {
      settle.get(ref)?.[how]();
      settle.delete(ref);
      await new Promise((r) => setImmediate(r));
    } finally {
      console.error = err;
    }
  };
  return { q, started, done };
}

const CODE_QR = { steps: { code: { harnesses: ["qwen", "deepseek"], routing: "first-free" } }, caps: { qwen: 1, deepseek: 2, opus: 3 } };

test("harness first-free: prefers the first listed harness, spills to the next when it's full", async () => {
  const { q, started, done } = harnessed(4, CODE_QR);
  q.enqueue(job("A", "code"));
  q.enqueue(job("B", "code"));
  q.enqueue(job("C", "code"));
  assert.deepEqual(started, ["A:qwen", "B:deepseek", "C:deepseek"]);
  await done("A");
  q.enqueue(job("D", "code"));
  assert.deepEqual(started.slice(3), ["D:qwen"], "a freed first harness is preferred again");
  for (const r of ["B", "C", "D"]) await done(r);
  await q.onIdle();
});

test("harness round-robin: rotates across the list and skips a full harness", async () => {
  const rr = { steps: { review: { harnesses: ["a", "b", "c"], routing: "round-robin" } }, caps: { a: 1, b: 5, c: 5 } };
  const { q, started, done } = harnessed(10, rr);
  for (const r of ["R1", "R2", "R3"]) q.enqueue(job(r, "review"));
  assert.deepEqual(started, ["R1:a", "R2:b", "R3:c"]);
  q.enqueue(job("R4", "review")); // cursor back at a — full (cap 1), so b
  assert.deepEqual(started.slice(3), ["R4:b"]);
  q.enqueue(job("R5", "review")); // cursor past b → c
  assert.deepEqual(started.slice(4), ["R5:c"]);
  await done("R1");
  q.enqueue(job("R6", "review")); // cursor wrapped to a, which has room again
  assert.deepEqual(started.slice(5), ["R6:a"]);
  for (const r of ["R2", "R3", "R4", "R5", "R6"]) await done(r);
  await q.onIdle();
});

test("harness: all harnesses full → the job waits and counts in capped; an unrelated job behind it still starts", async () => {
  const { q, started, done } = harnessed(5, CODE_QR);
  for (const r of ["A", "B", "C", "D"]) q.enqueue(job(r, "code"));
  q.enqueue(job("T", "triage"));
  assert.deepEqual(started, ["A:qwen", "B:deepseek", "C:deepseek", "T:-"], "D waits on full harnesses; T jumps it");
  assert.deepEqual(q.state(), {
    active: 4,
    queued: 1,
    capped: 1,
    harnesses: { qwen: { active: 1, max: 1 }, deepseek: { active: 2, max: 2 }, opus: { active: 0, max: 3 } },
  });
  await done("B");
  assert.deepEqual(started.slice(4), ["D:deepseek"]);
  for (const r of ["A", "C", "D", "T"]) await done(r);
  await q.onIdle();
  assert.deepEqual(q.state().harnesses, { qwen: { active: 0, max: 1 }, deepseek: { active: 0, max: 2 }, opus: { active: 0, max: 3 } });
});

test("harness: the harness cap nests with the step cap and the global cap — all three need room", async () => {
  // step cap binds: code may run 1 at once though qwen+deepseek have 3 slots
  let h = harnessed(4, CODE_QR, { code: 1 });
  h.q.enqueue(job("A", "code"));
  h.q.enqueue(job("B", "code"));
  assert.deepEqual(h.started, ["A:qwen"]);
  assert.equal(h.q.state().capped, 1);
  await h.done("A");
  assert.deepEqual(h.started.slice(1), ["B:qwen"]);
  await h.done("B");
  // global cap binds: max 2 though the harnesses have 3 slots
  h = harnessed(2, CODE_QR);
  for (const r of ["A", "B", "C"]) h.q.enqueue(job(r, "code"));
  assert.deepEqual(h.started, ["A:qwen", "B:deepseek"]);
  assert.deepEqual({ active: h.q.state().active, capped: h.q.state().capped }, { active: 2, capped: 0 }, "C waits on a global slot, not on a harness");
  await h.done("A");
  assert.deepEqual(h.started.slice(2), ["C:qwen"]);
  for (const r of ["B", "C"]) await h.done(r);
  // harness cap binds: an uncapped step and a big global cap, but qwen alone holds 1
  h = harnessed(9, { steps: { code: { harnesses: ["qwen"] } }, caps: { qwen: 1 } });
  h.q.enqueue(job("A", "code"));
  h.q.enqueue(job("B", "code"));
  assert.deepEqual(h.started, ["A:qwen"]);
  await h.done("A");
  await h.done("B");
  await h.q.onIdle();
});

test("setHarnessMax: a raise starts a waiting job; a lower cap only gates new starts; unknown name throws", async () => {
  const caps = { qwen: 1, deepseek: 1, opus: 3 };
  const { q, started, done } = harnessed(9, { steps: { code: { harnesses: ["qwen"] } }, caps });
  q.enqueue(job("A", "code"));
  q.enqueue(job("B", "code"));
  assert.deepEqual(started, ["A:qwen"]);
  q.setHarnessMax("qwen", 2);
  assert.deepEqual(started, ["A:qwen", "B:qwen"], "the raise pumps the waiting job");
  assert.deepEqual(q.state().harnesses?.qwen, { active: 2, max: 2 });
  assert.equal(q.max(), 9, "the global cap is untouched");
  assert.equal(caps.qwen, 1, "the caller's caps object is not mutated");
  q.setHarnessMax("qwen", 1); // below active: nothing is killed
  assert.deepEqual(q.state().harnesses?.qwen, { active: 2, max: 1 });
  q.enqueue(job("C", "code"));
  assert.equal(started.length, 2, "C waits: qwen is over its new cap");
  assert.throws(() => q.setHarnessMax("nope", 2), /unknown harness "nope"/);
  assert.throws(() => q.setHarnessMax("toString", 2), /unknown harness/, "an inherited key is not a harness");
  await done("A");
  assert.equal(started.length, 2, "one of two freed: still at cap 1");
  await done("B");
  assert.deepEqual(started.slice(2), ["C:qwen"]);
  await done("C");
  await q.onIdle();
  // a queue without harnesses rejects any name
  assert.throws(() => createQueue(1, async () => info(job("x", "code"))).setHarnessMax("qwen", 2), /unknown harness "qwen"/);
});

test("harness: a slot is released on settle, including when the run rejects", async () => {
  const one = { steps: { code: { harnesses: ["qwen"] } }, caps: { qwen: 1 } };
  const { q, started, done } = harnessed(3, one);
  q.enqueue(job("A", "code"));
  q.enqueue(job("B", "code"));
  assert.deepEqual(q.state().harnesses, { qwen: { active: 1, max: 1 } });
  await done("A", "fail");
  assert.deepEqual(started, ["A:qwen", "B:qwen"], "the rejected run freed qwen");
  await done("B");
  await q.onIdle();
  assert.deepEqual(q.state().harnesses, { qwen: { active: 0, max: 1 } });
});

test("harness: a job enqueued with a stale or unknown harness is re-routed at start", async () => {
  const { q, started, done } = harnessed(4, CODE_QR);
  const warn = console.warn;
  /** @type {string[]} */ const warned = [];
  console.warn = (/** @type {string} */ m) => warned.push(m);
  try {
    q.enqueue({ ...job("A", "code"), harness: "gone" });
    q.enqueue({ ...job("B", "code"), harness: "opus" }); // configured, but not on code's list
    q.enqueue({ ...job("T", "triage"), harness: "qwen" }); // triage has no harness at all
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(started, ["A:qwen", "B:deepseek", "T:-"]);
  assert.equal(warned.length, 1);
  assert.match(warned[0], /\[harness\] gone .*unknown, re-routing/);
  assert.equal(q.state().harnesses?.opus.active, 0, "the stale name never took a slot");
  for (const r of ["A", "B", "T"]) await done(r);
  await q.onIdle();
});

test("harness: an uncapped harness reports max null and never blocks", async () => {
  const { q, started, done } = harnessed(3, { steps: { code: { harnesses: ["free"] } }, caps: { free: undefined } });
  for (const r of ["A", "B", "C"]) q.enqueue(job(r, "code"));
  assert.deepEqual(started, ["A:free", "B:free", "C:free"]);
  assert.deepEqual(q.state(), { active: 3, queued: 0, capped: 0, harnesses: { free: { active: 3, max: null } } });
  assert.deepEqual(q.harnessState(), { free: { active: 3, max: null } });
  for (const r of ["A", "B", "C"]) await done(r);
  await q.onIdle();
});

test("harness: merge/ci jobs never take a harness slot", async () => {
  const { q, started, done } = harnessed(3, { steps: { code: { harnesses: ["qwen"] } }, caps: { qwen: 1 } });
  q.enqueue(job("A", "code"));
  q.enqueue({ kind: "merge", ref: "M", stepId: "code", dedupKey: "merged:1" });
  assert.deepEqual(started, ["A:qwen", "M:-"]);
  await done("A");
  await done("M");
  await q.onIdle();
});

test("no harnesses: state() has no `harnesses` and harnessState() is empty", () => {
  const q = createQueue(1, () => new Promise(() => {}));
  q.enqueue(job("T1"));
  assert.deepEqual(q.state(), { active: 1, queued: 0 });
  assert.deepEqual(q.harnessState(), {});
});
