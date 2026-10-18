// Crash bookkeeping and LOCAL recovery: the fatal-crash record, crash recovery from
// running.json (never a board poll), the overlapGuard releaser and the `step:` dedup release.
import { isStateDedupKey } from "../store.js";
import { reportMoveFailure } from "../events.js";

/**
 * Pure record builder for a fatal crash — unit-testable without touching disk/process.
 * @param {string} kind  "uncaughtException" | "unhandledRejection"
 * @param {unknown} err
 * @param {string[]} runningRefs  refs mid-step at the moment of the crash (store.listRunning() keys)
 */
export function crashRecord(kind, err, runningRefs) {
  const e = err instanceof Error ? err : new Error(String(err));
  return {
    at: new Date().toISOString(),
    pid: process.pid,
    kind,
    message: e.message,
    stack: e.stack,
    running: runningRefs,
  };
}

/**
 * Wrap a job runner so a `step:` dedup key is released when the job settles
 * (resolve or reject). Other keys stay in `seen`.
 * @param {(job: import('../types.js').Job) => Promise<any>} run
 * @param {{reloadSeen: () => void, unmarkSeen: (key: string) => void}} store
 */
export function releaseOnSettle(run, store) {
  return async (/** @type {import('../types.js').Job} */ job) => {
    try {
      return await run(job);
    } finally {
      if (isStateDedupKey(job.dedupKey)) {
        store.reloadSeen(); // seen is edited out-of-band (catchup)
        store.unmarkSeen(job.dedupKey);
      }
    }
  };
}

/**
 * The overlapGuard release (see src/overlap.js): `blocker` left the pipeline, so clear
 * its lock and re-intake every ref waiting on it. The dedup key is `overlap:<blocker>:<ref>`;
 * intake is forced because the overlap.json entry — cleared just before — is the one-shot
 * guard (the same pair can wait again after a later lock). A released job re-runs the gate
 * and may be re-held behind a different lock.
 * @param {import('../types.js').Store} store
 * @param {(jobs: import('../types.js').Job[], opts?: {force?: boolean}) => void} intake
 * @param {(event: string, ref: string, step: string, extra?: Record<string, any>) => void} [emit]
 * @returns {(blocker: string) => void}
 */
export function createOverlapReleaser(store, intake, emit) {
  return (blocker) => {
    store.clearLock(blocker);
    const waiting = store.listOverlap();
    for (const ref of Object.keys(waiting)) {
      const { stepId, blockedBy } = waiting[ref];
      if (blockedBy !== blocker) continue;
      store.clearOverlap(ref);
      console.log(`[overlap] ${blocker} released — re-offering ${ref} to step ${stepId}`);
      emit?.("overlap_released", ref, stepId, { blockedBy: blocker });
      intake([{ kind: "pipeline", ref, stepId, dedupKey: `overlap:${blocker}:${ref}` }], { force: true });
    }
  };
}

/**
 * Crash recovery from LOCAL state only — never a board poll. A restart orphans any
 * in-flight `claude -p` (queued-but-unstarted jobs survive in queue.json, see
 * restoreQueued); running.json is the record of what was mid-step. We resolve each as
 * a failed run (implement isn't idempotent, so re-running blind is unsafe) → the
 * adapter moves it to its failure lane for a human. Catching tasks that *arrived*
 * during downtime is the explicit `reconcile` command's job, not boot's.
 * @param {import('../types.js').Store} store
 * @param {import('../types.js').Adapter} adapter
 * @param {(event: string, ref: string, step: string, extra?: Record<string, any>) => void} emit
 * @param {(blocker: string) => void} [releaseOverlap]  overlapGuard: a fail frees the ref's lock
 */
export async function recoverInterrupted(store, adapter, emit, releaseOverlap) {
  const running = store.listRunning();
  const refs = Object.keys(running);
  if (!refs.length) return;
  console.log(`[recover] ${refs.length} step(s) interrupted by restart — moving to failure lane`);
  for (const ref of refs) {
    const { stepId } = running[ref];
    emit("failed", ref, stepId, { reason: "interrupted by restart" });
    try {
      await adapter.advance?.(ref, stepId, { outcome: "fail", reason: "interrupted by restart" });
    } catch (e) {
      console.error(`[recover] advance ${ref} (${stepId}) failed:`, e.message);
      reportMoveFailure(emit, ref, stepId, "fail", e);
    }
    store.clearRunning(ref);
    store.clearAttempts(ref);
    store.unmarkSeen(`step:${stepId}:${ref}`);
    if (releaseOverlap) {
      store.clearPredictedPaths(ref);
      releaseOverlap(ref);
    }
  }
}
