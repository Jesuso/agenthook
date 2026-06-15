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
