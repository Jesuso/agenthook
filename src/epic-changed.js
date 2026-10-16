// `epic_changed`: the tracker delivered an epic-structure change (GitHub: a sub-issue added or
// removed, an issue typed/untyped Epic). Signal only — no agent runs, no board write, the
// pipeline does not move. Handled outside the run queue like `ci_green` (src/ci-green.js): dedup
// on `seen`, drop the receiver's cached epics read so the next `epics` call refetches, emit.

/**
 * @param {{
 *   store: import('./types.js').Store,
 *   emit?: (event: string, ref: string, step: string, extra?: Record<string, any>) => void,
 *   invalidate?: () => void,
 * }} deps  invalidate: drops the cached epics read (ops' `onEpicChanged` reset)
 * @returns {(job: import('./types.js').Job) => boolean}  true when `epic_changed` was emitted
 */
export function createEpicChanged({ store, emit, invalidate }) {
  return function epicChanged(job) {
    store.reloadSeen();
    if (store.hasSeen(job.dedupKey)) return false;
    store.markSeen(job.dedupKey);
    invalidate?.();
    emit?.("epic_changed", job.ref, "");
    return true;
  };
}
