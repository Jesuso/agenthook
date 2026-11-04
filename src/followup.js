// "Approve with follow-up checks": a review whose remaining acceptance criteria can only be
// verified once the change is live (a production metric, a log line, a third-party callback) no
// longer has to hold the PR for a human yes. The approving step writes `advance` plus
// `followUp: ["…", …]`; when the ticket's risk tier (read as auto-merge reads it, src/auto-merge.js
// riskTier) is one auto-merge allows (`forge.autoMerge.tiers`, else low/medium), the PR goes on
// as an ordinary approval and the checks are recorded on the ref (refmeta `followUp`) for someone
// to verify later — `ah followup list|done`, the `followUp` list in `status`/`tick`. A higher (or
// missing) tier turns the verdict into a `hold` whose reason names the checks: a risky change
// still waits for a human. agenthook never sees a deploy; what it sees is the merge, so
// `followup_due` fires when the PR merges (or at approval when no forge is configured) and is
// what wakes `watch --actionable`. The checks are agent-authored text: shown to people, never
// fed back into a prompt.
import { riskTier } from "./auto-merge.js";

/** Most checks kept from one verdict. */
export const MAX_FOLLOWUP_CHECKS = 10;
/** Each check is clipped to this many characters. */
export const MAX_FOLLOWUP_CHARS = 300;
/** Tiers that may approve with follow-up checks when `forge.autoMerge` is not configured. */
export const DEFAULT_FOLLOWUP_TIERS = ["low", "medium"];
/** The hold reason is clipped to this many characters. */
const HOLD_REASON_MAX = 500;

/**
 * A verdict's `followUp`: an array of non-empty strings (whitespace collapsed, each clipped
 * to MAX_FOLLOWUP_CHARS, at most MAX_FOLLOWUP_CHECKS). Anything else → undefined. Pure.
 * @param {unknown} raw
 * @returns {string[]|undefined}
 */
export function parseFollowUp(raw) {
  if (!Array.isArray(raw)) return undefined;
  const checks = raw
    .filter((c) => typeof c === "string")
    .map((c) => c.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, MAX_FOLLOWUP_CHECKS)
    .map((c) => (c.length > MAX_FOLLOWUP_CHARS ? c.slice(0, MAX_FOLLOWUP_CHARS - 1).trimEnd() + "…" : c));
  return checks.length ? checks : undefined;
}

/** The tiers that may approve with follow-up checks (lower-cased). @param {import('./types.js').Config} cfg */
export function followUpTiers(cfg) {
  const t = cfg.forge?.autoMerge?.tiers;
  return (Array.isArray(t) && t.length ? t : DEFAULT_FOLLOWUP_TIERS).map((x) => String(x).trim().toLowerCase());
}

/**
 * What a finished run's follow-up checks do. Pure.
 * - null: nothing to do (not an `advance`, or no checks).
 * - `{hold, checks, tier}`: the tier is missing or not allowed — hold with `hold` as the reason.
 * - `{record, checks, tier}`: approve; record the checks.
 * The tier is read exactly as auto-merge reads it (`riskTier`): the verdict's own `summary.tier`
 * only when this step is the tier source, else the stored `tierFrom` summary — one rating per ticket.
 * @param {import('./types.js').Config} cfg @param {string} stepId @param {import('./types.js').Verdict} verdict
 * @param {Record<string, import('./types.js').SummaryRecord>|undefined} [summaries]
 * @returns {{hold: string, checks: string[], tier: string|null} | {record: true, checks: string[], tier: string} | null}
 */
export function followUpDecision(cfg, stepId, verdict, summaries) {
  if (verdict.outcome !== "advance" || !verdict.followUp?.length) return null;
  const checks = verdict.followUp;
  const { tier } = riskTier(cfg, stepId, verdict, summaries);
  if (tier && followUpTiers(cfg).includes(tier)) return { record: true, checks, tier };
  const reason = `follow-up checks on a ${tier ? `${tier}-risk` : "risk-unrated"} change need a human yes before merge: ${checks.join("; ")}`;
  return { hold: reason.length > HOLD_REASON_MAX ? reason.slice(0, HOLD_REASON_MAX - 1) + "…" : reason, checks, tier };
}

/**
 * The refs with recorded follow-up checks, oldest first, from a refmeta map. Pure.
 * @param {Record<string, any>} refmeta
 * @returns {{ref: string, checks: string[], tier?: string, step?: string, pr?: number, since?: string, title?: string, id?: string}[]}
 */
export function pendingFollowUp(refmeta) {
  /** @type {{ref: string, checks: string[], tier?: string, step?: string, pr?: number, since?: string, title?: string, id?: string}[]} */
  const out = [];
  for (const [ref, m] of Object.entries(refmeta ?? {})) {
    const p = m && typeof m === "object" ? m.followUp : null;
    if (!p || typeof p !== "object" || !Array.isArray(p.checks) || !p.checks.length) continue;
    out.push({
      ref,
      checks: p.checks.filter((/** @type {unknown} */ c) => typeof c === "string"),
      ...(typeof p.tier === "string" ? { tier: p.tier } : {}),
      ...(typeof p.step === "string" ? { step: p.step } : {}),
      ...(Number.isInteger(p.pr) ? { pr: p.pr } : Number.isInteger(m.pr) ? { pr: m.pr } : {}),
      ...(typeof p.at === "string" ? { since: p.at } : {}),
      ...(typeof m.title === "string" ? { title: m.title } : {}),
      ...(typeof m.displayId === "string" ? { id: m.displayId } : {}),
    });
  }
  return out.sort((a, b) => String(a.since ?? "").localeCompare(String(b.since ?? "")));
}

/**
 * Mark a ref's follow-up checks verified: drop the record and emit `followup_done` with the
 * checks that were open. Throws when the ref has none. The receiver's `followup_done` op, or
 * `ah followup done` straight on the state dir while the receiver is down.
 * @param {{getRefMeta(ref: string): any, setRefMeta(ref: string, patch: any): void}} store
 * @param {(event: string, ref: string, step: string, extra?: Record<string, any>) => void} emit
 * @param {string} ref
 */
export function markFollowUpDone(store, emit, ref) {
  const p = store.getRefMeta(ref)?.followUp;
  if (!p || !Array.isArray(p.checks) || !p.checks.length) throw new Error(`${ref} has no follow-up checks recorded`);
  store.setRefMeta(ref, { followUp: null });
  emit("followup_done", ref, typeof p.step === "string" ? p.step : "", { n: p.checks.length, detail: p.checks.join("; "), by: "operator" });
  return { ref, done: p.checks };
}
