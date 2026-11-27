// A `pipeline` job's run, up to the agent's exit: fetch, the epic/routing/manual/blocker/
// overlap gates (run-gates.js), worktree, prompt, the sandbox/remote wrap (run-wrap.js), and the
// spawn/deduce/repair/gate turns (run-turns.js). finish.js takes it from there.
import fs from "node:fs";
import path from "node:path";
import { stepPrompt, formatTicketComments } from "../prompts.js";
import { newNonce } from "../untrusted.js";
import { findStep, DEFAULT_MAX_MINUTES } from "../pipeline.js";
import { preRunGates } from "./run-gates.js";
import { buildRunWrap } from "./run-wrap.js";
import { spawnOptions, deduceVerdict, repairMissingVerdict, runGateLoop } from "./run-turns.js";
import { peekVerdict } from "./verdict.js";
import { ensureWorktree, worktreePath, branchName, branchHead, remoteMergeBase } from "../worktree.js";
import { agentFor } from "../agents/index.js";
import { executorFor } from "./executor.js";
import { agentSpawnEnv } from "./spawn.js";
import { descriptionHasHeadings, resolveModelEffort, promptPathFor, readInstructions } from "./prompt.js";
import { resolveHarness } from "./harness.js";
import { resolveContextWindow, ctxOverflow } from "../models.js";
import { needsReviewedHead, currentPrHead } from "../auto-merge.js";

/** @param {import('./context.js').DispatchState & import('./routing.js').Routing & import('./spawn.js').Spawn & import('./usage.js').Usage & import('./verdict.js').VerdictOps & import('./finish.js').Finish} ctx */
export function createStep(ctx) {
  const { cfg, adapter, store, emit, releaseOverlap, meta, forge, pids, cancelled, preSpawn, sandbox, executors, executorRuns } = ctx;
  const { resolveRoute, leavePipeline, recordPr } = ctx;
  const { killNow, spawnAgent, logPathFor, promptFilePathFor, runCredsDirFor, runCredentials, logLine, agentPreflight } = ctx;
  const { startEnergy, stopEnergy, finishStep, readVerdict } = ctx;

  /** @param {import('../types/index.js').Job} job */
  async function runStep(job) {
    const step = findStep(cfg, job.stepId);
    if (!step) throw new Error(`unknown pipeline step "${job.stepId}"`);
    const task = await adapter.fetchTask(job.ref);
    const gates = await preRunGates({ cfg, store, emit, adapter, resolveRoute, leavePipeline }, job, step, task);
    if ("done" in gates) return gates.done;
    const { repo, tookLock } = gates;

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
    if (hasWorktree && !branch) branch = branchName(job.ref, cfg.branchPrefix);

    // The harness the queue picked supplies the spawn knobs the step leaves unset: every spawn
    // read below goes through `spawnStep`; id, verdict and advance stay on `step`. Resolved before
    // the executor pick and the prompt build (#682) — a later harness-aware executor needs it,
    // and the verdict path the prompt embeds comes from the executor.
    const { step: spawnStep, harness, sandboxImage } = resolveHarness(cfg, step, job.harness);

    // The executor axis (#682): which launcher this run uses — the host or the profile's
    // sandbox — picked after the harness resolves (the harness never flips it today). `sandboxed`
    // stays a plain boolean for the preflight/verdict/repair/finish checks below.
    const executor = executorFor(cfg, step, harness, executors);
    const sandboxed = executor.name === "sandbox";
    // A remote harness's run (#689, experimental): like a sandboxed run, its verdict needs the
    // untrusted-writer guard, and it never goes through the profile's own sandbox wrap.
    const remote = executor.name === "ssh";
    // One verdict file per run, under the state dir. `verdictFile` is what the AGENT sees (the
    // prompt, AGENTHOOK_VERDICT_FILE); for host/sandbox that's also the file the hub reads, but a
    // remote executor's agent-facing path lives on the worker, so `hubVerdictFile` names the local
    // copy `done()` writes back — every hub-side read/guard/clear below targets that instead.
    const { cwd, worktree: promptWorktree, verdictFile, hubVerdictFile, configDir: remoteConfigDir } = executor.paths({ stepId: step.id, ref: job.ref, worktree, hasWorktree, repoPath: repo.path });
    const localVerdictFile = hubVerdictFile ?? verdictFile;
    // Clear any stale one first so a crashed prior run can't leave a verdict the agent didn't
    // write this time. A sandboxed run gets its own dir — the only part of the state dir its
    // container sees.
    try {
      fs.rmSync(localVerdictFile, { force: true });
    } catch {
      /* nothing to clear */
    }
    // The branch's HEAD right before the agent runs, so a deduced verdict (#680) can tell a run
    // that added commits apart from one that only left the tree dirty. Always the HUB worktree
    // (`worktree`, not `cwd`): for a remote run `cwd` is the worker's own path (#690) — by the
    // time this is read after the run, the ssh executor's `done()` has already fast-forwarded
    // the hub worktree onto whatever the worker pushed back, so this sees the same thing host/
    // sandbox always did.
    const headBefore = hasWorktree ? branchHead(cfg, worktree) : null;

    const logPath = logPathFor(step.id, job.ref);
    console.log(`[run] step ${step.id} ${job.ref} "${task.name}" -> ${logPath}`);
    // Header line: the human id + title (filename stays keyed by the ref). Written before the
    // remote-prompt block below, whose fallback lines also go into the run log.
    try {
      fs.writeFileSync(logPath, `# ${task.displayId ?? job.ref}  ${task.name ?? ""}\n`);
    } catch (e) {
      console.error(`[run] log header failed for ${job.ref}:`, e.message);
    }

    // A remote (ssh) run under a non-local tracker (#826): the worker holds no tracker
    // credentials, so the prompt carries the ticket's comments (newest first, size-capped,
    // owner flagged by the adapter itself) plus the commit-only outbox contract — and the run
    // mints no per-run credentials (the runCredentials block below is skipped for remote).
    // A local tracker (meta.usesPR false) never gets this: its prompts stay as-is.
    /** @type {{outboxDir: string, comments: string, base?: {sha: string, ref: string}}|undefined} */
    let remoteCtx;
    if (remote && meta.usesPR !== false) {
      const outboxDir = `${path.posix.dirname(verdictFile)}/outbox`;
      /** @type {string} */
      let comments;
      if (typeof adapter.fetchComments === "function") {
        try {
          const fc = await adapter.fetchComments(job.ref);
          comments = formatTicketComments(fc.comments, 32 * 1024, fc.omitted);
        } catch (e) {
          comments = "comments could not be loaded; hold if you need them";
          console.error(`[dispatch] ${job.ref}: fetchComments failed for the remote prompt: ${e instanceof Error ? e.message : e}`);
        }
      } else {
        comments = "comments could not be loaded; hold if you need them";
      }
      remoteCtx = { outboxDir, comments };
      if (hasWorktree) {
        const mb = remoteMergeBase(cfg, repo, worktree);
        if (mb) {
          remoteCtx.base = mb;
          if (!mb.ref.startsWith("origin/"))
            logLine(logPath, `remote merge base: origin default not resolvable — using local ${mb.ref} (${mb.sha.slice(0, 8)})`);
        } else {
          logLine(logPath, "remote merge base unavailable — the review prompt will fall back to git log");
        }
      }
    }

    // Repo context (if the routed repo has an instructionsFile) goes ahead of the step's.
    const standing = [repo.instructionsFile ? readInstructions(repo.instructionsFile) : "", readInstructions(step.instructionsFile || cfg.instructionsFile)]
      .filter(Boolean)
      .join("\n\n");
    const pending = store?.getFindings(job.ref);
    const findings = pending && pending.target === step.id ? pending : undefined;
    const base = stepPrompt(task, meta, step, {
      worktree: promptWorktree,
      branch,
      verdictFile,
      findings,
      resumeComment: job.comment,
      overlapGuard: cfg.overlapGuard,
      language: cfg.language,
      nonce: newNonce(),
      ...(remoteCtx ? { remote: remoteCtx } : {}),
      ...(cfg.multiRepo ? { repo: { id: repo.id, path: repo.path } } : {}),
    });
    let prompt = standing ? `${standing}\n\n=== TICKET ===\n\n${base}` : base;

    // Sidecar for the UI's "what the agent sees" preview (src/ui) — the full standing + marker
    // + ticket form, even when a sandboxed run below dedupes `prompt` down to the ticket half
    // (the standing text went into the agent's instructions file instead); src/ui splits this
    // sidecar on the `=== TICKET ===` marker.
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
    const { model, effort } = resolveModelEffort(spawnStep, storedDifficulty, task.description);
    const liteApplied = !!step.lite && descriptionHasHeadings(task.description, step.lite.descriptionHeadings);
    if (liteApplied) {
      console.log(`[dispatch] lite step ${step.id} ref ${job.ref} (spec headings present): model=${model ?? "default"} effort=${effort ?? "default"}`);
    }
    if (storedDifficulty && step.escalate?.[storedDifficulty]) {
      console.log(`[dispatch] escalating step ${step.id} ref ${job.ref} (difficulty=${storedDifficulty}): model=${model ?? "default"} effort=${effort ?? "default"}`);
    } else {
      console.log(`[dispatch] step ${step.id} ref ${job.ref}${harness ? ` on ${harness}` : ""}: model=${model ?? "default"} effort=${effort ?? "default"}`);
    }

    // forge.autoMerge: the tier step's approval is pinned to the PR head it judges — read it before
    // the agent starts, so a commit the agent (or anyone) pushes during the run is not covered.
    const headSha = needsReviewedHead(cfg, step.id) ? await currentPrHead(forge, store, job.ref) : null;
    const startedAt = new Date().toISOString();
    const agent = agentFor(cfg, spawnStep);
    // The context window (#658) a live `ctx` can be measured against — resolved once, from the
    // effective (harness-merged) step, so a harness's contextTokens/opencodeConfig already apply.
    const ctxMax = resolveContextWindow({ step: spawnStep, model, agentName: agent.describe().name });
    // A remote run (#691) carries the worker host too, for `tick`/`status` — the agent itself
    // runs there, not on the hub.
    const remoteHost = executor.name === "ssh" && harness ? cfg.harnesses?.[harness]?.remote?.host : undefined;
    const baseRunning = { stepId: step.id, startedAt, worktree: cwd, model: model ?? null, harness, agent: agent.describe().name, ...(ctxMax !== null ? { ctxMax } : {}), ...(remoteHost ? { host: remoteHost } : {}) };
    // `harness` rides on run_start/run_end only for a profile that has harnesses.
    const harnessField = cfg.harnesses ? { harness } : {};
    // A new agent run means any PR state learned earlier (closed, merged) no longer stands —
    // mirrors buildRows resetting its event-derived prState on run_start.
    store?.setRefMeta(job.ref, { prState: null });
    emit?.("run_start", job.ref, step.id, { model: model ?? null, ...harnessField, ...(ctxMax !== null ? { ctxMax } : {}), ...(liteApplied ? { lite: true } : {}), ...(task.displayId ? { displayId: task.displayId } : {}) });
    /** @type {number|undefined} */
    let pid;
    const maxMinutes = step.maxMinutes ?? DEFAULT_MAX_MINUTES;
    const promptFile = agent.describe().promptFile ? promptFilePathFor(step.id, job.ref) : undefined;
    const provider = spawnStep.provider ?? cfg.agentProvider;
    const agentEnv = agent.env?.({ cfg, step: spawnStep });
    const spawnEnv = agentSpawnEnv({ cfg, agent, meta, forge, agentEnv, env: spawnStep.env });
    // A failed preflight resolves the run as `fail` with no agent spawned. Only the agent's own
    // preflight refusing is a harness health signal (`preflightDown`); the rest is config.
    const pre = agentPreflight(agent, spawnStep, provider, logPath, { sandboxed, env: spawnEnv });
    let refused = pre?.reason;
    const preflightDown = pre?.health ? pre.reason : undefined;
    // Per-run credentials (#474): the forge's, else the tracker's. One that should have scoped
    // and couldn't refuses the run exactly like a preflight — never the operator's token instead.
    /** @type {import('../types/index.js').RunCredentials|null} */
    let creds = null;
    // A remote run mints none (#826): the worker has no credentials of its own, and the
    // hub's per-run token is scoped to the hub (gh/git on it, not on the worker).
    if (!refused && !remote) {
      const got = await runCredentials({ ref: job.ref, step, task, repoPath: repo.path, dir: runCredsDirFor(step.id, job.ref), log: (line) => logLine(logPath, line) });
      creds = got.creds;
      refused = got.refused;
      if (creds) logLine(logPath, creds.label);
    } else if (remote && !refused) {
      logLine(logPath, "no per-run credentials minted — a remote run's worker holds no tracker/forge access");
    }
    // The sandbox/remote wrap (run-wrap.js): builds the box-run descriptor spawnAgent's
    // `sandboxed` option carries, and applies the #731 standing-text dedupe to `prompt` when the
    // agent's own hook already wrote the standing text into an instructions file.
    const wrapped = buildRunWrap({ sandboxed, remote, cfg, step, spawnStep, sandbox, agent, cwd, hasWorktree, verdictFile, standing, creds, repo, sandboxImage, forge, meta, spawnEnv, remoteConfigDir, base, prompt, logPath, ref: job.ref, stepId: step.id, worktree, branch, refused });
    const sandboxedRun = wrapped.sandboxedRun;
    prompt = wrapped.prompt;
    refused = wrapped.refused;
    // Energy (#396): only an opted-in step that actually spawns is sampled; a remote run's power
    // draw is the worker's, not this host's.
    const energyRun = !refused && !remote && step.energy === true && cfg.energy ? startEnergy(job.ref, step.id, startedAt, logPath) : null;
    const onPid = (/** @type {number|undefined} */ p) => {
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
    };
    // Live token tally onto the running record (throttled — per assistant/result event). Shared
    // with a verdict-repair turn below (#677) — same running record, same ref.
    let ctxOverflowWarned = false;
    const onTally = (/** @type {{input:number,output:number,cacheRead:number,cacheCreate:number,lastContext?:number}} */ t) => {
      const observed = typeof t.lastContext === "number" ? t.lastContext : null;
      if (!ctxOverflowWarned && observed !== null && ctxMax !== null && ctxOverflow(observed, ctxMax)) {
        ctxOverflowWarned = true;
        const line = `[dispatch] context window for model "${model ?? "?"}" looks wrong: observed ${observed.toLocaleString("en-US")} > ctxMax ${ctxMax.toLocaleString("en-US")} — fix src/models.js or set contextTokens`;
        try {
          logLine(logPath, line);
        } catch { /* best effort */ }
        console.warn(line);
      }
      try {
        store?.setRunning(job.ref, { ...baseRunning, pid, input: t.input, output: t.output, cacheRead: t.cacheRead, cacheCreate: t.cacheCreate, ...(typeof t.lastContext === "number" ? { ctx: t.lastContext } : {}) });
      } catch (e) {
        console.error(`[dispatch] running.json write failed (continuing): ${e.message}`);
      }
    };

    // The run context (run-turns.js): the locals the turn runners below share, built after the
    // wrap so it carries the final `prompt`/`sandboxedRun`. Replaces each runner closing over
    // ~15 of runStep's own locals with one object.
    /** @type {import('./run-turns.js').RunContext} */
    const rc = { step, spawnStep, job, cfg, agent, executor, sandboxed, sandboxedRun, localVerdictFile, verdictFile, hasWorktree, headBefore, worktree, cwd, logPath, promptFile, model, effort, provider, agentEnv, creds, maxMinutes, startedAt, prompt, onPid, onTally, meta, forge, store, emit, cancelled, readVerdict, spawnAgent, pids, executorRuns, logLine };

    /** @type {Awaited<ReturnType<typeof spawnAgent>>} */
    let spawned;
    /** @type {{turns: number, repaired: boolean, results: any[], turnStats: any[]}|undefined} */
    let repair;
    /** @type {{commits: number}|undefined} */
    let deduced;
    /** @type {{result: "pass"|"fail", capExhausted?: boolean, reason?: string, results: any[], turnStats: any[]}|undefined} */
    let gate;
    try {
      spawned = refused ? { code: 1, result: null, quota: null, timedOut: undefined } : await spawnAgent(spawnOptions(rc, { prompt, maxMs: maxMinutes * 60000 })).catch(async (e) => {
        if (energyRun) await stopEnergy(energyRun); // never leave the sampler counting a dead run
        throw e;
      });
      if (!refused) {
        deduced = deduceVerdict(rc, spawned);
        if (!deduced) {
          const r = await repairMissingVerdict(rc, spawned);
          if (r) {
            repair = { turns: r.turns, repaired: r.repaired, results: r.results, turnStats: r.turnStats };
            // The final repair turn's code/timedOut/lastText become the run's (finishStep resolves
            // the verdict/health from these); the harness-health signals below stay the first run's.
            // sandboxReport also comes from the repair turn (#690: its own sync-back, not the
            // first turn's) — a refusal there must still fail the run, not get dropped silently.
            spawned = { ...spawned, code: r.final.code, timedOut: r.final.timedOut, lastText: r.final.lastText ?? spawned.lastText, sandboxReport: r.final.sandboxReport ?? spawned.sandboxReport, ...(r.final.spawnError ? { spawnError: r.final.spawnError } : {}) };
          }
        }
        // The gate (#710): only for a clean exit whose effective verdict is "advance" (agent's
        // own, repaired, deduced, or the requireVerdict:false assumed-advance — readVerdict
        // already covers all four). A hold/fail/changes/missing-verdict never reaches this.
        if (step.gate) {
          const cleanExit = spawned.code === 0 && !spawned.timedOut && !spawned.spawnError && !cancelled.has(job.ref) && !spawned.sandboxReport?.failed;
          if (cleanExit) {
            const peeked = peekVerdict(rc, spawned.code);
            if (deduced || peeked.outcome === "advance") {
              let sessionId = typeof spawned.result?.session_id === "string" ? spawned.result.session_id : undefined;
              if (repair?.results?.length) {
                const lastR = repair.results[repair.results.length - 1];
                if (typeof lastR.result?.session_id === "string") sessionId = lastR.result.session_id;
              }
              const g = await runGateLoop(rc, spawned, sessionId, deduced);
              gate = { ...g.gate, results: g.results, turnStats: g.turnStats };
              spawned = { ...spawned, code: g.final.code, timedOut: g.final.timedOut, lastText: g.final.lastText ?? spawned.lastText, sandboxReport: g.final.sandboxReport ?? spawned.sandboxReport, ...(g.final.spawnError ? { spawnError: g.final.spawnError } : {}) };
            }
          }
        }
      }
    } finally {
      // The run has settled (exit, timeout or cancel kill, spawn error): stop refreshing and revoke.
      try {
        await creds?.dispose();
      } catch (e) {
        console.error(`[run] run credentials dispose failed for ${job.ref}:`, e.message);
      }
    }
    const { code, result, quota, turnStats, timedOut, sandboxReport, spawnError, unreachable, sshConfigFailure, noOutput, apiDown, errorLine, lastText } = spawned;
    refused ??= /** @type {{refused?: string}} */ (spawned).refused;
    // A remote run (#690) whose agent exited clean but whose sync-back was refused (non-ff, or a
    // merge it would have overwritten): fail the run rather than advance on code the hub never
    // actually received.
    refused ??= sandboxReport?.failed;
    // Pacing (finish.js): a remote run's subscription-quota reading is the worker's, not paced
    // by this hub (#689). `sandboxed` here also covers a remote run — its verdict needs the same
    // untrusted-writer guard finish.js applies before trusting a container's.
    return finishStep(job, { step, spawnStep, harnessField, task, repo, hasWorktree, cwd: remote ? cwd : undefined, verdictFile: localVerdictFile, findings, logPath, model, startedAt, maxMinutes, agent, refused, preflightDown, spawnError, unreachable, sshConfigFailure, noOutput, apiDown, errorLine, agentEnv, energyRun, code, result, quota: remote ? null : quota, turnStats, timedOut, sandboxed: executor.name !== "host", remote, hubWorktree: hasWorktree ? worktree : undefined, branch, sandboxReport, headSha, lastText, repair, deduced, gate });
  }

  return { runStep };
}
