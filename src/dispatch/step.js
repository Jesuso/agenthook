// A `pipeline` job's run, up to the agent's exit: fetch, the epic/routing/manual/blocker/
// overlap gates, worktree, prompt, and the spawn. finish.js takes it from there.
import { summarizeDescription } from "../ticket-summary.js";
import fs from "node:fs";
import path from "node:path";
import { stepPrompt } from "../prompts.js";
import { newNonce } from "../untrusted.js";
import { findStep, DEFAULT_MAX_MINUTES } from "../pipeline.js";
import { ensureWorktree, drainWorktree, worktreePath } from "../worktree.js";
import { reportMoveFailure } from "../events.js";
import { findBlocker } from "../overlap.js";
import { agentFor } from "../agents/index.js";
import { isSandboxed } from "../sandbox/names.js";
import { egressPolicy, egressRules } from "../sandbox/egress.js";
import { agentSpawnEnv } from "./spawn.js";
import { trustedGitDirs, gitSandboxEnv, mergeGitConfigEnv, hostGitFacts, inferredForgeEgressHosts, sandboxMounts, checkoutMasks } from "./sandbox.js";
import { descriptionHasHeadings, resolveModelEffort, promptPathFor, readInstructions } from "./prompt.js";

/** @param {import('./context.js').DispatchState & import('./routing.js').Routing & import('./spawn.js').Spawn & import('./usage.js').Usage & import('./finish.js').Finish} ctx */
export function createStep(ctx) {
  const { cfg, adapter, store, emit, releaseOverlap, meta, forge, pids, cancelled, preSpawn, sandbox } = ctx;
  const { resolveRoute, leavePipeline, recordPr } = ctx;
  const { killNow, spawnAgent, logPathFor, verdictPathFor, sandboxVerdictPathFor, promptFilePathFor, runCredsDirFor, runCredentials, logLine, agentPreflight } = ctx;
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
      // The stage itself is agenthook's handoff, not done (ADR 0008). The board's own flag is
      // read here because some trackers never deliver it (GitHub Projects v2) or have none (local).
      if (task.completed) emit?.("board_done", job.ref, step.id, { via: "flag", name: task.name, url: task.url });
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
    // crashed prior run can't leave a verdict the agent didn't write this time. A sandboxed
    // run gets its own dir — the only part of the state dir its container sees.
    const sandboxed = !!sandbox && isSandboxed(cfg, step);
    const verdictFile = sandboxed ? sandboxVerdictPathFor(step.id, job.ref) : verdictPathFor(step.id, job.ref);
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
      language: cfg.language,
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
    const agentEnv = agent.env?.({ cfg, step });
    const spawnEnv = agentSpawnEnv({ cfg, agent, meta, forge, agentEnv, env: step.env });
    // A failed preflight resolves the run as `fail` with no agent spawned.
    let refused = agentPreflight(agent, step, provider, logPath, { sandboxed, env: spawnEnv });
    // Per-run credentials (#474): the forge's, else the tracker's. One that should have scoped
    // and couldn't refuses the run exactly like a preflight — never the operator's token instead.
    /** @type {import('../types.js').RunCredentials|null} */
    let creds = null;
    if (!refused) {
      const got = await runCredentials({ ref: job.ref, step, task, repoPath: repo.path, dir: runCredsDirFor(step.id, job.ref), log: (line) => logLine(logPath, line) });
      creds = got.creds;
      refused = got.refused;
      if (creds) logLine(logPath, creds.label);
    }
    /** @type {Parameters<typeof spawnAgent>[0]['sandboxed']} */
    let sandboxedRun;
    if (sandboxed && sandbox && agent.sandbox && !refused) {
      try {
        const own = agent.sandbox({ cfg, step, cwd, ownsCwd: hasWorktree, home: sandbox.describe().home });
        // The per-run GH_CONFIG_DIR (#474) is mounted read-only next to the agent's own mounts:
        // a refresh rewrites hosts.yml with an atomic rename, which the container sees because
        // the mount is the directory, not the file.
        const mounts = sandboxMounts({ cwd, hasWorktree, verdictDir: path.dirname(verdictFile), gitCommonDir: trustedGitDirs(repo.path, cwd).commonDir, agentMounts: own.mounts, credsMount: creds?.env?.GH_CONFIG_DIR, masks: hasWorktree ? [] : checkoutMasks(cwd, { extra: [cfg.configPath, cfg.configPath && path.join(path.dirname(cfg.configPath), ".env")] }) });
        const facts = hostGitFacts(repo.path);
        // When creds already supplies github.com's credential helper and insteadOf rewrite
        // (runGitEnv, under GH_CONFIG_DIR), skip gitSandboxEnv's own copy of those pairs —
        // mergeGitConfigEnv re-indexes what's left (safe.directory, author identity) after it.
        const gitEnv = mergeGitConfigEnv(creds?.env, gitSandboxEnv({ originUrl: facts.originUrl, forgeType: cfg.forge?.type, forgeBaseUrl: cfg.forge?.baseUrl, author: facts.author, skipHostAuth: !!creds }));
        // The network policy: the hosts come from the adapters dispatch holds, never from src/sandbox/.
        const policy = egressPolicy(cfg, step);
        const rules = policy.mode === "allowlist"
          ? egressRules({ agentHosts: agent.egressHosts?.(spawnEnv) ?? [], trackerHosts: meta?.egressHosts ?? [], forgeHosts: forge ? (forge.describe?.().egressHosts ?? []) : inferredForgeEgressHosts(facts.originUrl), originUrl: facts.originUrl, allow: policy.allow, deny: policy.deny })
          : [];
        sandboxedRun = { ref: job.ref, stepId: step.id, step, mounts, env: { ...(own.env ?? {}), ...gitEnv }, egress: { mode: policy.mode, rules } };
      } catch (e) {
        refused = `sandbox setup failed: ${e.message}`;
        try {
          fs.appendFileSync(logPath, `[agenthook] ${refused}\n`);
        } catch {
          /* best effort */
        }
      }
    }
    // Energy (#396): only an opted-in step that actually spawns is sampled.
    const energyRun = !refused && step.energy === true && cfg.energy ? startEnergy(job.ref, step.id, startedAt, logPath) : null;
    /** @type {Awaited<ReturnType<typeof spawnAgent>>} */
    let spawned;
    try {
      spawned = refused ? { code: 1, result: null, quota: null, timedOut: undefined } : await spawnAgent({
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
        allow: step.allow,
        deny: step.deny,
        bin: step.bin,
        agentEnv,
        creds,
        env: step.env,
        verdictFile,
        sandboxed: sandboxedRun,
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
    } finally {
      // The run has settled (exit, timeout or cancel kill, spawn error): stop refreshing and revoke.
      try {
        await creds?.dispose();
      } catch (e) {
        console.error(`[run] run credentials dispose failed for ${job.ref}:`, e.message);
      }
    }
    const { code, result, quota, timedOut, sandboxReport } = spawned;
    refused ??= /** @type {{refused?: string}} */ (spawned).refused;
    return finishStep(job, { step, task, repo, hasWorktree, verdictFile, findings, logPath, model, startedAt, maxMinutes, agent, refused, agentEnv, energyRun, code, result, quota, timedOut, sandboxed, sandboxReport });
  }

  return { runStep };
}
