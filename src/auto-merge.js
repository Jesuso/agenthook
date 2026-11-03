// Auto-merge on approval (opt-in `forge.autoMerge`). When the approving step (`autoMerge.step`, or
// the pipeline's last review-kind step) finishes with `advance` and the risk tier — its own
// verdict's `summary.tier`, or the stored summary of `autoMerge.tierFrom` — is in
// `autoMerge.tiers`, the receiver asks the forge to mark the agent PR ready (if draft) and enable
// auto-merge, so GitHub merges it once its required checks pass — pinned to the PR head the
// tier step saw when it started (`expectedHeadOid`), so only reviewed commits can merge.
// Auto-merge comes off again while the PR is open when the task goes back (`changes`/`fail`
// from any path, or a red-CI bounce) or when a new commit lands on the PR after approval (the
// forge's `pull_request` synchronize webhook → `onPrPush`). A bounce whose disable fails is held
// instead of firing the rework.
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
 * @param {unknown} [repos]  the raw `repos` block (multi-repo routing)
 * @returns {string[]}
 */
export function autoMergeErrors(forge, pipeline, repos) {
  const am = forge?.autoMerge;
  if (am == null) return [];
  if (typeof am !== "object" || Array.isArray(am)) return [`config: "forge.autoMerge" must be an object ({ "tiers": ["low"], "method": "squash" }).`];
  /** @type {string[]} */
  const errors = [];
  if (forge.type !== "github") errors.push(`config: "forge.autoMerge" is only supported on the github forge.`);
  if (Array.isArray(repos) && repos.length > 1) errors.push(`config: "forge.autoMerge" does not support multi-repo routing yet (the forge only sees forge.repository); remove one or the other.`);
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
  // The tier must come from a step that judges the code: strictly after the step that creates the
  // worktree (when there is one). Earlier (triage) approves code nobody looked at; that step itself
  // writes the code, so the PR head recorded at its start is never the commit it produced.
  const tierId = autoMergeTierStepId(pipeline, am);
  const ti = tierId ? pipeline.findIndex((s) => s && typeof s === "object" && s.id === tierId) : -1;
  const wi = pipeline.findIndex((s) => s && typeof s === "object" && s.createsWorktree);
  if (ti >= 0 && wi >= 0 && ti <= wi) {
    errors.push(`config: forge.autoMerge takes its tier from ${JSON.stringify(tierId)}, which ${ti === wi ? "writes" : `runs before ${JSON.stringify(pipeline[wi].id)} writes`} the code; take it from a later step that judges it (tierFrom/step).`);
  }
  return errors;
}

/**
 * Should this finished run auto-merge its PR? Pure.
 * - `null`: not applicable — no block, not the approving step, or not an `advance`.
 * - `{skipped, tier?}`: the approving step advanced but the tier does not allow it (missing, outside
 *   `tiers`, or the `tierFrom` step has no approving verdict stored). Reported, never merged.
 * - `{tier, method, sha, from}`: go, pinned to `sha` — the PR head the tier step saw when it started.
 *   Tiers compare trimmed, case-insensitive. No recorded head → skipped (fail closed).
 * @param {import('./types.js').Config} cfg @param {string} stepId @param {import('./types.js').Verdict} verdict
 * @param {Record<string, import('./types.js').SummaryRecord>|undefined} [summaries]  the ref's stored step summaries (for `tierFrom`)
 * @param {string|null} [runHeadSha]  the PR head this run (the approving step) saw at its start
 * @returns {AutoMergeGo|{skipped: string, tier?: string}|null}
 */
export function autoMergeDecision(cfg, stepId, verdict, summaries, runHeadSha) {
  const am = cfg.forge?.autoMerge;
  if (!am || !Array.isArray(am.tiers)) return null;
  if (verdict.outcome !== "advance") return null;
  if (stepId !== autoMergeStepId(cfg.pipeline, am)) return null;
  const from = autoMergeTierStepId(cfg.pipeline, am) ?? stepId;
  let raw;
  /** @type {string|null|undefined} */
  let sha;
  if (from === stepId) {
    raw = verdict.summary?.tier;
    sha = runHeadSha;
  } else {
    const rec = summaries?.[from];
    if (!rec || rec.outcome !== "advance") return { skipped: `step "${from}" (tierFrom) has no approving verdict stored` };
    raw = /** @type {any} */ (rec.summary)?.tier;
    sha = rec.headSha;
  }
  if (typeof raw !== "string" || !raw.trim()) return { skipped: `no summary.tier in the "${from}" verdict` };
  const tier = raw.trim().toLowerCase();
  if (!am.tiers.some((t) => String(t).trim().toLowerCase() === tier)) return { skipped: `tier "${tier}" is not in [${am.tiers.join(", ")}]`, tier };
  if (!sha) return { skipped: `no PR head recorded for the "${from}" run (no PR when it started?)`, tier };
  return { tier, method: am.method ?? "squash", sha, from };
}

/** @typedef {{tier: string, method: 'squash'|'merge'|'rebase', sha: string, from: string}} AutoMergeGo */

/**
 * Does this step's run need the PR head recorded at its start (it is the tier source)? Pure.
 * @param {import('./types.js').Config} cfg @param {string} stepId
 */
export function needsReviewedHead(cfg, stepId) {
  const am = cfg.forge?.autoMerge;
  return !!am && Array.isArray(am.tiers) && autoMergeTierStepId(cfg.pipeline, am) === stepId;
}

/**
 * The open agent PR's head SHA right now (recorded at the tier step's start). Never throws.
 * @param {import('./types.js').Forge|null|undefined} forge @param {import('./types.js').Store|undefined} store @param {string} ref
 * @returns {Promise<string|null>}
 */
export async function currentPrHead(forge, store, ref) {
  if (!forge?.prHead) return null;
  try {
    const pr = await findPr(forge, store, ref);
    return pr?.open ? pr.sha : null;
  } catch (e) {
    console.error(`[auto-merge] ${ref} PR head lookup failed: ${e.message}`);
    return null;
  }
}

// Per-ref serialization: a bounce's disable waits for an enable that is still in flight for the
// same ref (the enable runs after the board move that fires the next step, so a fast next step
// could otherwise read "off" and then the enable lands). Process-wide; keyed by ref.
/** @type {Map<string, Promise<unknown>>} */
const inflight = new Map();

/**
 * Mark an auto-merge enable as pending for `ref` until `done` settles. Call it BEFORE the move.
 * @param {string} ref @param {Promise<unknown>} done
 */
export function holdAutoMergeSlot(ref, done) {
  const p = done.catch(() => {}).finally(() => {
    if (inflight.get(ref) === p) inflight.delete(ref);
  });
  inflight.set(ref, p);
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
 * @param {AutoMergeGo} decision
 * @returns {Promise<import('./types.js').AutoMergeResult|null>}  null when it did not happen
 */
export async function runAutoMerge({ forge, store, emit }, ref, stepId, { tier, method, sha, from }) {
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
    res = await forge.enableAutoMerge(pr.number, { method, expectedSha: sha });
  } catch (e) {
    return failed(e.message, pr.number);
  }
  if (res.status === "moved") {
    reportAutoMergeSkipped({ forge, store, emit }, ref, stepId, { skipped: `PR head moved since "${from}" saw it (${sha.slice(0, 7)} → ${String(res.headSha ?? "?").slice(0, 7)})`, tier });
    return res;
  }
  if (res.status === "enabled" || res.status === "already") store?.setRefMeta(ref, { autoMerge: { sha, pr: pr.number, step: stepId, at: new Date().toISOString() } });
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
 * @returns {Promise<'disabled'|'noop'|'error'>}  `error`: auto-merge may still be on — the caller
 *   must not fire a rework (finish/ci turn the bounce into a hold)
 */
export async function disableAutoMergeOnBounce({ forge, store, emit }, ref, stepId, why, prHint) {
  if (!forge?.disableAutoMerge || !forge.prHead) return "noop";
  await inflight.get(ref);
  const ours = store?.getRefMeta(ref)?.autoMerge;
  let pr;
  try {
    pr = await findPr(forge, store, ref, prHint ?? null);
    if (!pr) return "noop";
    if (!pr.open) {
      // We turned auto-merge on and the PR is gone: if it merged, the code this bounce rejects is
      // already on the base branch. Nothing to stop — say so instead of staying silent.
      if (ours && forge.prState && (await forge.prState(pr.number)) === "merged") {
        console.log(`[auto-merge] ${ref} PR #${pr.number} already merged — too late to stop (${why})`);
        emit?.("auto_merge_disabled", ref, stepId, { pr: pr.number, reason: why.slice(0, REASON_MAX), tooLate: true });
        store?.setRefMeta(ref, { autoMerge: null });
      }
      return "noop";
    }
    const res = await forge.disableAutoMerge(pr.number);
    if (res.status !== "disabled") {
      if (res.status === "off") store?.setRefMeta(ref, { autoMerge: null });
      return "noop";
    }
  } catch (e) {
    const r = `disable failed (${why}): ${e.message}`.slice(0, REASON_MAX);
    console.error(`[auto-merge] ${ref}${pr ? ` PR #${pr.number}` : ""} ${r}`);
    emit?.("auto_merge_failed", ref, stepId, { ...(pr ? { pr: pr.number } : {}), reason: r });
    return "error";
  }
  store?.setRefMeta(ref, { autoMerge: null });
  console.log(`[auto-merge] ${ref} PR #${pr.number}: auto-merge turned off (${why})`);
  emit?.("auto_merge_disabled", ref, stepId, { pr: pr.number, reason: why.slice(0, REASON_MAX) });
  return "disabled";
}

/**
 * The forge saw a new commit on an agent PR that has auto-merge on (`pr_push` signal job, from a
 * `pull_request` synchronize webhook). If we turned auto-merge on for an older head, turn it off:
 * the approval was for that head, not this one. Auto-merge someone else enabled is left alone.
 * Handled outside the run queue (a cheap read + at most one write). Never throws.
 * @param {AutoMergeDeps & {cfg: import('./types.js').Config}} deps
 * @returns {(job: import('./types.js').Job) => Promise<'disabled'|'noop'|'error'>}
 */
export function createPrPushGuard({ cfg, forge, store, emit }) {
  return async function onPrPush(job) {
    const push = job.push;
    if (!cfg.forge?.autoMerge || !push) return "noop";
    await inflight.get(job.ref);
    const ours = store?.getRefMeta(job.ref)?.autoMerge;
    if (!ours?.sha || ours.sha === push.headSha) return "noop";
    return disableAutoMergeOnBounce({ forge, store, emit }, job.ref, "", `new commit ${push.headSha.slice(0, 7)} after approval of ${ours.sha.slice(0, 7)}`, push.prNumber);
  };
}
