// A `pipeline` job's run after the agent exits: usage + cost, the verdict, run_end, the
// hold/difficulty/overlap/parked-CI bookkeeping, summary, drain, advance, leaving the pipeline.
import fs from "node:fs";
import path from "node:path";
import { drainWorktree } from "../worktree.js";
import { CANCELLED_REASON, reportMoveFailure } from "../events.js";
import { unionPaths } from "../overlap.js";
import { costOf } from "../pricing.js";
import { energyFields } from "../energy.js";
import { timeoutReason, NO_VALID_VERDICT } from "./verdict.js";

/** A sandboxed run's verdict file larger than this is not read (a verdict is a few hundred bytes). */
export const MAX_SANDBOX_VERDICT_BYTES = 1024 * 1024;

/**
 * runStep's locals the post-exit phase reads, handed over as one object.
 * @typedef {object} StepRun
 * @property {import('../types.js').Step} step
 * @property {import('../types.js').Task} task
 * @property {import('../types.js').RepoConfig} repo
 * @property {boolean} hasWorktree
 * @property {string} verdictFile
 * @property {{target: string, fromStep: string, text: string}|undefined} findings
 * @property {string} logPath
 * @property {string|undefined} model
 * @property {string} startedAt
 * @property {number} maxMinutes
 * @property {import('../types.js').AgentAdapter} agent
 * @property {string|undefined} refused
 * @property {Record<string, string>|undefined} agentEnv
 * @property {string|null} energyRun
 * @property {number} code
 * @property {any} result
 * @property {import('../quota.js').QuotaReading|null} quota
 * @property {"max"|"idle"|undefined} timedOut
 * @property {boolean} [sandboxed]  ran in the profile's sandbox (its verdict sits in its own per-run dir)
 * @property {import('../types.js').SandboxReport} [sandboxReport]  what the sandbox reported once the run exited
 */

/** @param {import('./context.js').DispatchState & import('./routing.js').Routing & import('./usage.js').Usage & import('./verdict.js').VerdictOps} ctx */
export function createFinish(ctx) {
  const { cfg, adapter, store, emit, opts, pids, cancelled, killTimers } = ctx;
  const { stepIndex, leavePipeline, recordPr, finalizeUsage, stopEnergy, readVerdict, guardChanges } = ctx;

  /** @param {import('../types.js').Job} job @param {StepRun} run */
  async function finishStep(job, run) {
    const { step, task, repo, hasWorktree, verdictFile, findings, logPath, model, startedAt, maxMinutes, agent, refused, agentEnv, energyRun, code, result, quota, timedOut, sandboxed, sandboxReport } = run;
    store?.clearRunning(job.ref);
    pids.delete(job.ref);
    clearTimeout(killTimers.get(job.ref)); // the child is gone: its pid may be recycled
    killTimers.delete(job.ref);
    // After the cleanup above: a `command` source can take up to its timeout to answer, and a
    // pending SIGKILL or `cancel` must not meanwhile target the exited (maybe recycled) pid.
    const energy = energyRun ? await stopEnergy(energyRun) : null;
    const wasCancelled = cancelled.delete(job.ref);
    // The subscription-quota reading the agent reported (claude only), even from a failed run.
    if (quota) {
      try {
        opts.onQuota?.({ ...quota, asOf: new Date().toISOString() });
      } catch (e) {
        console.error(`[dispatch] quota hook failed (continuing): ${e.message}`);
      }
    }
    // The step may just have opened the PR.
    await recordPr(job.ref, repo);

    // Best-effort post-exit token capture (hermes' `sessions export`, #395): only when the
    // run actually spawned and came back with a session id to export.
    const finalized = !refused && typeof result?.session_id === "string" ? await finalizeUsage(agent, { sessionId: result.session_id, bin: step.bin, agentEnv, env: step.env, stepId: step.id, ref: job.ref, logPath }) : null;

    // Persist the final per-run usage record from the captured result (token totals +
    // cost). Append-only usage.jsonl, distinct from the rewritten state files. The adapter
    // decides `unpriced` (e.g. a local-model run — step `bin`, or a non-Claude model — whose
    // dollar figure is made up), so run_end drops the cost and the usage record is tagged.
    // Built even without a result: `unpriced` must still reach run_end.
    const usage = agent.usageRecord(result, { ref: job.ref, stepId: step.id, model, bin: step.bin, claudeBin: cfg.claudeBin, startedAt, endedAt: new Date().toISOString() });
    if (finalized) {
      for (const k of /** @type {const} */ (["input", "output", "cacheRead", "cacheCreate"])) {
        if (typeof finalized[k] === "number" && Number.isFinite(finalized[k]) && finalized[k] >= 0) usage[k] = finalized[k];
      }
      // Only overlay the model when the step resolved none of its own — the record's model
      // is still the adapter's unpriced placeholder (hermes: "hermes"), which the rate table
      // can't match.
      if (finalized.model && !model) usage.model = finalized.model;
    }
    const unpriced = !!usage.unpriced;
    // Stamp the basis (src/pricing.js): a reported run keeps `costUsd` alone; otherwise an
    // API-equivalent `estUsd` from the rate table, when the model has a rate and tokens.
    const priced = costOf(usage, cfg.pricing);
    if (priced.estUsd !== undefined) usage.estUsd = priced.estUsd;
    if (priced.costBasis) usage.costBasis = priced.costBasis;
    // A third, independent figure — never folded into costUsd/estUsd/costBasis.
    const energyRec = energy && cfg.energy ? energyFields(energy.kWh, cfg.energy.usdPerKwh, cfg.energy.source.type) : null;
    if (energyRec) Object.assign(usage, energyRec);
    if (store && result) store.recordUsage(usage);

    // A sandboxed agent owns its verdict dir, and the host reads the file synchronously: only a
    // small regular file is read. A symlink would route on a file outside the dir, a FIFO would
    // block the event loop on open (the whole receiver), a huge file would be slurped — each is
    // removed and treated as no verdict.
    if (sandboxed) {
      try {
        const st = fs.lstatSync(verdictFile);
        if (!st.isFile() || st.size > MAX_SANDBOX_VERDICT_BYTES) fs.rmSync(verdictFile, { force: true });
      } catch {
        /* no verdict written */
      }
    }
    // Resolve the verdict from the exit code + the file the agent wrote. A killed run
    // always fails — a verdict file it half-wrote before the kill is not trusted.
    /** @type {import('../types.js').Verdict} */
    const verdict = refused
      ? { outcome: "fail", reason: refused }
      : wasCancelled
      ? { outcome: "fail", reason: CANCELLED_REASON }
      : timedOut
      ? { outcome: "fail", reason: timeoutReason(timedOut, timedOut === "max" ? maxMinutes : (step.idleMinutes ?? 0)) }
      : readVerdict(code, verdictFile, step, agent);
    try {
      fs.rmSync(sandboxed ? path.dirname(verdictFile) : verdictFile, { recursive: true, force: true });
    } catch {
      /* best effort */
    }

    const costUsd = unpriced ? undefined : usage.costUsd;
    // Model + tokens ride along when a result was seen, so Stats can price from events.jsonl alone.
    const tokens = result ? { ...(usage.model ? { model: usage.model } : {}), input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheCreate: usage.cacheCreate } : {};
    emit?.("run_end", job.ref, step.id, {
      outcome: verdict.outcome,
      ...(costUsd !== undefined ? { costUsd } : {}),
      ...(unpriced ? { unpriced: true } : {}),
      ...(usage.costBasis ? { costBasis: usage.costBasis } : {}),
      ...(usage.estUsd !== undefined ? { estUsd: usage.estUsd } : {}),
      ...(energyRec ?? {}),
      ...tokens,
      ...(sandboxReport?.extra ?? {}),
    });
    const missingVerdict = verdict.outcome === "hold" && verdict.reason === NO_VALID_VERDICT;
    if (verdict.outcome === "hold") {
      if (missingVerdict) emit?.("verdict_missing", job.ref, step.id, { reason: verdict.reason });
      // Park it: an owner's `@agent` reply on the item resumes THIS step (see the
      // adapters' comment trigger), with the reply appended to the prompt.
      store?.setHeld(job.ref, { stepId: step.id, ...(verdict.reason ? { reason: verdict.reason } : {}), heldAt: new Date().toISOString() });
    }

    // Findings were delivered in this run's prompt — consume them whatever the outcome.
    if (findings) store?.clearFindings(job.ref);

    // Persist a difficulty tag emitted by this step (typically triage) so later steps
    // (e.g. code) can gate their model/effort on it.
    if (verdict.difficulty && store) {
      store.setDifficulty(job.ref, verdict.difficulty);
      console.log(`[dispatch] stored difficulty=${verdict.difficulty} for ref ${job.ref}`);
    }

    // overlapGuard: a no-worktree step (triage) predicts paths; a worktree step's touched
    // paths grow the ref's lock (union — never narrowed while its PR is unmerged).
    if (cfg.overlapGuard && store && verdict.paths) {
      if (!hasWorktree) {
        store.setPredictedPaths(job.ref, verdict.paths);
      } else {
        const cur = store.getLock(job.ref);
        store.setLock(job.ref, { paths: unionPaths(cur?.paths ?? [], verdict.paths), stepId: step.id });
      }
    }

    // A red-CI bounce parked while this run was in flight: a downstream step's clean
    // `advance` becomes `changes` → the CI target (the guard below still caps it). Any
    // other case drops it — the target itself is reworking, or the verdict already takes
    // the task off the happy path (changes/fail/hold stand).
    const parked = store?.takeCiRed(job.ref);
    const ciBounce = !!parked && verdict.outcome === "advance" && stepIndex(step.id) > stepIndex(parked.target);
    if (parked && ciBounce) {
      Object.assign(verdict, { outcome: "changes", target: parked.target, reason: parked.text, findings: parked.text });
    } else if (parked) {
      console.log(`[ci] drop parked bounce for ${job.ref} (${step.id} -> ${verdict.outcome})`);
    }

    guardChanges(job.ref, step.id, verdict, ciBounce ? "ci" : step.id);
    if (ciBounce && verdict.outcome === "changes") emit?.("ci_red", job.ref, step.id, { action: "bounced", target: verdict.target });

    // The step's supervisor summary, with the outcome actually applied. A run without one
    // drops the step's earlier summary, so a stale one never outlives a re-run.
    if (store) {
      if (verdict.summary) {
        store.setSummary(job.ref, step.id, { summary: verdict.summary, outcome: verdict.outcome, run: path.basename(logPath), at: new Date().toISOString() });
      } else {
        store.clearSummary(job.ref, step.id);
      }
    }

    // Drain before advancing, so the worktree is gone by the time the next stage looks.
    // A `changes` keeps the worktree (the re-fired step reworks the same branch/PR).
    const drained = step.drainWorktree && verdict.outcome !== "changes";
    if (drained) {
      try {
        if (drainWorktree(cfg, job.ref, repo)) console.log(`[worktree] drained ${job.ref} (${step.id})`);
      } catch (e) {
        console.error(`[worktree] drain failed for ${job.ref}:`, e.message);
      }
    }

    // Emitted after the changes guard so a forced fail (cap / no target) is reported too.
    if (verdict.outcome === "hold" || verdict.outcome === "fail") {
      emit?.(verdict.outcome === "hold" ? "blocked" : "failed", job.ref, step.id, {
        reason: verdict.reason ?? null,
        name: task.name,
        url: task.url,
      });
    }

    // The move to the next section is itself the event that fires the next step.
    console.log(
      missingVerdict
        ? `[verdict] ${step.id} ${job.ref} -> hold (no valid verdict — set requireVerdict:false to advance on a clean exit)`
        : `[verdict] ${step.id} ${job.ref} -> ${verdict.outcome}${verdict.reason ? ` (${verdict.reason})` : ""}`
    );
    try {
      await adapter.advance(job.ref, step.id, verdict);
    } catch (e) {
      console.error(`[advance] ${step.id} ${job.ref} (${verdict.outcome}) failed:`, e.message);
      reportMoveFailure(emit, job.ref, step.id, verdict.outcome, e);
    }

    // Reset loop counters and difficulty when the task leaves the pipeline: a terminal
    // `fail` or a drained worktree (done). mid-pipeline hold/advance keeps them so a
    // later `changes` still counts against the cap and difficulty stays available.
    if (verdict.outcome === "fail" || drained) {
      store?.clearAttempts(job.ref);
      store?.clearDifficulty(job.ref);
      store?.clearRepo(job.ref);
      store?.clearHeld(job.ref);
      store?.clearFindings(job.ref);
      leavePipeline(job.ref);
    }
    // Summaries end on a terminal fail only — a drained `advance` (done) still has an open PR.
    if (verdict.outcome === "fail") store?.clearSummaries(job.ref);

    return { kind: job.kind, ref: job.ref, name: task.name, url: task.url, code };
  }

  return { finishStep };
}

/** @typedef {ReturnType<typeof createFinish>} Finish */
