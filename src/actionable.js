// Which pipeline events need a human or a supervising agent (`ah watch --actionable`). Most of the
// stream is the receiver reporting what it already handled — a finished pipeline, a merge, a red
// CI it is re-running, a green PR that auto-merges by itself. A supervisor woken for each of those
// wakes for nothing; `--actionable` wakes it only for the events below and folds the rest into a
// compact summary that rides along with the next wake (or the timeout). Pure; no I/O.

/** Always actionable: the pipeline stopped and is waiting on someone. */
const ALWAYS = new Set(["blocked", "failed", "move_refused", "auto_merge_failed", "auto_merge_skipped", "daemon_down"]);

/** `ci_red` actions the receiver already handles on its own (re-run, rework bounce, parked bounce). */
const CI_RED_AUTOMATIC = new Set(["rerun", "bounced", "deferred"]);

/** Refs listed per event type in a summary; the count stays exact past it. */
const SUMMARY_REFS_MAX = 20;

/**
 * Does this event need a human/supervisor? `refmeta` is the profile's refmeta.json (per-ref
 * metadata) — a `ci_green` on a PR the receiver already set to auto-merge needs nobody.
 * - blocked, failed, move_refused, auto_merge_failed, auto_merge_skipped, daemon_down: yes.
 * - ci_red: only when the receiver did not re-run or bounce it itself (`action` skipped/absent).
 * - auto_merge_disabled: only `tooLate` (the rejected code already merged).
 * - ci_green: only when auto-merge is not on for the ref (someone has to merge it).
 * - everything else (pipeline_done, merged, hold_cleared, run_end, …): no.
 * @param {Record<string, any>} e  a raw events.jsonl record (`event` key) or a compact one (`e` key)
 * @param {Record<string, any>|null} [refmeta]
 */
export function isActionable(e, refmeta = null) {
  const name = e.event ?? e.e;
  if (ALWAYS.has(name)) return true;
  if (name === "ci_red") return !CI_RED_AUTOMATIC.has(e.action);
  if (name === "auto_merge_disabled") return e.tooLate === true;
  if (name === "ci_green") {
    const m = refmeta && Object.hasOwn(refmeta, e.ref) ? refmeta[e.ref] : null;
    return !(m && typeof m === "object" && m.autoMerge);
  }
  return false;
}

/**
 * Accumulates the events `--actionable` did not wake for: per event type, a count and the
 * distinct refs (the first SUMMARY_REFS_MAX). `take()` returns the summary and resets it, or
 * null when nothing was added.
 */
export function createSummary() {
  /** @type {Map<string, {n: number, refs: string[]}>} */
  let by = new Map();
  let total = 0;
  return {
    /** @param {Record<string, any>} e @param {string} [prefix]  e.g. the profile key in multi-profile mode */
    add(e, prefix) {
      const name = String(e.event ?? e.e);
      const ref = prefix ? `${prefix}:${e.ref}` : String(e.ref ?? "");
      const slot = by.get(name) ?? { n: 0, refs: [] };
      slot.n++;
      if (ref && !slot.refs.includes(ref) && slot.refs.length < SUMMARY_REFS_MAX) slot.refs.push(ref);
      by.set(name, slot);
      total++;
    },
    /** @returns {{n: number, byEvent: Record<string, {n: number, refs: string[]}>}|null} */
    take() {
      if (!total) return null;
      const out = { n: total, byEvent: Object.fromEntries([...by.entries()].sort(([a], [b]) => a.localeCompare(b))) };
      by = new Map();
      total = 0;
      return out;
    },
  };
}

/** One text line for a summary: `skipped 5: merged 2 (12, 15), pipeline_done 3 (12, 15, 18)`. @param {{n: number, byEvent: Record<string, {n: number, refs: string[]}>}} s */
export function summaryLine(s) {
  return `skipped ${s.n}: ${Object.entries(s.byEvent)
    .map(([k, v]) => `${k} ${v.n}${v.refs.length ? ` (${v.refs.join(", ")}${v.refs.length < v.n && v.refs.length >= SUMMARY_REFS_MAX ? ", …" : ""})` : ""}`)
    .join(", ")}`;
}
