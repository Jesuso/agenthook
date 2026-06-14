// Bounded-concurrency job queue. Worktree isolation (see INSTRUCTIONS.md) lets
// multiple agents run at once; MAX caps how many.
/**
 * @param {number} max
 * @param {(job: import('./types.js').Job) => Promise<{kind:string,ref:string,name:string,url:string,code:number}>} run
 */
export function createQueue(max, run) {
  /** @type {import('./types.js').Job[]} */
  const queue = [];
  let active = 0;

  function pump() {
    while (active < max && queue.length) {
      const job = queue.shift();
      if (!job) break;
      active++;
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
          pump();
        });
    }
  }

  return {
    /** @param {import('./types.js').Job} job */
    enqueue(job) {
      queue.push(job);
      pump();
    },
  };
}
