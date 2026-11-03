// `board_done` (via "flag"): the tracker delivered the board's own done flag flipping on a
// ticket of ours (a GitHub issue closed, an Asana task completed, a Jira issue moved to a
// done-category status, a Linear issue to a completed/canceled state). Signal only — no agent
// runs, no board write, the pipeline does not move. Handled outside the run queue like
// `epic_changed` (src/epic-changed.js): dedup on `seen`, emit. The terminal-stage half of
// The pipeline's terminal stage is not done: entering it is agenthook's handoff
// (`pipeline_done`), and the board stays open until its own flag flips (ADR 0008). A held
// ticket that turns done loses its hold (clearHoldOnDone, `hold_cleared`).
import { isStateDedupKey } from "./store.js";

/**
 * Is this event the board saying done (ADR 0008)? Only the tracker's own done flag
 * (`board_done`, via "flag" — or "recheck", the same flag read on request, src/recheck.js). A `via:"stage"` event (written by receivers between #585 and the
 * flag-only decision) and `pipeline_done` are agenthook handing the ticket back, not done.
 * @param {Record<string, any>} e
 */
export function isBoardDone(e) {
  return e.event === "board_done" && e.via !== "stage";
}

/**
 * A held ticket that is done on the board has nothing left to answer: drop its held record (the
 * dashboard's "needs you", `status.held`) and any pipeline job still waiting for it (an owner's
 * resume queued behind busy slots), with `hold_cleared`. Local state only: no tracker write
 * (unlike `cancel`, which moves the ticket to the failure lane). A running agent is never
 * touched, a waiting `merge`/`ci` job stays (on a completed task a merge is self-closing and
 * records the PR's merge), and a ref that is not held is left alone.
 * @param {{
 *   store: import('./types.js').Store,
 *   emit?: (event: string, ref: string, step: string, extra?: Record<string, any>) => void,
 *   queue?: {remove: (ref: string, stepId?: string, only?: (job: import('./types.js').Job) => boolean) => import('./types.js').Job[]},
 * }} deps  queue: the receiver's run queue (omitted by callers that refuse a queued ref)
 * @param {string} ref
 * @returns {boolean} true when a hold was cleared
 */
export function clearHoldOnDone({ store, emit, queue }, ref) {
  const held = store.getHeld(ref);
  if (!held) return false;
  const dropped = queue?.remove(ref, undefined, (j) => (j.kind ?? "pipeline") === "pipeline") ?? [];
  store.reloadSeen();
  for (const j of dropped) if (isStateDedupKey(j.dedupKey)) store.unmarkSeen(j.dedupKey); // a later re-entry of that stage must still fire
  store.clearHeld(ref);
  emit?.("hold_cleared", ref, held.stepId ?? "", { via: "board_done", ...(dropped.length ? { dequeued: dropped.map((j) => j.stepId) } : {}) });
  return true;
}

/**
 * @param {{
 *   store: import('./types.js').Store,
 *   emit?: (event: string, ref: string, step: string, extra?: Record<string, any>) => void,
 *   queue?: {remove: (ref: string, stepId?: string, only?: (job: import('./types.js').Job) => boolean) => import('./types.js').Job[]},
 * }} deps
 * @returns {(job: import('./types.js').Job) => boolean}  true when `board_done` was emitted
 */
export function createBoardDone({ store, emit, queue }) {
  return function boardDone(job) {
    store.reloadSeen();
    if (store.hasSeen(job.dedupKey)) return false;
    store.markSeen(job.dedupKey);
    emit?.("board_done", job.ref, "", { via: "flag" });
    clearHoldOnDone({ store, emit, queue }, job.ref);
    return true;
  };
}
