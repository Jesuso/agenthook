// A `pipeline` job's run, up to the agent's exit: fetch, the epic/routing/manual/blocker/
// overlap gates, worktree, prompt, and the spawn. finish.js takes it from there.
import { summarizeDescription } from "../ticket-summary.js";
import fs from "node:fs";
import { stepPrompt } from "../prompts.js";
import { newNonce } from "../untrusted.js";
import { findStep, DEFAULT_MAX_MINUTES } from "../pipeline.js";
import { ensureWorktree, drainWorktree, worktreePath } from "../worktree.js";
import { reportMoveFailure } from "../events.js";
import { findBlocker } from "../overlap.js";
import { agentFor } from "../agents/index.js";
import { descriptionHasHeadings, resolveModelEffort, promptPathFor, readInstructions } from "./prompt.js";

/** @param {import('./context.js').DispatchState & import('./routing.js').Routing & import('./spawn.js').Spawn & import('./usage.js').Usage & import('./finish.js').Finish} ctx */
export function createStep(ctx) {
  const { cfg, adapter, store, emit, releaseOverlap, meta, pids, cancelled, preSpawn } = ctx;
  const { resolveRoute, leavePipeline, recordPr } = ctx;
  const { killNow, spawnAgent, logPathFor, verdictPathFor, promptFilePathFor, agentPreflight } = ctx;
  const { startEnergy, stopEnergy, finishStep } = ctx;

  /** @param {import('../types.js').Job} job */
  async function runStep(job) {
    const step = findStep(cfg, job.stepId);
    if (!step) throw new Error(`unknown pipeline step "${job.stepId}"`);
    const task = await adapter.fetchTask(job.ref);
    // An epic is a tracker item, never a ticket: no agent may ever run on it (CONTEXT.md,
    // ADR 0003). Fail closed before any state mutation — no worktree, no spawn, no advance.
    if (task.isEpic) {
      console.log(`[epic] skip ${step.id} ${job.ref} — epics never run an agent`);
      emit?.("epic_skipped", job.ref, step.id, { name: task.name, url: task.url });
      return { kind: job.kind, ref: job.ref, name: task.name, url: task.url, code: 0 };
    }
    // Durable display metadata for `ah agents`/`status`/`events` (survives run exit).
    store?.setRefMeta(job.ref, {
      displayId: task.displayId,
      title: task.name,
      url: task.url,
      summary: summarizeDescription(task.description),
      epic: task.epic ? { ref: task.epic.ref, name: task.epic.name, url: task.epic.url } : null,
    });

    // Which checkout this ref works in. Ambiguous or unmatched routing never guesses: park
    // the task in the hold lane (no agent, no attempt) so a human fixes the routing field;
    // the owner's `@agent` reply then re-runs the step. Before the manual branch — its
    // drain needs the repo too.
    const routed = resolveRoute(job.ref, task);
    if (!("repo" in routed)) {
      console.log(`[route] ${step.id} ${job.ref} -> hold (${routed.message})`);
      emit?.("blocked", job.ref, step.id, { reason: routed.message, name: task.name, url: task.url });
      if (!step.manual) store?.setHeld(job.ref, { stepId: step.id, reason: routed.message, heldAt: new Date().toISOString() });
      try {
        await adapter.advance(job.ref, step.id, { outcome: "hold", reason: routed.message });
      } catch (e) {
        console.error(`[advance] ${step.id} ${job.ref} (hold) failed:`, e.message);
        reportMoveFailure(emit, job.ref, step.id, "hold", e);
      }
      return { kind: job.kind, ref: job.ref, name: task.name, url: task.url, code: 0 };
    }
    const repo = routed.repo;

    // Manual stage (e.g. "done"): no agent — entering it only runs system actions.
    if (step.manual) {
      if (step.drainWorktree) {
        try {
          if (drainWorktree(cfg, job.ref, repo)) console.log(`[worktree] drained ${job.ref} (${step.id})`);
        } catch (e) {
          console.error(`[worktree] drain failed for ${job.ref}:`, e.message);
        }
        store?.clearAttempts(job.ref);
        store?.clearFindings(job.ref);
        store?.clearDifficulty(job.ref); // task is done — reset its per-ref state
        store?.clearRepo(job.ref);
        store?.clearHeld(job.ref);
        leavePipeline(job.ref);
        emit?.("pipeline_done", job.ref, step.id, { name: task.name, url: task.url });
      }
      return { kind: job.kind, ref: job.ref, name: task.name, url: task.url, code: 0 };
    }

    // Re-check the block gate at dispatch time: a job that waited in the local queue
    // (slots busy, boot-restored queue.json, an overlap release) skips the webhook-time
    // gate entirely, so a dependency added while it waited would otherwise still run. An
    // owner's `@agent` resume bypasses this — they already decided to re-run the step.
    if (adapter.openBlockers && !job.dedupKey?.startsWith("trigger:")) {
      /** @type {string[]} */
      let blockers = [];
      try {
        blockers = await adapter.openBlockers(job.ref);
      } catch (err) {
        console.warn(`[blocked] openBlockers failed for ${job.ref}, failing open: ${err.message}`);
      }
      if (blockers.length) {
        console.log(`[blocked] ${job.ref} blocked by ${blockers.join(", ")} — resting (dispatch)`);
        return { kind: job.kind, ref: job.ref, name: task.name, url: task.url, code: 0 };
      }
    }

    let tookLock = false;
    if (cfg.overlapGuard && store) {
      // A release re-enters here with no tracker event behind it: fail-closed on the
      // assignee (a task reassigned — or finished — while it waited must never fire).
      if (job.dedupKey?.startsWith("overlap:") && (!task.assignedToUs || task.completed)) {
        console.log(`[assignee] skip overlap release ${job.ref}`);
        return { kind: job.kind, ref: job.ref, name: task.name, url: task.url, code: 0 };
      }
      // Gate the worktree-creating step on the file-overlap locks. A ref that already
      // holds a lock (a rework pass) is never gated — that would deadlock two refs.
      if (step.createsWorktree && !store.getLock(job.ref)) {
        const predicted = store.getPredictedPaths(job.ref) ?? [];
        const blocker = findBlocker(job.ref, predicted, store.listLocks());
        if (blocker) {
          // Rest in the source stage: no agent, no advance, no attempt bump. The
          // blocker leaving the pipeline re-intakes this step (engine releaseOverlap).
          store.setOverlap(job.ref, { stepId: step.id, blockedBy: blocker, heldAt: new Date().toISOString() });
          emit?.("overlap_held", job.ref, step.id, { blockedBy: blocker });
          console.log(`[overlap] ${job.ref} (${step.id}) waits on ${blocker} — predicted paths overlap its lock`);
          return { kind: job.kind, ref: job.ref, name: task.name, url: task.url, code: 0 };
        }
        store.clearOverlap(job.ref);
        // Take the lock now, synchronously with the check, so a sibling dispatched
        // concurrently (maxConcurrent > 1) already sees it.
        if (predicted.length) {
          store.setLock(job.ref, { paths: predicted, stepId: step.id });
          tookLock = true;
        }
      }
    }

    // Count this run before it starts — the changes-loop guard reads it post-exit.
    store?.bumpAttempt(job.ref, step.id);
    // Any re-entry (an `@agent` resume, or a human dragging the item back) consumes a
    // pending hold: the ref is no longer parked, so a later reply must not resume it.
    store?.clearHeld(job.ref);
    if (cfg.overlapGuard) store?.clearOverlap(job.ref);

    // System-owned worktree: create it on the step that declares createsWorktree,
    // otherwise reuse the one an earlier step made (same deterministic path).
    let worktree = worktreePath(cfg, job.ref, repo);
    let branch;
    if (step.createsWorktree) {
      let wt;
      try {
        wt = await ensureWorktree(cfg, job.ref, repo);
      } catch (e) {
        // No run will follow, so nothing would ever release the lock just taken.
        if (tookLock) releaseOverlap?.(job.ref);
        throw e;
      }
      worktree = wt.worktree;
      branch = wt.branch;
      console.log(`[worktree] ${wt.created ? "created" : "reuse"} ${worktree} (branch ${branch}${wt.base ? `, base ${wt.base.ref}@${wt.base.sha}` : ""})`);
    }
    const hasWorktree = fs.existsSync(worktree);
    const cwd = hasWorktree ? worktree : repo.path;

    // One verdict file per run, under the state dir. Clear any stale one first so a
    // crashed prior run can't leave a verdict the agent didn't write this time.
    const verdictFile = verdictPathFor(step.id, job.ref);
    try {
      fs.rmSync(verdictFile, { force: true });
    } catch {
      /* nothing to clear */
    }

    // Repo context (if the routed repo has an instructionsFile) goes ahead of the step's.
    const standing = [repo.instructionsFile ? readInstructions(repo.instructionsFile) : "", readInstructions(step.instructionsFile || cfg.instructionsFile)]
      .filter(Boolean)
      .join("\n\n");
    const pending = store?.getFindings(job.ref);
    const findings = pending && pending.target === step.id ? pending : undefined;
    const base = stepPrompt(task, meta, step, {
      worktree: hasWorktree ? worktree : undefined,
      branch,
      verdictFile,
      findings,
      resumeComment: job.comment,
      overlapGuard: cfg.overlapGuard,
      nonce: newNonce(),
      ...(cfg.multiRepo ? { repo: { id: repo.id, path: repo.path } } : {}),
    });
    const prompt = standing ? `${standing}\n\n=== TICKET ===\n\n${base}` : base;

    const logPath = logPathFor(step.id, job.ref);
    console.log(`[run] step ${step.id} ${job.ref} "${task.name}" -> ${logPath}`);
    // Header line: the human id + title (filename stays keyed by the ref).
    try {
      fs.writeFileSync(logPath, `# ${task.displayId ?? job.ref}  ${task.name ?? ""}\n`);
    } catch (e) {
      console.error(`[run] log header failed for ${job.ref}:`, e.message);
    }
    // Sidecar for the UI's "what the agent sees" preview (src/ui) — exact prompt bytes,
    // no front-matter; contract: filename + the `=== TICKET ===` marker above.
    try {
      fs.writeFileSync(promptPathFor(logPath), prompt, { mode: 0o600 });
    } catch (e) {
      console.error(`[run] prompt sidecar failed for ${job.ref}:`, e.message);
    }
    // A rework pass already has a branch (and maybe a PR): pick it up before spawning.
    if (hasWorktree) await recordPr(job.ref, repo);

    // Apply difficulty escalation: if a prior step (e.g. triage) stored a difficulty
    // tag and this step has a matching `escalate` key, override the base model/effort.
    const storedDifficulty = store?.getDifficulty(job.ref);
    const { model, effort } = resolveModelEffort(step, storedDifficulty, task.description);
    const liteApplied = !!step.lite && descriptionHasHeadings(task.description, step.lite.descriptionHeadings);
    if (liteApplied) {
      console.log(`[dispatch] lite step ${step.id} ref ${job.ref} (spec headings present): model=${model ?? "default"} effort=${effort ?? "default"}`);
    }
    if (storedDifficulty && step.escalate?.[storedDifficulty]) {
      console.log(`[dispatch] escalating step ${step.id} ref ${job.ref} (difficulty=${storedDifficulty}): model=${model ?? "default"} effort=${effort ?? "default"}`);
    } else {
      console.log(`[dispatch] step ${step.id} ref ${job.ref}: model=${model ?? "default"} effort=${effort ?? "default"}`);
    }

    const startedAt = new Date().toISOString();
    const baseRunning = { stepId: step.id, startedAt, worktree: cwd, model: model ?? null };
    // A new agent run means any PR state learned earlier (closed, merged) no longer stands —
    // mirrors buildRows resetting its event-derived prState on run_start.
    store?.setRefMeta(job.ref, { prState: null });
    emit?.("run_start", job.ref, step.id, { model: model ?? null, ...(liteApplied ? { lite: true } : {}), ...(task.displayId ? { displayId: task.displayId } : {}) });
    /** @type {number|undefined} */
    let pid;
    const maxMinutes = step.maxMinutes ?? DEFAULT_MAX_MINUTES;
    const agent = agentFor(cfg, step);
    const promptFile = agent.describe().promptFile ? promptFilePathFor(step.id, job.ref) : undefined;
    const provider = step.provider ?? cfg.agentProvider;
    // A failed preflight resolves the run as `fail` with no agent spawned.
    const refused = agentPreflight(agent, step, provider, logPath);
    const agentEnv = agent.env?.({ cfg, step });
    // Energy (#396): only an opted-in step that actually spawns is sampled.
    const energyRun = !refused && step.energy === true && cfg.energy ? startEnergy(job.ref, step.id, startedAt, logPath) : null;
    const { code, result, quota, timedOut } = refused ? { code: 1, result: null, quota: null, timedOut: undefined } : await spawnAgent({
      agent,
      prompt,
      cwd,
      logPath,
      promptFile,
      model,
      effort,
      provider,
      toolsets: step.toolsets,
      isolated: step.isolated,
      bin: step.bin,
      agentEnv,
      env: step.env,
      verdictFile,
      maxMs: maxMinutes * 60000,
      ...(step.idleMinutes ? { idleMs: step.idleMinutes * 60000 } : {}),
      onPid: (p) => {
        pid = p;
        if (p) pids.set(job.ref, p);
        // A cancel that landed before the agent existed (worktree/fetch phase): stop it at birth.
        preSpawn.delete(job.ref);
        if (p && cancelled.has(job.ref)) killNow(job.ref, p);
        try {
          store?.setRunning(job.ref, { ...baseRunning, pid });
        } catch (e) {
          console.error(`[dispatch] running.json write failed (continuing): ${e.message}`);
        }
      },
      // Live token tally onto the running record (throttled — per assistant/result event).
      onTally: (t) => {
        try {
          store?.setRunning(job.ref, { ...baseRunning, pid, input: t.input, output: t.output, cacheRead: t.cacheRead, cacheCreate: t.cacheCreate });
        } catch (e) {
          console.error(`[dispatch] running.json write failed (continuing): ${e.message}`);
        }
      },
    }).catch(async (e) => {
      if (energyRun) await stopEnergy(energyRun); // never leave the sampler counting a dead run
      throw e;
    });
    return finishStep(job, { step, task, repo, hasWorktree, verdictFile, findings, logPath, model, startedAt, maxMinutes, agent, refused, agentEnv, energyRun, code, result, quota, timedOut });
  }

  return { runStep };
}
