// "Approve with post-deploy checks": a review whose remaining acceptance criteria can only be
// verified once the change is live (a production metric, a log line, a third-party callback) no
// longer has to hold the PR for a human yes. The approving step writes `advance` plus
// `postDeploy: ["…", …]` (and its `summary.tier`); when that tier is one auto-merge allows
// (`forge.autoMerge.tiers`, else low/medium), the PR goes on as an ordinary approval and the
// checks are recorded on the ref (refmeta `postDeploy`) for someone to verify after the deploy —
// `ah postdeploy list|done`, the `postDeploy` list in `status`/`tick`. A higher (or missing) tier
// turns the verdict into a `hold` whose reason names the checks: a risky change still waits for a
// human. The checks are agent-authored text: shown to people, never fed back into a prompt.
import { autoMergeTierStepId } from "./auto-merge.js";

/** Most checks kept from one verdict. */
export const MAX_POSTDEPLOY_CHECKS = 10;
/** Each check is clipped to this many characters. */
export const MAX_POSTDEPLOY_CHARS = 300;
/** Tiers that may approve with post-deploy checks when `forge.autoMerge` is not configured. */
export const DEFAULT_POSTDEPLOY_TIERS = ["low", "medium"];
/** The hold reason is clipped to this many characters. */
const HOLD_REASON_MAX = 500;

/**
 * A verdict's `postDeploy`: an array of non-empty strings (whitespace collapsed, each clipped
 * to MAX_POSTDEPLOY_CHARS, at most MAX_POSTDEPLOY_CHECKS). Anything else → undefined. Pure.
 * @param {unknown} raw
 * @returns {string[]|undefined}
 */
export function parsePostDeploy(raw) {
  if (!Array.isArray(raw)) return undefined;
  const checks = raw
    .filter((c) => typeof c === "string")
    .map((c) => c.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, MAX_POSTDEPLOY_CHECKS)
    .map((c) => (c.length > MAX_POSTDEPLOY_CHARS ? c.slice(0, MAX_POSTDEPLOY_CHARS - 1).trimEnd() + "…" : c));
  return checks.length ? checks : undefined;
}

/** The tiers that may approve with post-deploy checks (lower-cased). @param {import('./types.js').Config} cfg */
export function postDeployTiers(cfg) {
  const t = cfg.forge?.autoMerge?.tiers;
  return (Array.isArray(t) && t.length ? t : DEFAULT_POSTDEPLOY_TIERS).map((x) => String(x).trim().toLowerCase());
}

/**
 * What a finished run's post-deploy checks do. Pure.
 * - null: nothing to do (not an `advance`, or no checks).
 * - `{hold, checks, tier}`: the tier is missing or not allowed — hold with `hold` as the reason.
 * - `{record, checks, tier}`: approve; record the checks.
 * The tier is the verdict's own `summary.tier`, else the stored summary of the auto-merge tier
 * step (`forge.autoMerge.tierFrom`) when this run is not that step.
 * @param {import('./types.js').Config} cfg @param {string} stepId @param {import('./types.js').Verdict} verdict
 * @param {Record<string, import('./types.js').SummaryRecord>|undefined} [summaries]
 * @returns {{hold: string, checks: string[], tier: string|null} | {record: true, checks: string[], tier: string} | null}
 */
export function postDeployDecision(cfg, stepId, verdict, summaries) {
  if (verdict.outcome !== "advance" || !verdict.postDeploy?.length) return null;
  const checks = verdict.postDeploy;
  let raw = verdict.summary?.tier;
  if (typeof raw !== "string" || !raw.trim()) {
    const from = cfg.forge?.autoMerge ? autoMergeTierStepId(cfg.pipeline, cfg.forge.autoMerge) : null;
    const rec = from && from !== stepId ? summaries?.[from] : undefined;
    raw = rec && rec.outcome === "advance" ? /** @type {any} */ (rec.summary)?.tier : undefined;
  }
  const tier = typeof raw === "string" && raw.trim() ? raw.trim().toLowerCase() : null;
  if (tier && postDeployTiers(cfg).includes(tier)) return { record: true, checks, tier };
  const reason = `post-deploy checks on a ${tier ? `${tier}-risk` : "risk-unrated"} change need a human yes before merge: ${checks.join("; ")}`;
  return { hold: reason.length > HOLD_REASON_MAX ? reason.slice(0, HOLD_REASON_MAX - 1) + "…" : reason, checks, tier };
}

/**
 * The refs with recorded post-deploy checks, oldest first, from a refmeta map. Pure.
 * @param {Record<string, any>} refmeta
 * @returns {{ref: string, checks: string[], tier?: string, step?: string, pr?: number, since?: string, title?: string, id?: string}[]}
 */
export function pendingPostDeploy(refmeta) {
  /** @type {{ref: string, checks: string[], tier?: string, step?: string, pr?: number, since?: string, title?: string, id?: string}[]} */
  const out = [];
  for (const [ref, m] of Object.entries(refmeta ?? {})) {
    const p = m && typeof m === "object" ? m.postDeploy : null;
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
 * Mark a ref's post-deploy checks verified: drop the record and emit `postdeploy_done` with the
 * checks that were open. Throws when the ref has none. The receiver's `postdeploy_done` op, or
 * `ah postdeploy done` straight on the state dir while the receiver is down.
 * @param {{getRefMeta(ref: string): any, setRefMeta(ref: string, patch: any): void}} store
 * @param {(event: string, ref: string, step: string, extra?: Record<string, any>) => void} emit
 * @param {string} ref
 */
export function markPostDeployDone(store, emit, ref) {
  const p = store.getRefMeta(ref)?.postDeploy;
  if (!p || !Array.isArray(p.checks) || !p.checks.length) throw new Error(`${ref} has no post-deploy checks recorded`);
  store.setRefMeta(ref, { postDeploy: null });
  emit("postdeploy_done", ref, typeof p.step === "string" ? p.step : "", { n: p.checks.length, detail: p.checks.join("; "), by: "operator" });
  return { ref, done: p.checks };
}
