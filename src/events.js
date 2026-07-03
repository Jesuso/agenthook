// Append-only lifecycle event stream: one JSON line per pipeline transition,
// written to <dataDir>/events.jsonl. Best-effort — a failed write warns and
// continues; the event log is observability, never control.
import fs from "node:fs";
import path from "node:path";

/**
 * Create an event emitter that appends to `<dataDir>/events.jsonl`.
 * Every call is synchronous (appendFileSync) and best-effort: exceptions
 * are caught and logged as warnings so a write failure never breaks the pipeline.
 *
 * Event shape: `{ ts, event, ref, step, ...fields }`
 *   ts    — ISO timestamp
 *   event — one of: enqueued | run_start | run_end | pipeline_done | blocked | failed
 *   ref   — task ref (provider-native id)
 *   step  — pipeline step id
 *
 * @param {string} dataDir  profile data directory (~/.agenthook/<name>/)
 * @returns {(event: string, ref: string, step: string, extra?: Record<string, any>) => void}
 */
export function createEmitter(dataDir) {
  const eventsFile = path.join(dataDir, "events.jsonl");
  return function emit(event, ref, step, extra) {
    try {
      const line = JSON.stringify({ ts: new Date().toISOString(), event, ref, step, ...extra });
      fs.appendFileSync(eventsFile, line + "\n");
    } catch (e) {
      console.warn(`[events] failed to write "${event}" for ${ref}/${step}:`, e.message);
    }
  };
}
