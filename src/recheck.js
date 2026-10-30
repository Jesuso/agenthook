// Re-check (#598): ask the tracker and the forge once more for the two facts that clear a
// Needs-you PR row — the board's done flag and the PR's merge — when the webhook that carried
// one was missed (the receiver was down, the merge catch-up's window had passed). Explicit only:
// the `recheck` op (one ref, or every row already flagged with `prNeeds`), `reconcile` after
// its merge catch-up, and the merge catch-up itself for a task it finds completed. Never a
// board-wide poll, never a timer. It records local facts only — no tracker or forge write.
// Fail-closed: a ref whose task we can't confirm is ours records nothing.
import { repositoryOf } from "./heartbeat.js";
import { buildRows, lastRerunAt, readProfileState } from "./ui/rows.js";

/** @typedef {(event: string, ref: string, step: string, extra?: Record<string, any>) => void} Emit */

/** This profile's rows (with PR urls, so `prNeeds` is computed) and the events tail they came from.
 * @param {import('./types.js').Config} cfg */
export function readRecheckState(cfg) {
  const state = readProfileState(cfg.stateDir);
  return { rows: buildRows(cfg.name, state, { repository: repositoryOf(cfg) }), events: state.events };
}

/**
 * Record the board's done flag learned by asking: a `board_done` with `via: "recheck"`. Deduped
 * on `seen` per ref and its last re-run, so a repeat records nothing but a later re-run (whose
 * done no longer stands) can record it again.
 * @param {{store: import('./types.js').Store, emit: Emit}} deps
 * @param {string} ref @param {Record<string, any>[]} events  the events tail (readRecheckState)
 * @returns {boolean} true when emitted
 */
export function recordBoardDone({ store, emit }, ref, events) {
  const key = `recheck-done:${ref}:${lastRerunAt(events, ref) ?? ""}`;
  store.reloadSeen();
  if (store.hasSeen(key)) return false;
  store.markSeen(key);
  emit("board_done", ref, "", { via: "recheck" });
  return true;
}

/**
 * Re-check one ref: `fetchTask` (fail-closed: a failed fetch or a task not ours throws, nothing
 * recorded), then the PR's state when the forge can tell and the ref has one. Both reads happen
 * before any write. Records:
 *   - the board done (task completed, row not already `done`) → recordBoardDone;
 *   - a merged/closed PR → `refmeta.prState` (an open one drops a stale terminal state);
 *   - a merged PR → a `merged` event (`via: "recheck"`) unless one was already recorded for it:
 *     skipped when the live `merged:<pr>` key is seen, and deduped on its own `recheck-merged:<pr>`
 *     key, never on `merged:<pr>` — marking that would dedup away a later merge job's bridge.
 * A failed PR lookup is reported (`prError`) and changes no PR fact.
 * @param {{store: import('./types.js').Store, adapter: import('./types.js').Adapter, forge: import('./types.js').Forge|null|undefined, emit: Emit}} deps
 * @param {string} ref
 * @param {{row: import('./ui/contract.js').TicketRow|undefined, events: Record<string, any>[]}} local
 * @returns {Promise<{ref: string, changed: string[], unchanged: boolean, prError?: string}>}
 */
export async function recheckRef({ store, adapter, forge, emit }, ref, { row, events }) {
  /** @type {import('./types.js').Task} */
  let task;
  try {
    task = await adapter.fetchTask(ref);
  } catch (e) {
    throw new Error(`${ref}: fetching it failed (${String(e.message).slice(0, 120)}) — nothing recorded`);
  }
  if (!task.assignedToUs) throw new Error(`${ref} is not assigned to us — nothing recorded`);
  const meta = store.getRefMeta(ref);
  const pr = meta?.pr;
  /** @type {'open'|'merged'|'closed'|null} */
  let prState = null;
  /** @type {string|undefined} */
  let prError;
  if (typeof forge?.prState === "function" && Number.isInteger(pr) && /** @type {number} */ (pr) > 0) {
    try {
      prState = await forge.prState(/** @type {number} */ (pr));
    } catch (e) {
      prError = `PR #${pr}: ${String(e.message).slice(0, 120)}`;
    }
  }

  /** @type {string[]} */
  const changed = [];
  if (task.completed && row?.status !== "done" && recordBoardDone({ store, emit }, ref, events)) changed.push("board_done");
  if (prState === "merged" || prState === "closed") {
    if (meta?.prState !== prState) {
      store.setRefMeta(ref, { prState });
      changed.push(`prState:${prState}`);
    }
  } else if (prState === "open" && meta?.prState) {
    store.setRefMeta(ref, { prState: null }); // reopened
    changed.push("prState:open");
  }
  if (prState === "merged") {
    store.reloadSeen();
    const key = `recheck-merged:${pr}`;
    if (!store.hasSeen(`merged:${pr}`) && !store.hasSeen(key)) {
      store.markSeen(key);
      emit("merged", ref, "", { via: "recheck", name: task.name, url: task.url });
      changed.push("merged");
    }
  }
  return { ref, changed, unchanged: changed.length === 0, ...(prError ? { prError } : {}) };
}
