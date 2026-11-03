// Auto-merge on review approval (opt-in `forge.autoMerge`). When the approving step (the
// pipeline's last review-kind step, or `autoMerge.step`) finishes with `advance` and its verdict's
// `summary.tier` is in `autoMerge.tiers`, the receiver asks the forge to mark the agent PR ready
// (if draft) and enable auto-merge, so GitHub merges it once its required checks pass.
// Best-effort by design: a refusal (repo setting, permissions, network) is logged and emitted as
// `auto_merge_failed`; it never changes the verdict, the board move or the step's result.
// Import-free, so config.js can take `autoMergeErrors` without pulling in dispatch.

export const AUTO_MERGE_METHODS = /** @type {const} */ (["squash", "merge", "rebase"]);

/** Clip for the `reason` of an `auto_merge_failed` event. */
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
  if (am.step != null && (typeof am.step !== "string" || !am.step.trim())) {
    errors.push(`config: forge.autoMerge.step must be a pipeline step id.`);
  } else if (Array.isArray(pipeline)) {
    const id = autoMergeStepId(pipeline, am);
    const step = id ? pipeline.find((s) => s && typeof s === "object" && s.id === id) : null;
    if (!id) errors.push(`config: forge.autoMerge needs a review step: add "kind": "review" to one, or set forge.autoMerge.step.`);
    else if (!step) errors.push(`config: forge.autoMerge.step ${JSON.stringify(id)} is not a pipeline step id.`);
    else if (step.manual) errors.push(`config: forge.autoMerge.step ${JSON.stringify(id)} is a manual step (no agent writes a verdict there).`);
  }
  return errors;
}

/**
 * Should this finished run auto-merge its PR? Only a configured block, the approving step, an
 * `advance`, and a `summary.tier` in the allow-list (compared trimmed, case-insensitive). Pure.
 * @param {import('./types.js').Config} cfg @param {string} stepId @param {import('./types.js').Verdict} verdict
 * @returns {{tier: string, method: 'squash'|'merge'|'rebase'}|null}
 */
export function autoMergeDecision(cfg, stepId, verdict) {
  const am = cfg.forge?.autoMerge;
  if (!am || !Array.isArray(am.tiers)) return null;
  if (verdict.outcome !== "advance") return null;
  if (stepId !== autoMergeStepId(cfg.pipeline, am)) return null;
  const raw = verdict.summary?.tier;
  if (typeof raw !== "string" || !raw.trim()) return null;
  const tier = raw.trim().toLowerCase();
  if (!am.tiers.some((t) => String(t).trim().toLowerCase() === tier)) return null;
  return { tier, method: am.method ?? "squash" };
}

/**
 * Run auto-merge for a run that `autoMergeDecision` approved. Never throws: every failure
 * becomes one log line + an `auto_merge_failed` event, and the PR is left as it was.
 * @param {{
 *   forge: import('./types.js').Forge|null|undefined,
 *   store?: import('./types.js').Store,
 *   emit?: (event: string, ref: string, step: string, extra?: Record<string, any>) => void,
 * }} deps
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
    const known = store?.getRefMeta(ref)?.pr;
    pr = await forge.prHead(Number.isInteger(known) && known ? /** @type {number} */ (known) : null, ref);
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
