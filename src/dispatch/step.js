// A `pipeline` job's run, up to the agent's exit: fetch, the epic/routing/manual/blocker/
// overlap gates, worktree, prompt, and the spawn. finish.js takes it from there.
import { summarizeDescription } from "../ticket-summary.js";
import fs from "node:fs";
import path from "node:path";
import { stepPrompt, verdictRepairPrompt, gateRepairPrompt } from "../prompts.js";
import { guardSandboxVerdict, endedWithQuestion, NO_VALID_VERDICT } from "./verdict.js";
import { newNonce } from "../untrusted.js";
import { findStep, stepForStage, DEFAULT_MAX_MINUTES, DEFAULT_MAX_ATTEMPTS } from "../pipeline.js";
import { runGate } from "./gate.js";
import { ensureWorktree, drainWorktree, worktreePath, branchName, branchHead, commitsSince } from "../worktree.js";
import { reportMoveFailure } from "../events.js";
import { findBlocker } from "../overlap.js";
import { agentFor } from "../agents/index.js";
import { executorFor } from "./executor.js";
import { egressPolicy, egressRules } from "../sandbox/egress.js";
import { agentSpawnEnv } from "./spawn.js";
import { envNameMatches } from "../agent-env.js";
import { trustedGitDirs, gitSandboxEnv, mergeGitConfigEnv, hostGitFacts, inferredForgeEgressHosts, sandboxMounts, checkoutMasks } from "./sandbox.js";
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
        // forge.autoMerge turned on for an approved PR that has not merged yet: this is the
        // pipeline handing it to GitHub, not a merge — say so, so readers don't mistake it.
        const rm = store?.getRefMeta(job.ref);
        const awaitingMerge = !!rm?.autoMerge && rm.prState !== "merged";
        emit?.("pipeline_done", job.ref, step.id, { name: task.name, url: task.url, ...(awaitingMerge ? { awaitingMerge: true, pr: rm?.autoMerge?.pr } : {}) });
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
      ...(cfg.multiRepo ? { repo: { id: repo.id, path: repo.path } } : {}),
    });
    let prompt = standing ? `${standing}\n\n=== TICKET ===\n\n${base}` : base;

    const logPath = logPathFor(step.id, job.ref);
    console.log(`[run] step ${step.id} ${job.ref} "${task.name}" -> ${logPath}`);
    // Header line: the human id + title (filename stays keyed by the ref).
    try {
      fs.writeFileSync(logPath, `# ${task.displayId ?? job.ref}  ${task.name ?? ""}\n`);
    } catch (e) {
      console.error(`[run] log header failed for ${job.ref}:`, e.message);
    }
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
        const own = agent.sandbox({ cfg, step: spawnStep, cwd, ownsCwd: hasWorktree, home: sandbox.describe().home, verdictFile, standing });
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
          ? egressRules({ agentHosts: agent.egressHosts?.(spawnEnv, { step: spawnStep }) ?? [], trackerHosts: meta?.egressHosts ?? [], forgeHosts: forge ? (forge.describe?.().egressHosts ?? []) : inferredForgeEgressHosts(facts.originUrl), originUrl: facts.originUrl, allow: policy.allow, deny: policy.deny })
          : [];
        sandboxedRun = { ref: job.ref, stepId: step.id, step, mounts, env: { ...(own.env ?? {}), ...gitEnv }, egress: { mode: policy.mode, rules }, ...(sandboxImage ? { image: sandboxImage } : {}), ...(own.files ? { files: own.files } : {}), ...(own.args ? { args: own.args } : {}) };
        // #731: the standing text is already in the agent's `instructions` file (own.files) —
        // drop it from the run prompt so the model doesn't see it twice. Keep the marker: the
        // standing text itself refers to "the `=== TICKET ===` marker".
        if (own.standingInInstructions) prompt = `=== TICKET ===\n\n${base}`;
      } catch (e) {
        refused = `sandbox setup failed: ${e.message}`;
        try {
          fs.appendFileSync(logPath, `[agenthook] ${refused}\n`);
        } catch {
          /* best effort */
        }
      }
    } else if (remote && !refused) {
      // A remote harness's run (#689): no mounts/egress — the worker's cwd is a path on another
      // machine, not something the hub wraps. `ref`/`stepId`/`step` are what spawn.js's generic
      // box-run plumbing (executorRuns, kill/done on exit) actually needs. `hub` (#690) is the
      // HUB-side repo/worktree the ssh executor syncs code from/to around the run — `worktree`/
      // `branch` only for a worktree step; a no-worktree step (e.g. triage) gets a tracked-only
      // export instead.
      const hub = { repoId: repo.id, repoPath: repo.path, ...(hasWorktree ? { worktree, branch } : {}) };
      sandboxedRun = { ref: job.ref, stepId: step.id, step, mounts: [], hub };
      // An agent with a `remote` hook (opencode, #739) needs files/env on the worker beyond the
      // synced code — the contract/standing files and a generated OpenCode config pointed at by
      // `OPENCODE_CONFIG`, written into the per-run dir the ssh executor's `paths()` computed.
      // claude has no `remote` hook, so this is a no-op for it — same as before this feature.
      if (agent.remote) {
        try {
          const own = agent.remote({ cfg, step: spawnStep, dir: /** @type {string} */ (remoteConfigDir), verdictFile, standing });
          sandboxedRun = { ...sandboxedRun, env: own.env, ...(own.files ? { files: own.files } : {}) };
          // #731: the standing text is already in a remote `instructions` file — drop it from the
          // run prompt so the model doesn't see it twice, same dedupe the sandbox branch does.
          if (own.standingInInstructions) prompt = `=== TICKET ===\n\n${base}`;
        } catch (e) {
          refused = `remote setup failed: ${e.message}`;
          try {
            fs.appendFileSync(logPath, `[agenthook] ${refused}\n`);
          } catch {
            /* best effort */
          }
        }
      }
    }
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

    /**
     * Deduce a verdict from commits (#680): on an implementing step, a clean exit with no valid
     * verdict is often just a plain fact — the run pushed commits to the ticket branch — rather
     * than something only another model turn could answer. Every gate below must hold; missing
     * any one means no deduction, so the run falls through to the repair turn (#677) and then the
     * usual hold, exactly as before this feature existed.
     * @param {Awaited<ReturnType<typeof spawnAgent>>} firstSpawned
     * @returns {{commits: number}|undefined}
     */
    function deduceVerdict(firstSpawned) {
      if (!step) return undefined; // narrowing from the outer scope doesn't cross this closure
      if (step.deduceVerdict === false) return undefined;
      if (firstSpawned.spawnError || firstSpawned.code !== 0 || firstSpawned.timedOut || cancelled.has(job.ref)) return undefined;
      const kind = step.kind ?? "implement";
      if (kind !== "implement" && kind !== "change") return undefined;
      if (!hasWorktree || !headBefore) return undefined;
      const key = meta?.stageKeys?.success;
      const successStage = key ? /** @type {Record<string, unknown>} */ (step)[key] : undefined;
      const target = typeof successStage === "string" ? stepForStage(cfg, successStage) : null;
      if (!target || target.manual) return undefined;
      if (executor.name !== "host") guardSandboxVerdict(localVerdictFile);
      const first = readVerdict(firstSpawned.code, localVerdictFile, step, agent);
      if (!(first.outcome === "hold" && first.reason === NO_VALID_VERDICT)) return undefined;
      if (endedWithQuestion(firstSpawned.lastText)) return undefined;
      const commits = commitsSince(cfg, worktree, headBefore);
      if (commits < 1) return undefined;
      return { commits };
    }

    /**
     * One receiver-driven repair turn after a clean exit with no valid verdict (#677): resume the
     * same agent session with a fixed prompt, up to step.verdictRepairs times (default 1, 0
     * disables), before a human is involved. Every gate below must hold just to ATTEMPT the first
     * turn — missing any one of them (incl. an agent with no `resumeArgs`, e.g. hermes) means no
     * repair spawn at all, so the run falls through to the usual hold exactly as before this
     * feature existed. Reuses this run's creds, env, sandbox wrap and running-record callbacks;
     * never a new run_start, never a new attempt — still the same run.
     * @param {Awaited<ReturnType<typeof spawnAgent>>} firstSpawned
     * @returns {Promise<{turns: number, repaired: boolean, results: any[], turnStats: any[], final: Awaited<ReturnType<typeof spawnAgent>>}|undefined>}
     */
    async function repairMissingVerdict(firstSpawned) {
      if (!step) return undefined; // narrowing from the outer scope doesn't cross this closure
      const verdictRepairs = step.verdictRepairs ?? 1;
      if (!verdictRepairs) return undefined;
      if (firstSpawned.spawnError || firstSpawned.code !== 0 || firstSpawned.timedOut || cancelled.has(job.ref)) return undefined;
      if (!(step.requireVerdict ?? agent.defaults.requireVerdict ?? true)) return undefined;
      if (!agent.resumeArgs) return undefined;
      // opencode's sandbox HOME (its session db) is deleted at teardown — a fresh container for
      // the repair turn would never find the session to resume.
      if (sandboxed && agent.describe().sandboxResume === false) return undefined;
      let sessionId = typeof firstSpawned.result?.session_id === "string" ? firstSpawned.result.session_id : undefined;
      if (!sessionId) return undefined;
      if (executor.name !== "host") guardSandboxVerdict(localVerdictFile);
      const first = readVerdict(firstSpawned.code, localVerdictFile, step, agent);
      if (!(first.outcome === "hold" && first.reason === NO_VALID_VERDICT)) return undefined;

      const totalMaxMs = maxMinutes ? maxMinutes * 60000 : 0;
      /** @type {any[]} */
      const results = [];
      /** @type {any[]} */
      const turnStats = [];
      let final = firstSpawned;
      let turns = 0;
      while (turns < verdictRepairs) {
        if (cancelled.has(job.ref)) break;
        const remainingMs = totalMaxMs ? Math.max(0, totalMaxMs - (Date.now() - Date.parse(startedAt))) : 0;
        if (totalMaxMs && remainingMs < 60000) break; // not enough of maxMinutes left for a repair turn
        turns++;
        const result = await spawnAgent({
          agent,
          prompt: verdictRepairPrompt(verdictFile),
          cwd,
          logPath,
          promptFile,
          model,
          effort,
          provider,
          toolsets: spawnStep.toolsets,
          isolated: step.isolated,
          allow: step.allow,
          deny: step.deny,
          bin: spawnStep.bin,
          agentEnv,
          creds,
          env: spawnStep.env,
          verdictFile,
          sandboxed: sandboxedRun,
          executor,
          maxMs: totalMaxMs ? remainingMs : 0,
          ...(step.idleMinutes ? { idleMs: step.idleMinutes * 60000 } : {}),
          resumeSessionId: sessionId,
          onPid,
          onTally,
        });
        results.push(result);
        if (result.turnStats) turnStats.push(result.turnStats);
        final = result;
        // A crashed, timed-out or spawn-errored repair turn resolves the whole run that way —
        // no further repair turns (finishStep reads this turn's code/timedOut as the run's).
        if (result.spawnError || result.code !== 0 || result.timedOut) break;
        if (typeof result.result?.session_id === "string") sessionId = result.result.session_id;
        if (executor.name !== "host") guardSandboxVerdict(localVerdictFile);
        const after = readVerdict(result.code, localVerdictFile, step, agent);
        if (!(after.outcome === "hold" && after.reason === NO_VALID_VERDICT)) return { turns, repaired: true, results, turnStats, final };
      }
      // Zero turns (a pre-loop cancel, or under 60s of maxMinutes left before the first turn) is
      // not a repair attempt at all — fall through to the pre-feature hold, byte-identical to
      // before this feature existed (no verdict_repair, no run_end.repaired).
      if (turns === 0) return undefined;
      return { turns, repaired: false, results, turnStats, final };
    }

    /**
     * Run the step's `gate` after a clean advance (#710: agent-written, repaired, or deduced) —
     * never for a hold/fail/changes/missing-verdict. A non-zero exit or timeout vetoes it: while
     * `maxAttempts` isn't spent and at least 60s of `maxMinutes` remains, one more agent turn (a
     * resume when possible, else a fresh one with the step's original prompt) gets the gate's
     * output and a chance to fix it, then the gate runs again. Every gate run goes through this
     * run's own executor (src/dispatch/gate.js) — never a host fallback for a sandboxed/ssh run.
      * `capExhausted` on the returned gate means every attempt is spent with the gate still
      * failing — finishStep forces a hold with `reason` then; any other `result: "fail"` (a
      * crashed/timed-out repair turn, or one that wrote something other than "advance") already
      * resolved through the normal spawned-fields path below, same as a verdict-repair turn —
      * EXCEPT a deduced run (#680), whose clean repair turn writes no verdict file: finish.js
      * would deduce the advance from `deduced` + missing-verdict and pass the failing gate, so
      * that path returns `capExhausted` with a reason of its own.
      * @param {Awaited<ReturnType<typeof spawnAgent>>} lastSpawned
      * @param {string|undefined} sessionId
      * @param {{commits: number}|undefined} deduced
      * @returns {Promise<{gate: {result: "pass"|"fail", capExhausted?: boolean, reason?: string}, final: Awaited<ReturnType<typeof spawnAgent>>, results: any[], turnStats: any[]}>}
      */
     async function runGateLoop(lastSpawned, sessionId, deduced) {
      if (!step) throw new Error("unreachable"); // narrowing from the outer scope doesn't cross this closure
      const gateArgv = Array.isArray(step.gate) ? step.gate : ["sh", "-c", /** @type {string} */ (step.gate)];
      const gateTimeoutMinutes = step.gateTimeoutMinutes ?? 10;
      // The gate never gets run credentials or the tracker's/forge's own token names (#710 review):
      // agentSpawnEnv's allowlist still admits them from process.env even with no `creds` passed in,
      // since it's built from meta.agentEnv/forge.agentEnv regardless — so strip those names (and
      // creds.strip, in case a minted credential env var shares a name with one) after building it.
      const credNames = [...(meta?.agentEnv ?? []), ...(forge?.describe?.().agentEnv ?? []), ...(creds?.strip ?? [])];
      const gateEnv = Object.fromEntries(Object.entries(agentSpawnEnv({ cfg, agent, meta, forge, agentEnv, env: spawnStep.env })).filter(([k]) => !envNameMatches(k, credNames)));
      // A sandboxed gate gets the run's own sandbox env (#710 review): the git config pairs
      // (safe.directory, commit identity) and the agent's own sandbox env — without them a gate
      // that runs git in the container (npm test, git push) hits "dubious ownership". Filtered the
      // same way the base env was: no credential names, and no GH_CONFIG_DIR, because
      // mergeGitConfigEnv(creds?.env, …) folds creds' non-git keys (runGitEnv: the per-run token's
      // credential helper) into sandboxedRun.env and the gate must not see them.
      if (sandboxedRun?.env) {
        for (const [k, v] of Object.entries(sandboxedRun.env)) {
          if (v === undefined || k === "GH_CONFIG_DIR" || envNameMatches(k, credNames)) continue;
          gateEnv[k] = v;
        }
      }
      const totalMaxMs = maxMinutes ? maxMinutes * 60000 : 0;
      const cap = step.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
      /** @param {{exitCode: number|null, timedOut: boolean, tail: string}} g */
      const detail = (g) => (g.timedOut ? `timed out after ${gateTimeoutMinutes} min` : `exit ${g.exitCode}`);
      /** @param {{exitCode: number|null, timedOut: boolean, tail: string}} g */
      const blockedReason = (g) => `gate failed (${detail(g)}) after ${store?.getAttempt(job.ref, step.id) ?? 0} attempt(s): ${g.tail.slice(-1000)}`;
      /** @type {any[]} */
      const results = [];
      /** @type {any[]} */
      const turnStats = [];
      let final = lastSpawned;
      let curSessionId = sessionId;
      let n = 0;
      for (;;) {
        const runId = `gate-${path.basename(logPath, ".log")}-${n++}`;
        const g = await runGate({ executor, sandboxedRun, argv: gateArgv, cwd, env: gateEnv, timeoutMs: gateTimeoutMinutes * 60000, ref: job.ref, stepId: step.id, runId, logPath, pids, executorRuns, cancelled, logLine });
        // A cancel can kill the gate mid-run (its pid is in `pids`); don't treat that as a failed
        // gate worth a repair turn — just stop, the same as the verdict-repair loop does.
        if (cancelled.has(job.ref)) return { gate: { result: "fail" }, final, results, turnStats };
        if (g.refused) return { gate: { result: "fail", capExhausted: true, reason: g.refused }, final, results, turnStats };
        const pass = g.exitCode === 0 && !g.timedOut;
        emit?.(pass ? "gate_pass" : "gate_fail", job.ref, step.id, { exitCode: g.exitCode, durationMs: g.durationMs, ...(g.timedOut ? { timedOut: true } : {}) });
        if (pass) return { gate: { result: "pass" }, final, results, turnStats };

        const ran = store?.getAttempt(job.ref, step.id) ?? 0;
        if (ran >= cap) return { gate: { result: "fail", capExhausted: true, reason: blockedReason(g) }, final, results, turnStats };
        const remainingMs = totalMaxMs ? Math.max(0, totalMaxMs - (Date.now() - Date.parse(startedAt))) : 0;
        if (totalMaxMs && remainingMs < 60000) return { gate: { result: "fail", capExhausted: true, reason: blockedReason(g) }, final, results, turnStats };
        if (cancelled.has(job.ref)) return { gate: { result: "fail" }, final, results, turnStats };

        store?.bumpAttempt(job.ref, step.id);
        const canResume = !!agent.resumeArgs && !!curSessionId && !(sandboxed && agent.describe().sandboxResume === false);
        const repairText = gateRepairPrompt(verdictFile, g.tail, newNonce());
        const turn = await spawnAgent({
          agent,
          prompt: canResume ? repairText : `${prompt}\n\n${repairText}`,
          cwd,
          logPath,
          promptFile,
          model,
          effort,
          provider,
          toolsets: spawnStep.toolsets,
          isolated: step.isolated,
          allow: step.allow,
          deny: step.deny,
          bin: spawnStep.bin,
          agentEnv,
          creds,
          env: spawnStep.env,
          verdictFile,
          sandboxed: sandboxedRun,
          executor,
          maxMs: totalMaxMs ? remainingMs : 0,
          ...(step.idleMinutes ? { idleMs: step.idleMinutes * 60000 } : {}),
          ...(canResume ? { resumeSessionId: curSessionId } : {}),
          onPid,
          onTally,
        });
        results.push(turn);
        if (turn.turnStats) turnStats.push(turn.turnStats);
        final = turn;
        if (turn.spawnError || turn.code !== 0 || turn.timedOut) return { gate: { result: "fail" }, final, results, turnStats };
        if (typeof turn.result?.session_id === "string") curSessionId = turn.result.session_id;
        if (executor.name !== "host") guardSandboxVerdict(localVerdictFile);
        const after = readVerdict(turn.code, localVerdictFile, step, agent);
        if (after.outcome !== "advance") {
          // A DEDUCED run (#680) whose repair turn, like the first, wrote no verdict file: finish.js
          // would deduce the advance from `deduced` + missing-verdict and pass the failing gate —
          // so this must hold here, carrying the gate's reason, instead.
          if (deduced && after.reason === NO_VALID_VERDICT) return { gate: { result: "fail", capExhausted: true, reason: blockedReason(g) }, final, results, turnStats };
          return { gate: { result: "fail" }, final, results, turnStats };
        }
        // advance again: loop back around to re-run the gate
      }
    }

    /** @type {Awaited<ReturnType<typeof spawnAgent>>} */
    let spawned;
    /** @type {{turns: number, repaired: boolean, results: any[], turnStats: any[]}|undefined} */
    let repair;
    /** @type {{commits: number}|undefined} */
    let deduced;
    /** @type {{result: "pass"|"fail", capExhausted?: boolean, reason?: string, results: any[], turnStats: any[]}|undefined} */
    let gate;
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
        toolsets: spawnStep.toolsets,
        isolated: step.isolated,
        allow: step.allow,
        deny: step.deny,
        bin: spawnStep.bin,
        agentEnv,
        creds,
        env: spawnStep.env,
        verdictFile,
        sandboxed: sandboxedRun,
        executor,
        maxMs: maxMinutes * 60000,
        ...(step.idleMinutes ? { idleMs: step.idleMinutes * 60000 } : {}),
        onPid,
        onTally,
      }).catch(async (e) => {
        if (energyRun) await stopEnergy(energyRun); // never leave the sampler counting a dead run
        throw e;
      });
      if (!refused) {
        deduced = deduceVerdict(spawned);
        if (!deduced) {
          const r = await repairMissingVerdict(spawned);
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
            if (executor.name !== "host") guardSandboxVerdict(localVerdictFile);
            const peeked = readVerdict(spawned.code, localVerdictFile, step, agent);
            if (deduced || peeked.outcome === "advance") {
              let sessionId = typeof spawned.result?.session_id === "string" ? spawned.result.session_id : undefined;
              if (repair?.results?.length) {
                const lastR = repair.results[repair.results.length - 1];
                if (typeof lastR.result?.session_id === "string") sessionId = lastR.result.session_id;
              }
              const g = await runGateLoop(spawned, sessionId, deduced);
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
