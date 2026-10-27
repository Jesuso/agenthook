// `board_done` (via "flag"): the tracker delivered the board's own done flag flipping on a
// ticket of ours (a GitHub issue closed, an Asana task completed, a Jira issue moved to a
// done-category status, a Linear issue to a completed/canceled state). Signal only — no agent
// runs, no board write, the pipeline does not move. Handled outside the run queue like
// `epic_changed` (src/epic-changed.js): dedup on `seen`, emit. The terminal-stage half of
// The pipeline's terminal stage is not done: entering it is agenthook's handoff
// (`pipeline_done`), and the board stays open until its own flag flips (ADR 0008).

/**
 * Is this event the board saying done (ADR 0008)? Only the tracker's own done flag
 * (`board_done`, via "flag"). A `via:"stage"` event (written by receivers between #585 and the
 * flag-only decision) and `pipeline_done` are agenthook handing the ticket back, not done.
 * @param {Record<string, any>} e
 */
export function isBoardDone(e) {
  return e.event === "board_done" && e.via !== "stage";
}

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
