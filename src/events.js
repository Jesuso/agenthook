// Append-only lifecycle event stream: one JSON line per pipeline transition,
// written to <dataDir>/events.jsonl. Best-effort — a failed write warns and
// continues; the event log is observability, never control.
import fs from "node:fs";
import path from "node:path";

/** The `failed` reason for an operator `cancel` — readers (the dashboard) tell it apart from a crash. */
export const CANCELLED_REASON = "cancelled by operator";

/** Event names omitted by default from `ah events`/`ah watch`/the MCP `events` tool/the UI feed
 * unless explicitly requested — still written to events.jsonl. */
export const HIDDEN_BY_DEFAULT = new Set(["coalesced", "digest_start", "digest_end", "epic_changed"]);

/**
 * Create an event emitter that appends to `<dataDir>/events.jsonl`.
 * Every call is synchronous (appendFileSync) and best-effort: exceptions
 * are caught and logged as warnings so a write failure never breaks the pipeline.
 *
 * Event shape: `{ ts, event, ref, step, ...fields }`
 *   ts    — ISO timestamp
 *   event — one of: enqueued | run_start | run_end | pipeline_done | blocked | failed | merged | pulled | ci_red | ci_green
 *           (run_end: `outcome`, `costUsd?`; a local-model run — step `bin` or a non-Claude model — has
 *             `unpriced: true` and no `costUsd`, so it adds nothing to any reported spend sum. `costBasis?` =
 *             reported | rate-table; `estUsd?` = an API-equivalent rate-table estimate (src/pricing.js), never
 *             summed into `costUsd`; when the agent returned a result, also `model?`, `input`, `output`,
 *             `cacheRead`, `cacheCreate` so readers can price it; a step with `energy: true` adds
 *             `energyKwh?`, `energyUsd?`, `energySource?` — measured electricity (src/energy.js), never
 *             summed into `costUsd`/`estUsd`)
 *           | coalesced (a duplicate webhook for a ref+step already queued/running was dropped; not in
 *             the sinks' default set, and hidden by default in `ah events`/`ah watch`/the MCP `events`
 *             tool/the UI feed — see HIDDEN_BY_DEFAULT)
 *           | move_refused (a verdict's move did not happen — the adapter refused it or threw; `outcome` = the
 *             refused verdict, `reason` = not_ours | owner_check_failed | move_error, `detail` = the error message)
 *           | dismissed (operator `dismiss`: a failed/cancelled ticket was acknowledged; not in the sinks' default set)
 *           | digest_start | digest_end (an on-demand Digest ran, src/digest.js; ref/step ""; `digest_end` has `outcome` ok|fail, `costUsd` or `reason`; hidden by default, not in the sinks' default set)
 *           | overlap_held | overlap_released (overlapGuard; not in the sinks' default set)
 *           | epic_skipped (a pipeline job reached an item that is an epic; no agent ran, nothing moved; `name`, `url`)
 *           | epic_changed (the tracker delivered an epic-structure change — GitHub: a sub-issue added/removed, an issue
 *             typed/untyped; Jira: a child's parent changed, an issue created/deleted under an epic, an epic created/retyped; `ref` = the epic, step ""; signal only, src/epic-changed.js; hidden by default, not in the sinks' default set)
 *           | restart_requested | restarting (control-socket restart; ref/step ""; not in the sinks' default set)
 *           | decommission_requested | decommissioning (control-socket decommission; ref/step ""; not in the sinks' default set)
 *   ref   — task ref (provider-native id)
 *   step  — pipeline step id
 *
 * @param {string} dataDir  profile data directory (~/.agenthook/<name>/)
 * @param {(ev: Record<string, any>) => void} [onEvent]  optional fan-out (sinks), called after the append; its throws are swallowed
 * @returns {(event: string, ref: string, step: string, extra?: Record<string, any>) => void}
 */
export function createEmitter(dataDir, onEvent) {
  const eventsFile = path.join(dataDir, "events.jsonl");
  return function emit(event, ref, step, extra) {
    let obj;
    try {
      obj = { ts: new Date().toISOString(), event, ref, step, ...extra };
      fs.appendFileSync(eventsFile, JSON.stringify(obj) + "\n");
    } catch (e) {
      console.warn(`[events] failed to write "${event}" for ${ref}/${step}:`, e.message);
    }
    if (!onEvent || !obj) return;
    try {
      onEvent(obj);
    } catch (e) {
      console.warn(`[events] onEvent failed for "${event}" ${ref}/${step}:`, e.message);
    }
  };
}

/**
 * Report a verdict's move that did not happen (the adapter's `advance` threw), so a supervisor
 * watching events doesn't wait on a next step that will never fire. A `MoveRefusedError`
 * (code "move_refused") carries its own reason; anything else is "move_error".
 * @param {((event: string, ref: string, step: string, extra?: Record<string, any>) => void) | undefined} emit
 * @param {string} ref @param {string} stepId @param {string} outcome  the refused verdict outcome
 * @param {any} err
 */
export function reportMoveFailure(emit, ref, stepId, outcome, err) {
  const reason = err?.code === "move_refused" && err.reason ? err.reason : "move_error";
  emit?.("move_refused", ref, stepId, { outcome, reason, detail: String(err?.message ?? err).slice(0, 200) });
}
