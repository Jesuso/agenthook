// Bounded-concurrency job queue. Worktree isolation (see INSTRUCTIONS.md) lets
// multiple agents run at once; MAX caps how many.
/**
 * @param {number} max
 * @param {(job: import('./types.js').Job) => Promise<{kind:string,ref:string,name:string,url:string,code:number}>} run
 * @param {(state: {active:number, queued:number}) => void} [onChange]  called after every state change (heartbeat)
 */
export function createQueue(max, run, onChange) {
  /** @type {import('./types.js').Job[]} */
  const queue = [];
  // Work-level coalescing: one (ref,stepId) may be queued-or-active at most once.
  // The engine's `seen` set dedups by EVENT key, but a single user action can emit
  // two events with different keys (task `added` -> step:<id>:<gid> AND story
  // `section_changed` -> secmove:<storyGid>) that resolve to the same step — both
  // clear `seen` and would spawn two `claude -p` on the same task/step. This drops
  // the second; a later legit re-entry (next step, or a `changes` rework) carries a
  // different stepId, or arrives after this key is cleared on completion.
  const inflight = new Set();
  /** @param {import('./types.js').Job} job */
  const workKey = (job) => `${job.ref}:${job.stepId ?? job.dedupKey}`;
  let active = 0;
  let closed = false; // drain: refuse new work, let in-flight + queued finish
  /** @type {(() => void)[]} */
  let idleWaiters = [];
  const report = () => onChange?.({ active, queued: queue.length });
  const resolveIdle = () => {
    if (active === 0 && queue.length === 0 && idleWaiters.length) {
      const waiters = idleWaiters;
      idleWaiters = [];
      for (const w of waiters) w();
    }
  };

  function pump() {
    while (active < max && queue.length) {
      const job = queue.shift();
      if (!job) break;
      active++;
      report();
      console.log(`[start] ${job.kind} ${job.ref} (running ${active}/${max}, ${queue.length} queued)`);
      run(job)
        .then((info) => {
          const left = active - 1 + queue.length;
          console.log(
            `[done] ${info.kind} "${info.name}" exited ${info.code} — ` +
              `${active - 1} running, ${queue.length} queued (${left} left)\n        review: ${info.url}`,
          );
          if (left === 0) console.log(`[idle] all agents done, queue empty`);
        })
        .catch((e) => {
          const left = active - 1 + queue.length;
          console.error(`[done] ${job.kind} ${job.ref} FAILED: ${e.message} — ${left} left`);
        })
        .finally(() => {
          active--;
          inflight.delete(workKey(job));
          report();
          pump();
          resolveIdle();
        });
    }
  }

  return {
    /** @param {import('./types.js').Job} job @returns {boolean} accepted */
    enqueue(job) {
      if (closed) {
        console.warn(`[drain] refusing ${job.kind} ${job.ref} — shutting down`);
        return false;
      }
      const key = workKey(job);
      if (inflight.has(key)) {
        console.warn(`[coalesce] ${job.kind} ${job.ref} step ${job.stepId} already queued/running — dropping duplicate`);
        return false;
      }
      inflight.add(key);
      queue.push(job);
      report();
      pump();
      return true;
    },
    /** Stop accepting new jobs (in-flight + already-queued still run to completion). */
    close() {
      closed = true;
    },
    /** {active, queued} snapshot. */
    state: () => ({ active, queued: queue.length }),
    /** Resolves once nothing is running and the queue is empty. Immediate if idle now. */
    onIdle() {
      if (active === 0 && queue.length === 0) return Promise.resolve();
      return /** @type {Promise<void>} */ (
        new Promise((resolve) => idleWaiters.push(() => resolve(undefined)))
      );
    },
  };
}
