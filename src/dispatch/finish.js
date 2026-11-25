// A `pipeline` job's run after the agent exits: usage + cost, the verdict, run_end, the
// hold/difficulty/overlap/parked-CI bookkeeping, summary, drain, advance, leaving the pipeline.
import fs from "node:fs";
import path from "node:path";
import { drainWorktree } from "../worktree.js";
import { CANCELLED_REASON, reportMoveFailure } from "../events.js";
import { unionPaths } from "../overlap.js";
import { costOf } from "../pricing.js";
import { energyFields } from "../energy.js";
import { timeoutReason, NO_VALID_VERDICT, QUESTION_HOLD, ASSUMED_ADVANCE_SUFFIX, endedWithQuestion, guardSandboxVerdict } from "./verdict.js";
import { harnessesOf, healthTrip } from "./harness.js";
import { followUpDecision } from "../followup.js";
import { autoMergeDecision, runAutoMerge, reportAutoMergeSkipped, disableAutoMergeOnBounce, holdAutoMergeSlot } from "../auto-merge.js";
import { readOutbox } from "./outbox.js";
import { publishOutbox } from "./publish.js";

/**
 * runStep's locals the post-exit phase reads, handed over as one object.
 * @typedef {object} StepRun
 * @property {import('../types.js').Step} step
 * @property {import('../types.js').Step} spawnStep  `step` with its harness's spawn knobs filled in (src/dispatch/harness.js) — what the agent ran with
 * @property {{harness?: string|null}} harnessField  run_end's `harness` (set only for a profile with harnesses)
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
 * @property {string} [preflightDown]  the agent's own preflight refused (`refused` holds the same reason) — a harness health signal
 * @property {string} [spawnError]  the spawn itself errored (e.g. ENOENT: the bin is missing)
 * @property {string} [unreachable]  the ssh executor reported the worker unreachable (#828): `refused` carries the raw reason, this is what the breaker trips with — the run requeues, it is not failed
 * @property {string} [sshConfigFailure]  ssh exit-255 classified as an auth/host-key config failure (#828) — `refused` carries it; the breaker must not trip on it
 * @property {boolean} [noOutput]  the parser counted no model output tokens
 * @property {string} [apiDown]  a connection-level model-API failure line found in the run's output (src/dispatch/harness.js modelApiFailure) — a harness health signal at any wall time
 * @property {string} [errorLine]  the agent's own last error line (src/dispatch/spawn.js), redacted — the breaker's fast-exit reason detail (#688)
 * @property {Record<string, string>|undefined} agentEnv
 * @property {string|null} energyRun
 * @property {number} code
 * @property {any} result
 * @property {{turns: number, firstContext?: number, peakContext?: number, lastContext?: number, compactions?: number}} [turnStats]  the parser's per-turn stats (#645), when it saw at least one turn; compactions (#657) rides along the same guard
 * @property {import('../quota.js').QuotaReading|null} quota
 * @property {"max"|"idle"|undefined} timedOut
 * @property {boolean} [sandboxed]  ran in the profile's sandbox, or over ssh on a remote harness (#689) — either way its verdict sits in its own per-run dir and needs the untrusted-writer guard (guardSandboxVerdict)
 * @property {import('../types.js').SandboxReport} [sandboxReport]  what the sandbox reported once the run exited
 * @property {string|null} [headSha]  forge.autoMerge tier step: the PR head when the run started
 * @property {string} [lastText]  the run's last output (its final result text, else rendered-stdout tail) for the question-hold detector
 * @property {{turns: number, repaired: boolean, results: any[], turnStats: {turns: number, firstContext?: number, peakContext?: number, lastContext?: number, compactions?: number}[]}} [repair]  the receiver-driven verdict-repair turns (#677) this run took, when any did: `turns` = how many ran, `repaired` = the last one wrote a valid verdict, `results`/`turnStats` = each repair spawnAgent() result / its turnStats, oldest first — absent when no repair was attempted
 * @property {{commits: number}} [deduced]  a verdict deduced from commits (#680, src/dispatch/step.js `deduceVerdict`) instead of a repair turn — `commits` = how many the branch gained since the run started; absent when none was deduced
 * @property {{result: "pass"|"fail", capExhausted?: boolean, reason?: string, results: any[], turnStats: {turns: number, firstContext?: number, peakContext?: number, lastContext?: number, compactions?: number}[]}} [gate]  the step's `gate` (#710), when it ran at least once: `result` = its last outcome; `capExhausted` = every attempt spent with it still failing — `reason` then forces a hold (gate failed (…): the output tail); any other `result: "fail"` already resolved through the normal spawned-fields path (a crashed/timed-out repair turn, or one that wrote something other than "advance"); `results`/`turnStats` = each gate-repair spawnAgent() turn, oldest first — absent when no gate ran
 * @property {boolean} [remote]  ran over ssh on a remote harness (#825) — its outbox is published by the hub (src/dispatch/publish.js) before the summary/drain/advance
 * @property {string} [hubWorktree]  the hub-side worktree path (only with hasWorktree) — the branch's commits live here after the worker's sync-back
 * @property {string} [branch]  the step's branch (only with hasWorktree) — what publish pushes and the outbox PR references
 */

/** @param {import('./context.js').DispatchState & import('./routing.js').Routing & import('./usage.js').Usage & import('./verdict.js').VerdictOps} ctx */
export function createFinish(ctx) {
  const { cfg, adapter, store, emit, forge, opts, pids, cancelled, killTimers } = ctx;
  const { stepIndex, leavePipeline, recordPr, finalizeUsage, stopEnergy, readVerdict, guardChanges } = ctx;

  /** @param {import('../types.js').Job} job @param {StepRun} run */
  async function finishStep(job, run) {
    const { step, spawnStep, harnessField, task, repo, hasWorktree, verdictFile, findings, logPath, model, startedAt, maxMinutes, agent, refused, preflightDown, spawnError, unreachable, sshConfigFailure, noOutput, apiDown, errorLine, agentEnv, energyRun, code, result, quota, turnStats, timedOut, sandboxed, sandboxReport, lastText, repair, deduced, gate, remote, hubWorktree, branch } = run;
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
        opts.onQuota?.({ ...quota, asOf: new Date().toISOString() }, { harness: harnessField.harness ?? null, stepId: step.id });
      } catch (e) {
        console.error(`[dispatch] quota hook failed (continuing): ${e.message}`);
      }
    }
    // The step may just have opened the PR.
    await recordPr(job.ref, repo);

    // Best-effort post-exit token capture (hermes' `sessions export`, #395): only when the
    // run actually spawned and came back with a session id to export.
    const finalized = !refused && typeof result?.session_id === "string" ? await finalizeUsage(agent, { sessionId: result.session_id, bin: spawnStep.bin, agentEnv, env: spawnStep.env, stepId: step.id, ref: job.ref, logPath }) : null;

    // Persist the final per-run usage record from the captured result (token totals +
    // cost). Append-only usage.jsonl, distinct from the rewritten state files. The adapter
    // decides `unpriced` (e.g. a local-model run — step `bin`, or a non-Claude model — whose
    // dollar figure is made up), so run_end drops the cost and the usage record is tagged.
    // Built even without a result: `unpriced` must still reach run_end.
    const endedAt = new Date().toISOString();
    const usage = agent.usageRecord(result, { ref: job.ref, stepId: step.id, model, bin: spawnStep.bin, claudeBin: cfg.claudeBin, startedAt, endedAt });
    // An adapter that reports no `duration_ms` (opencode, hermes) still has a wall time: derive
    // it from the run's own timestamps. Adapters that report their own (claude, cursor) keep it.
    if (usage.durationMs === undefined) {
      const d = Date.parse(endedAt) - Date.parse(startedAt);
      if (Number.isFinite(d)) usage.durationMs = d;
    }
    if (finalized) {
      for (const k of /** @type {const} */ (["input", "output", "cacheRead", "cacheCreate"])) {
        if (typeof finalized[k] === "number" && Number.isFinite(finalized[k]) && finalized[k] >= 0) usage[k] = finalized[k];
      }
      // Only overlay the model when the step resolved none of its own — the record's model
      // is still the adapter's unpriced placeholder (hermes: "hermes"), which the rate table
      // can't match.
      if (finalized.model && !model) usage.model = finalized.model;
    }
    // Per-turn stats the parser saw (#645): turns/firstContext/peakContext/lastContext, only
    // when the parser counted at least one turn — hermes' `finalize` never sets these.
    if (turnStats) Object.assign(usage, turnStats);
    // Verdict-repair (#677): sum each repair turn's usage into this single record — tokens,
    // cost and duration add; peakContext is the max across every turn; lastContext and
    // sessionId come from the final turn, so `ah resume` picks up the latest session.
    if (repair?.results?.length) {
      for (const r of repair.results) {
        const ru = agent.usageRecord(r.result, { ref: job.ref, stepId: step.id, model, bin: spawnStep.bin, claudeBin: cfg.claudeBin, startedAt, endedAt });
        for (const k of /** @type {const} */ (["input", "output", "cacheRead", "cacheCreate"])) usage[k] = (usage[k] || 0) + (ru[k] || 0);
        if (typeof ru.costUsd === "number") usage.costUsd = (usage.costUsd || 0) + ru.costUsd;
        if (typeof ru.durationMs === "number") usage.durationMs = (usage.durationMs || 0) + ru.durationMs;
        if (typeof ru.sessionId === "string") usage.sessionId = ru.sessionId;
      }
      for (const ts of repair.turnStats) {
        usage.turns = (usage.turns || 0) + (ts.turns || 0);
        if (typeof ts.peakContext === "number") usage.peakContext = Math.max(usage.peakContext ?? 0, ts.peakContext);
        if (typeof ts.lastContext === "number") usage.lastContext = ts.lastContext;
        if (typeof ts.compactions === "number") usage.compactions = (usage.compactions || 0) + ts.compactions;
      }
    }
    // Gate-repair turns (#710): summed the same way as verdict-repair's, above.
    if (gate?.results?.length) {
      for (const r of gate.results) {
        const ru = agent.usageRecord(r.result, { ref: job.ref, stepId: step.id, model, bin: spawnStep.bin, claudeBin: cfg.claudeBin, startedAt, endedAt });
        for (const k of /** @type {const} */ (["input", "output", "cacheRead", "cacheCreate"])) usage[k] = (usage[k] || 0) + (ru[k] || 0);
        if (typeof ru.costUsd === "number") usage.costUsd = (usage.costUsd || 0) + ru.costUsd;
        if (typeof ru.durationMs === "number") usage.durationMs = (usage.durationMs || 0) + ru.durationMs;
        if (typeof ru.sessionId === "string") usage.sessionId = ru.sessionId;
      }
      for (const ts of gate.turnStats) {
        usage.turns = (usage.turns || 0) + (ts.turns || 0);
        if (typeof ts.peakContext === "number") usage.peakContext = Math.max(usage.peakContext ?? 0, ts.peakContext);
        if (typeof ts.lastContext === "number") usage.lastContext = ts.lastContext;
        if (typeof ts.compactions === "number") usage.compactions = (usage.compactions || 0) + ts.compactions;
      }
    }
    // A harness may have switched the agent: name it, so follow/resume find the run's transcript.
    if (harnessField.harness) usage.agent = agent.describe().name;
    // ...and the harness itself, so status can sum usage per harness (`harnessUsage`).
    if (typeof harnessField.harness === "string" && harnessField.harness) usage.harness = harnessField.harness;
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

    // Harness breaker (src/queue.js): a run whose harness backend looks down (healthTrip) says so
    // in its settle info, and the queue marks the harness down. The job goes back to the front of
    // the queue instead of failing — a trip never counts against the attempt cap (#828) — no
    // verdict, no move; the worktree and any overlap lock stay for the re-run, which the queue
    // routes around the down harness.
    const harness = harnessField.harness;
    // Only worth naming on a held/failed reason when the step actually routes through more than
    // one harness — a single-harness step's reason already implies which one ran it.
    const reasonHarness = harnessesOf(step).length >= 2 && harness ? harness : undefined;
    const tripped = harness
      ? healthTrip({
          unreachable,
          sshConfigFailure,
          preflight: preflightDown,
          spawnError,
          code,
          timedOut,
          cancelled: wasCancelled,
          noOutput,
          wallMs: Date.now() - Date.parse(startedAt),
          downGraceSeconds: cfg.harnesses?.[harness]?.downGraceSeconds,
          apiDown,
          errorLine,
          upstreamFailures: sandboxReport?.upstreamFailures,
          baseUrl: spawnStep.env?.ANTHROPIC_BASE_URL,
        })
      : undefined;
    /** @type {{harness: string, reason: string, requeue: boolean}|undefined} */
    let health;
    if (harness && tripped) {
      // A trip never counts as an attempt (#828): a worker that stays down longer than
      // maxAttempts×probe must keep the job queued, not fail it. Requeue unconditionally (still
      // not for a cancel) and undo runStep's pre-run bump, so the counter reflects real runs.
      const requeue = !wasCancelled;
      health = { harness, reason: tripped, requeue };
      if (requeue) {
        store?.unbumpAttempt(job.ref, step.id);
        try {
          fs.rmSync(sandboxed ? path.dirname(verdictFile) : verdictFile, { recursive: true, force: true });
        } catch {
          /* best effort */
        }
        console.log(`[harness] ${harness} looks down (${tripped}) — ${step.id} ${job.ref} goes back to the front of the queue`);
        emit?.("run_end", job.ref, step.id, { outcome: "requeued", harness, reason: tripped });
        return { kind: job.kind, ref: job.ref, name: task.name, url: task.url, code, health };
      }
    }

    // A sandboxed agent owns its verdict dir: guard it the same way a repair turn's pre-check does
    // (src/dispatch/verdict.js guardSandboxVerdict) before trusting anything in it.
    if (sandboxed) guardSandboxVerdict(verdictFile);
    // Resolve the verdict from the exit code + the file the agent wrote. A killed run
    // always fails — a verdict file it half-wrote before the kill is not trusted.
    /** @type {import('../types.js').Verdict} */
    const verdict = refused
      ? { outcome: "fail", reason: refused }
      : spawnError
      ? { outcome: "fail", reason: `spawn failed: ${spawnError}` }
      : wasCancelled
      ? { outcome: "fail", reason: CANCELLED_REASON }
      : timedOut
      ? { outcome: "fail", reason: timeoutReason(timedOut, timedOut === "max" ? maxMinutes : (step.idleMinutes ?? 0)) }
      : readVerdict(code, verdictFile, step, agent);
    // Remote run's outbox (#825): parse it BEFORE the rmSync below wipes the per-run dir. Remote
    // only — a host run's verdict file has no outbox sibling, and a sandboxed host run is not
    // trusted to publish anyway (it has no credentials). Drops are logged to the RUN LOG, not
    // just the server log — this is where a worker-planted payload is investigated.
    const outboxLog = (/** @type {string} */ line) => {
      console.log(line);
      try {
        fs.appendFileSync(logPath, `[agenthook] ${line}\n`);
      } catch {
        /* best effort */
      }
    };
    const outbox = remote ? readOutbox(path.dirname(verdictFile), outboxLog, cfg.trigger) : undefined;
    try {
      fs.rmSync(sandboxed ? path.dirname(verdictFile) : verdictFile, { recursive: true, force: true });
    } catch {
      /* best effort */
    }

    // computed before run_end below: missingVerdict must still name the base case even after the
    // question-hold and repair-suffix rewrites below touch verdict.reason (#655, #677).
    let missingVerdict = verdict.outcome === "hold" && verdict.reason === NO_VALID_VERDICT;
    // A clean exit (no kill, no timeout, no refusal) with no valid verdict whose last line is a
    // question: name it specifically so the held reason and the blocked/verdict_missing events say
    // the agent ended by asking a question instead of acting, quoting the line.
    if (missingVerdict && code === 0 && !timedOut && !refused) {
      const q = endedWithQuestion(lastText);
      if (q) verdict.reason = `${QUESTION_HOLD}: "${q}"`;
    }
    // Verdict-repair (#677): one receiver-driven resume turn (up to step.verdictRepairs) already
    // ran in step.js, right after the first spawn, before this run's verdict was read above — so
    // `verdict` here already reflects the LAST turn's file. Report what happened and, if the
    // verdict is still missing after every repair turn, say so in the reason (keeping the
    // question form above, when it applied) so a human sees it tried before giving up.
    if (repair) {
      emit?.("verdict_repair", job.ref, step.id, { result: repair.repaired ? "repaired" : "still_missing", turns: repair.turns });
      if (!repair.repaired && missingVerdict) {
        verdict.reason = `${verdict.reason} (after ${repair.turns} repair turn${repair.turns === 1 ? "" : "s"})`;
      }
    }
    // Deduced verdict (#680): step.js's `deduceVerdict` already gated this on a qualifying
    // implement/change step whose branch gained commits, skipping the repair turn above entirely —
    // so it only ever competes with the still-missing case, never with a repair's outcome. Never
    // applies after a FAILED gate (#710): the run's effective advance was vetoed, so it must hold
    // (step.js's gate loop returns capExhausted for the deduced + no-repair-verdict case; this is
    // the second half of that guarantee for any other path where the gate ran and stayed fail).
    let deducedApplied = false;
    if (deduced && missingVerdict && gate?.result !== "fail") {
      verdict.outcome = "advance";
      verdict.reason = `no verdict written; advanced because the run added ${deduced.commits} commit${deduced.commits === 1 ? "" : "s"}`;
      missingVerdict = false;
      deducedApplied = true;
    }
    // The gate (#710): every attempt is spent and it is still failing — force a hold naming the
    // output tail. Any other `gate.result === "fail"` already resolved through the normal
    // code/timedOut/verdict-file path above (a crashed/timed-out repair turn, or one that wrote
    // something other than "advance") — this is the only case the gate itself forces.
    if (gate?.capExhausted) {
      verdict.outcome = "hold";
      verdict.reason = gate.reason;
      missingVerdict = false;
    }
    // Absent for a hold with no verdict, every receiver-forced verdict (refused/spawn-failed/
    // cancelled/timeout/non-zero exit/a gate-cap hold — none of those is anyone's verdict claim),
    // and the existing `requireVerdict:false` assumed-advance fallback (its reason carries the
    // ASSUMED_ADVANCE_SUFFIX parseVerdict stamps on it, never a real verdict file).
    const assumedAdvance = typeof verdict.reason === "string" && verdict.reason.endsWith(ASSUMED_ADVANCE_SUFFIX);
    /** @type {'agent'|'repaired'|'deduced'|undefined} */
    const verdictSource = gate?.capExhausted
      ? undefined
      : deducedApplied
      ? "deduced"
      : repair?.repaired
      ? "repaired"
      : !missingVerdict && !assumedAdvance && !refused && !spawnError && !wasCancelled && !timedOut && code === 0
      ? "agent"
      : undefined;

    const costUsd = unpriced ? undefined : usage.costUsd;
    // Model + tokens ride along when a result was seen, so Stats can price from events.jsonl alone.
    // turns/firstContext/peakContext/lastContext/compactions (#645, #657) ride along only when
    // the parser saw a turn.
    const tokens = result
      ? {
          ...(usage.model ? { model: usage.model } : {}),
          input: usage.input,
          output: usage.output,
          cacheRead: usage.cacheRead,
          cacheCreate: usage.cacheCreate,
          ...(typeof usage.turns === "number" ? { turns: usage.turns } : {}),
          ...(typeof usage.firstContext === "number" ? { firstContext: usage.firstContext } : {}),
          ...(typeof usage.peakContext === "number" ? { peakContext: usage.peakContext } : {}),
          ...(typeof usage.lastContext === "number" ? { lastContext: usage.lastContext } : {}),
          ...(typeof usage.compactions === "number" ? { compactions: usage.compactions } : {}),
        }
      : {};
    // The agent's one plain sentence for a human (summary.plain), whitespace-collapsed; absent when none.
    const plain = typeof verdict.summary?.plain === "string" ? verdict.summary.plain.replace(/\s+/g, " ").trim() : "";
    // 2-4 short discrete answers (summary.options), only on a hold — parseSummary already validated them.
    const options = verdict.outcome === "hold" && Array.isArray(verdict.summary?.options) ? verdict.summary.options : undefined;
    emit?.("run_end", job.ref, step.id, {
      outcome: verdict.outcome,
      ...harnessField,
      ...(verdictSource ? { verdictSource } : {}),
      ...(plain ? { plain } : {}),
      ...(options ? { options } : {}),
      ...(costUsd !== undefined ? { costUsd } : {}),
      ...(unpriced ? { unpriced: true } : {}),
      ...(usage.costBasis ? { costBasis: usage.costBasis } : {}),
      ...(usage.estUsd !== undefined ? { estUsd: usage.estUsd } : {}),
      ...(energyRec ?? {}),
      ...tokens,
      ...(repair ? { repaired: !!repair.repaired } : {}),
      ...(gate ? { gate: gate.result } : {}),
      ...(sandboxReport?.extra ?? {}),
    });
    if (verdict.outcome === "hold") {
      if (missingVerdict) emit?.("verdict_missing", job.ref, step.id, { reason: verdict.reason });
      // Park it: an owner's `@agent` reply on the item resumes THIS step (see the
      // adapters' comment trigger), with the reply appended to the prompt.
      store?.setHeld(job.ref, { stepId: step.id, ...(verdict.reason ? { reason: verdict.reason } : {}), ...(reasonHarness ? { harness: reasonHarness } : {}), heldAt: new Date().toISOString() });
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

    // forge.autoMerge: the task is going back (changes — incl. a red-CI bounce — or fail). Turn
    // auto-merge off before the move fires the rework, so a push made after an earlier approval
    // can't merge on it. If that fails, auto-merge may still be on: hold instead of reworking.
    if (cfg.forge?.autoMerge && (verdict.outcome === "changes" || verdict.outcome === "fail")) {
      const off = await disableAutoMergeOnBounce({ forge, store, emit }, job.ref, step.id, `${ciBounce ? "red CI, " : ""}${verdict.outcome} from ${step.id}`);
      if (off === "error" && verdict.outcome === "changes") {
        Object.assign(verdict, { outcome: "hold", reason: "could not turn off auto-merge on the PR before the rework (see auto_merge_failed); turn it off, then release" });
        delete verdict.target;
        store?.clearFindings(job.ref);
        store?.setHeld(job.ref, { stepId: step.id, reason: verdict.reason, ...(reasonHarness ? { harness: reasonHarness } : {}), heldAt: new Date().toISOString() });
      }
    }
    if (ciBounce && verdict.outcome === "changes") emit?.("ci_red", job.ref, step.id, { action: "bounced", target: verdict.target });

    // Approve with follow-up checks (src/followup.js): an allowed tier approves as usual and
    // records the checks after the move; any other tier holds, naming them. A bounce or fail
    // withdraws an earlier approval's checks; so does the same step approving again without any.
    const followUp = followUpDecision(cfg, step.id, verdict, store?.getSummaries(job.ref));
    if (followUp && "hold" in followUp) {
      Object.assign(verdict, { outcome: "hold", reason: followUp.hold });
      store?.setHeld(job.ref, { stepId: step.id, reason: followUp.hold, ...(reasonHarness ? { harness: reasonHarness } : {}), heldAt: new Date().toISOString() });
    }
    const pendingChecks = store?.getRefMeta(job.ref)?.followUp;
    if (pendingChecks && !followUp && (verdict.outcome === "changes" || verdict.outcome === "fail" || (verdict.outcome === "advance" && pendingChecks.step === step.id))) {
      store?.setRefMeta(job.ref, { followUp: null });
    }

    // Remote run's outbox (#825, #681 phase 5a): publish with the hub's own credentials now that
    // every outcome rewrite above has settled — a hold (a workflow file in the run's commits) or a
    // fail (a push rejection) coming out here IS the applied outcome; a PR or comment failure is
    // one line in the run log and never fails the step.
    if (remote) {
      await publishOutbox({ forge, adapter, ref: job.ref, stepId: step.id, remote, hasWorktree, worktree: hubWorktree, branch, outbox, verdict, store, log: outboxLog, reasonHarness });
    }

    // The step's supervisor summary, with the outcome actually applied. A run without one
    // drops the step's earlier summary, so a stale one never outlives a re-run.
    if (store) {
      if (verdict.summary) {
        store.setSummary(job.ref, step.id, { summary: verdict.summary, outcome: verdict.outcome, run: path.basename(logPath), at: new Date().toISOString(), ...(run.headSha ? { headSha: run.headSha } : {}), ...(verdictSource ? { verdictSource } : {}), ...(gate ? { gate: gate.result } : {}) });
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
        ...(reasonHarness ? { harness: reasonHarness } : {}),
        name: task.name,
        url: task.url,
      });
    }

    // The move to the next section is itself the event that fires the next step.
    console.log(
      missingVerdict
        ? `[verdict] ${step.id} ${job.ref} -> hold (${verdict.reason} — set requireVerdict:false to advance on a clean exit)`
        : `[verdict] ${step.id} ${job.ref} -> ${verdict.outcome}${verdict.reason ? ` (${verdict.reason})` : ""}`
    );
    // Decided before the move (it reads only this verdict + stored summaries) so a pending enable
    // is registered before the move fires the next step: that step's bounce waits for it.
    const autoMerge = autoMergeDecision(cfg, step.id, verdict, store?.getSummaries(job.ref), run.headSha);
    /** @type {() => void} */
    let releaseSlot = () => {};
    if (autoMerge && !("skipped" in autoMerge)) holdAutoMergeSlot(job.ref, new Promise((r) => (releaseSlot = () => r(undefined))));

    let moved = false;
    try {
      await adapter.advance(job.ref, step.id, verdict);
      moved = true;
    } catch (e) {
      console.error(`[advance] ${step.id} ${job.ref} (${verdict.outcome}) failed:`, e.message);
      reportMoveFailure(emit, job.ref, step.id, verdict.outcome, e);
    }

    // Opt-in auto-merge (forge.autoMerge): the approving step advanced with an allowed risk tier
    // (or did not qualify: reported as `auto_merge_skipped`).
    // After the move, and only when it happened — a refused move (not ours) never merges. The
    // final verdict is read here, so a red-CI bounce or a capped loop never counts as approval.
    // runAutoMerge never throws; a failure is an `auto_merge_failed` event, nothing more.
    try {
      if (moved && autoMerge) {
        if ("skipped" in autoMerge) reportAutoMergeSkipped({ forge, store, emit }, job.ref, step.id, autoMerge);
        else await runAutoMerge({ forge, store, emit }, job.ref, step.id, autoMerge);
      }
    } finally {
      releaseSlot();
    }

    // The approval stood (the move happened): record what to verify once the change is live.
    if (moved && followUp && "record" in followUp) {
      const pr = store?.getRefMeta(job.ref)?.pr;
      store?.setRefMeta(job.ref, { followUp: { checks: followUp.checks, tier: followUp.tier, step: step.id, at: new Date().toISOString(), ...(Number.isInteger(pr) ? { pr } : {}) } });
      const extra = { n: followUp.checks.length, detail: followUp.checks.join("; "), ...(Number.isInteger(pr) ? { pr } : {}), name: task.name, url: task.url };
      emit?.("followup_pending", job.ref, step.id, { tier: followUp.tier, ...extra });
      // No forge → no `merged` event will ever fire for this ref, so the checks are due now.
      if (!cfg.forge) emit?.("followup_due", job.ref, step.id, extra);
      console.log(`[followup] ${job.ref} approved (${followUp.tier}) with ${followUp.checks.length} follow-up check(s)`);
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

    return { kind: job.kind, ref: job.ref, name: task.name, url: task.url, code, ...(health ? { health } : {}) };
  }

  return { finishStep };
}

/** @typedef {ReturnType<typeof createFinish>} Finish */
