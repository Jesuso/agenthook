// Intake helpers: the pure accept/refuse → event decision and the in-process push sink an
// event source (`adapter.onJobs`) feeds. The `intake()` closure itself lives in index.js.

/**
 * Decide which event (if any) intake() emits for a job given the queue's accept/refuse
 * outcome — pure, unit-testable without touching the queue or disk.
 * @param {boolean} accepted  `queue.enqueue(job)` returned true
 * @param {boolean} wasInflight  `queue.has(job)` was true before the enqueue attempt — refused
 *   because a duplicate (ref+step already queued/running), not because the queue is draining
 * @returns {"enqueued"|"coalesced"|null}
 */
export function intakeEvent(accepted, wasInflight) {
  if (accepted) return "enqueued";
  return wasInflight ? "coalesced" : null;
}

/**
 * The sink an in-process event source (`adapter.onJobs`) pushes into. A push caused by a
 * run's own stage move (local `advance`) lands INSIDE that run, before dispatch's per-ref
 * cleanup (busy/preSpawn sets, leavePipeline, clear*) — starting the next step then would
 * have that cleanup wipe the new run's state. So a job whose ref still has a queued or
 * running job is parked and flushed through `intake` when the ref's last job settles
 * (`whenRefFree`, event-driven); any other job goes straight to `intake`.
 * @param {{hasRef: (ref: string) => boolean, whenRefFree: (ref: string, fn: () => void) => void, intake: (jobs: import('../types.js').Job[]) => unknown}} deps
 * @returns {(jobs: import('../types.js').Job[]) => void}
 */
export function createPushSink({ hasRef, whenRefFree, intake }) {
  /** @type {Map<string, import('../types.js').Job[]>} ref → jobs parked behind its current run */
  const parked = new Map();
  return (jobs) => {
    for (const job of jobs || []) {
      const waiting = parked.get(job.ref);
      if (waiting) {
        waiting.push(job);
        continue;
      }
      if (!hasRef(job.ref)) {
        intake([job]);
        continue;
      }
      parked.set(job.ref, [job]);
      whenRefFree(job.ref, () => {
        const flush = parked.get(job.ref) || [];
        parked.delete(job.ref);
        intake(flush);
      });
    }
  };
}
