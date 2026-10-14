// Bounded-concurrency job queue. Worktree isolation (see INSTRUCTIONS.md) lets
// multiple agents run at once; MAX caps how many.
/**
 * Boot-restore plan for persisted queue entries: which to re-enqueue (in order) and
 * which to drop (ref was mid-run at boot — recovery failed it — or step is gone). A
 * non-pipeline job (`merge`, `ci`) is always kept: the forge event happened regardless,
 * its key is already in `seen` (a redelivery won't re-fire it), and its stepId may be "".
 * @param {import('./types.js').Job[]} queued
 * @param {Iterable<string>} runningRefs
 * @param {Iterable<string>} stepIds
 */
export function planRestore(queued, runningRefs, stepIds) {
  const running = new Set(runningRefs);
  const steps = new Set(stepIds);
  /** @type {import('./types.js').Job[]} */ const keep = [];
  /** @type {import('./types.js').Job[]} */ const drop = [];
  for (const j of queued) {
    const stale = (j.kind ?? "pipeline") === "pipeline" && (running.has(j.ref) || !steps.has(j.stepId));
    (stale ? drop : keep).push(j);
  }
  return { keep, drop };
}

/**
 * @param {number} initialMax
 * @param {(job: import('./types.js').Job) => Promise<{kind:string,ref:string,name:string,url:string,code:number}>} run
 * @param {(state: {active:number, queued:number}) => void} [onChange]  called after every state change (heartbeat)
 * @param {{onAdd?: (job: import('./types.js').Job) => void, onRemove?: (job: import('./types.js').Job) => void, onSettle?: () => void}} [persist]
 *   persistence hooks: onAdd once a job is accepted, onRemove when it leaves the wait list to run,
 *   onSettle after a job settles and its slot is released (the engine's queue-stage pull trigger)
 */
export function createQueue(initialMax, run, onChange, persist) {
  let max = initialMax;
  /** @type {import('./types.js').Job[]} */
  const queue = [];
  // Work-level coalescing: one (ref,stepId) may be queued-or-active at most once.
  // The engine's `seen` set dedups by EVENT key, but a single user action can emit
  // two events with different keys (task `added` -> step:<id>:<gid> AND story
  // `section_changed` -> secmove:<storyGid>) that resolve to the same step — both
  // clear `seen` and would spawn two `claude -p` on the same task/step. This drops
  // the second; a later legit re-entry (next step, or a `changes` rework) carries a
  // different stepId, or arrives after this key is cleared on completion. A `merge`
  // job is keyed apart from pipeline jobs: it moves the task into its completeOnMerge
  // step, and that step's own pipeline job must not be coalesced away behind it. A `ci`
  // job is keyed by its run+attempt: two red workflows on one ref each get handled.
  const inflight = new Set();
  /** @param {import('./types.js').Job} job */
  const workKey = (job) =>
    job.kind === "ci" ? job.dedupKey : `${job.kind === "pipeline" ? "" : `${job.kind}:`}${job.ref}:${job.stepId ?? job.dedupKey}`;
  /** @type {Map<string, (() => void)[]>} work key -> waiters for that key to leave the queue/finish */
  const freeWaiters = new Map();
  let active = 0;
  let closed = false; // drain: refuse new work, let in-flight + queued finish
  let paused = false; // restart pending: accept + persist new work, but start nothing
  /** @type {(() => void)[]} */
  let idleWaiters = [];
  /** @type {(() => void)[]} */
  let activeIdleWaiters = [];
  const report = () => onChange?.({ active, queued: queue.length });
  const resolveIdle = () => {
    if (active === 0 && queue.length === 0 && idleWaiters.length) {
      const waiters = idleWaiters;
      idleWaiters = [];
      for (const w of waiters) w();
    }
  };
  const resolveActiveIdle = () => {
    if (active === 0 && activeIdleWaiters.length) {
      const waiters = activeIdleWaiters;
      activeIdleWaiters = [];
      for (const w of waiters) w();
    }
  };

  function pump() {
    while (!paused && active < max && queue.length) {
      const job = queue.shift();
      if (!job) break;
      persist?.onRemove?.(job);
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
          for (const w of freeWaiters.get(workKey(job)) ?? []) w();
          freeWaiters.delete(workKey(job));
          report();
          pump();
          resolveIdle();
          resolveActiveIdle();
          if (!closed) persist?.onSettle?.();
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
      persist?.onAdd?.(job);
      report();
      pump();
      return true;
    },
    /** Stop accepting new jobs (in-flight + already-queued still run to completion). */
    close() {
      closed = true;
    },
    /** Stop starting jobs; enqueue still accepts + persists (onAdd). Running jobs finish. */
    pause() {
      paused = true;
    },
    /** Start pumping again (drains whatever queued up while paused). */
    resume() {
      paused = false;
      pump();
    },
    /** True while `job`'s (ref, step) is queued or running — an enqueue of it would be coalesced away. @param {import('./types.js').Job} job */
    has: (job) => inflight.has(workKey(job)),
    /** True once `close()` has been called — a refused enqueue past this point is draining, not a coalesced duplicate. */
    isClosed: () => closed,
    /**
     * Resolve true once `job`'s (ref, step) is no longer queued/running (immediately if it is not),
     * false after `timeoutMs`. Event-driven: woken by the run settling, no polling. For a caller that
     * must enqueue right after an event announcing the previous run's verdict, which lands a few
     * hundred ms before the run's own cleanup (label move) finishes.
     * @param {import('./types.js').Job} job @param {number} timeoutMs @returns {Promise<boolean>}
     */
    whenFree(job, timeoutMs) {
      const key = workKey(job);
      if (!inflight.has(key)) return Promise.resolve(true);
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          const rest = (freeWaiters.get(key) ?? []).filter((w) => w !== wake);
          if (rest.length) freeWaiters.set(key, rest);
          else freeWaiters.delete(key);
          resolve(false);
        }, timeoutMs);
        const wake = () => {
          clearTimeout(timer);
          resolve(true);
        };
        freeWaiters.set(key, [...(freeWaiters.get(key) ?? []), wake]);
      });
    },
    /** {active, queued} snapshot. */
    state: () => ({ active, queued: queue.length }),
    /** Whether new runs are held back (restart/decommission/operator pause). */
    isPaused: () => paused,
    /** Current concurrency cap. */
    max: () => max,
    /** Change the concurrency cap at runtime (not persisted to config); a raise starts waiting jobs now. @param {number} n */
    setMax(n) {
      max = n;
      report();
      pump();
    },
    /**
     * Drop WAITING jobs for `ref` (optionally only `stepId`) — never a running one. Fires
     * `onRemove` per job so queue.json follows. Returns the dropped jobs.
     * @param {string} ref @param {string} [stepId]
     */
    remove(ref, stepId) {
      /** @type {import('./types.js').Job[]} */
      const dropped = [];
      for (let i = queue.length - 1; i >= 0; i--) {
        const j = queue[i];
        if (j.ref !== ref || (stepId && j.stepId !== stepId)) continue;
        queue.splice(i, 1);
        inflight.delete(workKey(j));
        persist?.onRemove?.(j);
        dropped.unshift(j);
      }
      if (dropped.length) {
        report();
        resolveIdle();
      }
      return dropped;
    },
    /** Resolves once nothing is running and the queue is empty. Immediate if idle now. */
    onIdle() {
      if (active === 0 && queue.length === 0) return Promise.resolve();
      return /** @type {Promise<void>} */ (
        new Promise((resolve) => idleWaiters.push(() => resolve(undefined)))
      );
    },
    /** Resolves once nothing is running, ignoring queued jobs (a paused queue's wait). Immediate if 0 now. */
    onActiveIdle() {
      if (active === 0) return Promise.resolve();
      return /** @type {Promise<void>} */ (
        new Promise((resolve) => activeIdleWaiters.push(() => resolve(undefined)))
      );
    },
  };
}
