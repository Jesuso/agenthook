// Auto-merge on approval (opt-in `forge.autoMerge`). When the approving step (`autoMerge.step`, or
// the pipeline's last review-kind step) finishes with `advance` and the risk tier — its own
// verdict's `summary.tier`, or the stored summary of `autoMerge.tierFrom` — is in
// `autoMerge.tiers`, the receiver asks the forge to mark the agent PR ready (if draft) and enable
// auto-merge, so GitHub merges it once its required checks pass. A later `changes`/`fail` on the
// task (a step bouncing it back, or a red-CI bounce) turns auto-merge off again while the PR is
// still open, so a rework commit never merges on the strength of an earlier approval.
// Best-effort by design: a refusal (repo setting, permissions, network) is logged and emitted as
// `auto_merge_failed`; it never changes the verdict, the board move or the step's result.
// Import-free, so config.js can take `autoMergeErrors` without pulling in dispatch.

export const AUTO_MERGE_METHODS = /** @type {const} */ (["squash", "merge", "rebase"]);

/** Clip for the `reason` of an `auto_merge_*` event. */
const REASON_MAX = 200;

/**
 * The step whose `advance` triggers auto-merge: `autoMerge.step`, else the pipeline's last
 * review-kind step (a later review must not be skipped by an earlier one merging). Pure.
 * @param {any[]|undefined|null} pipeline @param {any} autoMerge
 * @returns {string|null}
 */
export function autoMergeStepId(pipeline, autoMerge) {
  if (typeof autoMerge?.step === "string" && autoMerge.step) return autoMerge.step;
  const reviews = (pipeline ?? []).filter((s) => s && typeof s === "object" && s.kind === "review" && !s.manual);
  return reviews.length ? String(reviews[reviews.length - 1].id) : null;
}

/**
 * The step whose verdict carries the risk tier: `autoMerge.tierFrom`, else the approving step. Pure.
 * @param {any[]|undefined|null} pipeline @param {any} autoMerge
 * @returns {string|null}
 */
export function autoMergeTierStepId(pipeline, autoMerge) {
  if (typeof autoMerge?.tierFrom === "string" && autoMerge.tierFrom) return autoMerge.tierFrom;
  return autoMergeStepId(pipeline, autoMerge);
}

/**
 * Config validation for the optional `forge.autoMerge` block. Pure.
 * @param {any} forge  the raw `forge` block (may be undefined)
 * @param {any[]|undefined|null} pipeline
 * @returns {string[]}
 */
export function autoMergeErrors(forge, pipeline) {
  const am = forge?.autoMerge;
  if (am == null) return [];
  if (typeof am !== "object" || Array.isArray(am)) return [`config: "forge.autoMerge" must be an object ({ "tiers": ["low"], "method": "squash" }).`];
  /** @type {string[]} */
  const errors = [];
  if (forge.type !== "github") errors.push(`config: "forge.autoMerge" is only supported on the github forge.`);
  const t = am.tiers;
  if (!Array.isArray(t) || !t.length || t.some((/** @type {unknown} */ x) => typeof x !== "string" || !x.trim())) {
    errors.push(`config: forge.autoMerge.tiers must be a non-empty array of tier names (e.g. ["low", "medium"]).`);
  }
  if (am.method != null && !(/** @type {readonly unknown[]} */ (AUTO_MERGE_METHODS)).includes(am.method)) {
    errors.push(`config: forge.autoMerge.method must be one of ${AUTO_MERGE_METHODS.join(", ")} (got ${JSON.stringify(am.method)}).`);
  }
  const badStep = am.step != null && (typeof am.step !== "string" || !am.step.trim());
  const badTierFrom = am.tierFrom != null && (typeof am.tierFrom !== "string" || !am.tierFrom.trim());
  if (badStep) errors.push(`config: forge.autoMerge.step must be a pipeline step id.`);
  if (badTierFrom) errors.push(`config: forge.autoMerge.tierFrom must be a pipeline step id.`);
  if (badStep || badTierFrom || !Array.isArray(pipeline)) return errors;

  const id = autoMergeStepId(pipeline, am);
  const idx = id ? pipeline.findIndex((s) => s && typeof s === "object" && s.id === id) : -1;
  const step = idx >= 0 ? pipeline[idx] : null;
  if (!id) errors.push(`config: forge.autoMerge needs a review step: add "kind": "review" to one, or set forge.autoMerge.step.`);
  else if (!step) errors.push(`config: forge.autoMerge.step ${JSON.stringify(id)} is not a pipeline step id.`);
  else if (step.manual) errors.push(`config: forge.autoMerge.step ${JSON.stringify(id)} is a manual step (no agent writes a verdict there).`);
  if (am.tierFrom != null && step) {
    const ti = pipeline.findIndex((s) => s && typeof s === "object" && s.id === am.tierFrom);
    const from = ti >= 0 ? pipeline[ti] : null;
    if (!from) errors.push(`config: forge.autoMerge.tierFrom ${JSON.stringify(am.tierFrom)} is not a pipeline step id.`);
    else if (from.manual) errors.push(`config: forge.autoMerge.tierFrom ${JSON.stringify(am.tierFrom)} is a manual step (no agent writes a verdict there).`);
    else if (ti > idx) errors.push(`config: forge.autoMerge.tierFrom ${JSON.stringify(am.tierFrom)} runs after the approving step ${JSON.stringify(id)}, so its tier would be stale.`);
  }
  return errors;
}

/**
 * Should this finished run auto-merge its PR? Pure.
 * - `null`: not applicable — no block, not the approving step, or not an `advance`.
 * - `{skipped, tier?}`: the approving step advanced but the tier does not allow it (missing, outside
 *   `tiers`, or the `tierFrom` step has no approving verdict stored). Reported, never merged.
 * - `{tier, method}`: go. Tiers compare trimmed, case-insensitive.
 * @param {import('./types.js').Config} cfg @param {string} stepId @param {import('./types.js').Verdict} verdict
 * @param {Record<string, import('./types.js').SummaryRecord>|undefined} [summaries]  the ref's stored step summaries (for `tierFrom`)
 * @returns {{tier: string, method: 'squash'|'merge'|'rebase'}|{skipped: string, tier?: string}|null}
 */
export function autoMergeDecision(cfg, stepId, verdict, summaries) {
  const am = cfg.forge?.autoMerge;
  if (!am || !Array.isArray(am.tiers)) return null;
  if (verdict.outcome !== "advance") return null;
  if (stepId !== autoMergeStepId(cfg.pipeline, am)) return null;
  const from = autoMergeTierStepId(cfg.pipeline, am) ?? stepId;
  let raw;
  if (from === stepId) {
    raw = verdict.summary?.tier;
  } else {
    const rec = summaries?.[from];
    if (!rec || rec.outcome !== "advance") return { skipped: `step "${from}" (tierFrom) has no approving verdict stored` };
    raw = /** @type {any} */ (rec.summary)?.tier;
  }
  if (typeof raw !== "string" || !raw.trim()) return { skipped: `no summary.tier in the "${from}" verdict` };
  const tier = raw.trim().toLowerCase();
  if (!am.tiers.some((t) => String(t).trim().toLowerCase() === tier)) return { skipped: `tier "${tier}" is not in [${am.tiers.join(", ")}]`, tier };
  return { tier, method: am.method ?? "squash" };
}

/**
 * @typedef {{
 *   forge: import('./types.js').Forge|null|undefined,
 *   store?: import('./types.js').Store,
 *   emit?: (event: string, ref: string, step: string, extra?: Record<string, any>) => void,
 * }} AutoMergeDeps
 */

/**
 * The ref's open agent PR: by a hint or the stored number first, then by branch when that one is
 * gone (a closed earlier PR must not hide the current one). Throws on a lookup error.
 * @param {import('./types.js').Forge} forge @param {import('./types.js').Store|undefined} store
 * @param {string} ref @param {number|null} [hint]
 */
async function findPr(forge, store, ref, hint) {
  if (!forge.prHead) return null;
  const stored = store?.getRefMeta(ref)?.pr;
  const known = hint ?? (Number.isInteger(stored) && stored ? /** @type {number} */ (stored) : null);
  const pr = await forge.prHead(known, ref);
  if (known && (!pr || !pr.open)) return (await forge.prHead(null, ref)) ?? pr;
  return pr;
}

/**
 * Run auto-merge for a run that `autoMergeDecision` approved. Never throws: every failure
 * becomes one log line + an `auto_merge_failed` event, and the PR is otherwise left as it was
 * (a draft already marked ready stays ready).
 * @param {AutoMergeDeps} deps
 * @param {string} ref @param {string} stepId
 * @param {{tier: string, method: 'squash'|'merge'|'rebase'}} decision
 * @returns {Promise<import('./types.js').AutoMergeResult|null>}  null when it did not happen
 */
export async function runAutoMerge({ forge, store, emit }, ref, stepId, { tier, method }) {
  /** @param {string} reason @param {number} [pr] */
  const failed = (reason, pr) => {
    const r = String(reason).slice(0, REASON_MAX);
    console.error(`[auto-merge] ${ref}${pr ? ` PR #${pr}` : ""} not enabled: ${r}`);
    emit?.("auto_merge_failed", ref, stepId, { ...(pr ? { pr } : {}), tier, reason: r });
    return null;
  };
  if (!forge?.enableAutoMerge || !forge.prHead) return failed("the forge cannot auto-merge");
  let pr;
  try {
    pr = await findPr(forge, store, ref);
  } catch (e) {
    return failed(`PR lookup failed: ${e.message}`);
  }
  if (!pr) return failed("no agent PR for this task");
  if (!pr.open) {
    console.log(`[auto-merge] ${ref} PR #${pr.number} is not open — nothing to do`);
    return null;
  }
  let res;
  try {
    res = await forge.enableAutoMerge(pr.number, { method });
  } catch (e) {
    return failed(e.message, pr.number);
  }
  if (res.status === "already" || res.status === "merged" || res.status === "closed") {
    console.log(`[auto-merge] ${ref} PR #${pr.number}: ${res.status === "already" ? "auto-merge already enabled" : `already ${res.status}`}`);
    return res;
  }
  console.log(`[auto-merge] ${ref} PR #${pr.number} (${tier}): ${res.status === "merged_now" ? "nothing to wait for — merged" : `auto-merge enabled (${method})`}${res.readied ? ", marked ready" : ""}`);
  emit?.("auto_merge_enabled", ref, stepId, { pr: pr.number, tier, method, ...(res.readied ? { readied: true } : {}), ...(res.status === "merged_now" ? { mergedNow: true } : {}) });
  return res;
}

/**
 * Report an approving-step advance that did not qualify (`autoMergeDecision` → `{skipped}`), so a
 * misconfigured tier is visible instead of silent.
 * @param {AutoMergeDeps} deps @param {string} ref @param {string} stepId
 * @param {{skipped: string, tier?: string}} d
 */
export function reportAutoMergeSkipped({ emit }, ref, stepId, d) {
  const r = d.skipped.slice(0, REASON_MAX);
  console.log(`[auto-merge] ${ref} ${stepId} advanced but not auto-merging: ${r}`);
  emit?.("auto_merge_skipped", ref, stepId, { ...(d.tier ? { tier: d.tier } : {}), reason: r });
}

/**
 * The task is going back (a `changes`/`fail` verdict, or a red-CI bounce): if its open PR has
 * auto-merge on, turn it off before the rework can push, so the earlier approval never merges code
 * it did not see. A no-op (no event) when auto-merge was off or the PR is gone. Never throws.
 * @param {AutoMergeDeps} deps
 * @param {string} ref @param {string} stepId  the step the task is leaving
 * @param {string} why  short cause, e.g. "changes from qa"
 * @param {number|null} [prHint]  the PR number when the caller already knows it
 * @returns {Promise<boolean>}  true when auto-merge was turned off
 */
export async function disableAutoMergeOnBounce({ forge, store, emit }, ref, stepId, why, prHint) {
  if (!forge?.disableAutoMerge || !forge.prHead) return false;
  let pr;
  try {
    pr = await findPr(forge, store, ref, prHint ?? null);
    if (!pr || !pr.open) return false;
    const res = await forge.disableAutoMerge(pr.number);
    if (res.status !== "disabled") return false;
  } catch (e) {
    const r = `disable failed (${why}): ${e.message}`.slice(0, REASON_MAX);
    console.error(`[auto-merge] ${ref}${pr ? ` PR #${pr.number}` : ""} ${r}`);
    emit?.("auto_merge_failed", ref, stepId, { ...(pr ? { pr: pr.number } : {}), reason: r });
    return false;
  }
  console.log(`[auto-merge] ${ref} PR #${pr.number}: auto-merge turned off (${why})`);
  emit?.("auto_merge_disabled", ref, stepId, { pr: pr.number, reason: why.slice(0, REASON_MAX) });
  return true;
}
