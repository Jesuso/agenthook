// `board_done` (via "flag"): the tracker delivered the board's own done flag flipping on a
// ticket of ours (a GitHub issue closed, an Asana task completed, a Jira issue moved to a
// done-category status, a Linear issue to a completed/canceled state). Signal only — no agent
// runs, no board write, the pipeline does not move. Handled outside the run queue like
// `epic_changed` (src/epic-changed.js): dedup on `seen`, emit. The terminal-stage half of
// done (via "stage") is emitted by dispatch on entry to a manual step (src/dispatch/step.js).

/**
 * @param {{
 *   store: import('./types.js').Store,
 *   emit?: (event: string, ref: string, step: string, extra?: Record<string, any>) => void,
 * }} deps
 * @returns {(job: import('./types.js').Job) => boolean}  true when `board_done` was emitted
 */
export function createBoardDone({ store, emit }) {
  return function boardDone(job) {
    store.reloadSeen();
    if (store.hasSeen(job.dedupKey)) return false;
    store.markSeen(job.dedupKey);
    emit?.("board_done", job.ref, "", { via: "flag" });
    return true;
  };
}
