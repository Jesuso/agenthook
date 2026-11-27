// The run's agent turns after the worktree/prompt/sandbox-wrap are ready: the spawnAgent options
// every turn shares, a verdict deduced from commits with no extra agent turn, the receiver-driven
// repair turn after a clean exit with no valid verdict, and the step's `gate` repair loop. Each
// turn runner is a module-level function over a run-context object (`rc`, built once in step.js
// right after the sandbox/remote wrap) instead of a closure over runStep's locals.
import path from "node:path";
import { verdictRepairPrompt, gateRepairPrompt } from "../prompts.js";
import { newNonce } from "../untrusted.js";
import { stepForStage, DEFAULT_MAX_ATTEMPTS } from "../pipeline.js";
import { peekVerdict, isNoValidVerdict, NO_VALID_VERDICT, endedWithQuestion } from "./verdict.js";
import { commitsSince } from "../worktree.js";
import { runGate } from "./gate.js";
import { agentSpawnEnv } from "./spawn.js";
import { envNameMatches } from "../agent-env.js";

/**
 * runStep's locals every turn runner below shares, handed over as one object instead of each
 * function closing over ~15 of runStep's own. Built right after the sandbox/remote wrap
 * (run-wrap.js), so `prompt` and `sandboxedRun` are the final, post-wrap values.
 * @typedef {object} RunContext
 * @property {import('../types/pipeline.js').Step} step
 * @property {import('../types/pipeline.js').Step} spawnStep
 * @property {import('../types/pipeline.js').Job} job
 * @property {import('../types/config.js').Config} cfg
 * @property {import('../types/agents.js').AgentAdapter} agent
 * @property {import('../types/sandbox.js').Executor} executor
 * @property {boolean} sandboxed
 * @property {Parameters<import('./spawn.js').Spawn['spawnAgent']>[0]['sandboxed']} sandboxedRun
 * @property {string} localVerdictFile
 * @property {string} verdictFile
 * @property {boolean} hasWorktree
 * @property {string|null} headBefore
 * @property {string} worktree
 * @property {string} cwd
 * @property {string} logPath
 * @property {string|undefined} promptFile
 * @property {string|undefined} model
 * @property {string|undefined} effort
 * @property {string|undefined} provider
 * @property {Record<string, string>|undefined} agentEnv
 * @property {import('../types/tracker.js').RunCredentials|null} creds
 * @property {number} maxMinutes
 * @property {string} startedAt
 * @property {string} prompt
 * @property {(p: number|undefined) => void} onPid
 * @property {(tally: {input: number, output: number, cacheRead: number, cacheCreate: number, lastContext?: number}) => void} onTally
 * @property {import('../types/tracker.js').AdapterMeta} meta
 * @property {import('../types/forge.js').Forge|null|undefined} forge
 * @property {import('../types/state.js').Store|undefined} store
 * @property {import('./context.js').DispatchState['emit']} emit
 * @property {Set<string>} cancelled
 * @property {import('./verdict.js').VerdictOps['readVerdict']} readVerdict
 * @property {import('./spawn.js').Spawn['spawnAgent']} spawnAgent
 * @property {Map<string, number>} pids
 * @property {Map<string, import('../types/sandbox.js').ExecutorRun>} executorRuns
 * @property {import('./spawn.js').Spawn['logLine']} logLine
 */

/**
 * The shared spawnAgent() options every turn in a run passes (#682 harness knobs, #474 creds, the
 * run's own sandbox/executor wrap): only `prompt`, `maxMs` and `resumeSessionId` differ between
 * the first turn, a verdict-repair turn and a gate-repair turn, and `resumeSessionId` must stay
 * ABSENT (not `undefined`) on a turn that passes none — so it's an optional field here, spread in
 * only when given.
 * @param {RunContext} rc
 * @param {{prompt: string, maxMs: number, resumeSessionId?: string}} turn
 */
export function spawnOptions(rc, { prompt, maxMs, resumeSessionId }) {
  const { agent, cwd, logPath, promptFile, model, effort, provider, step, spawnStep, agentEnv, creds, verdictFile, sandboxedRun, executor, onPid, onTally } = rc;
  return {
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
    maxMs,
    ...(step.idleMinutes ? { idleMs: step.idleMinutes * 60000 } : {}),
    ...(resumeSessionId !== undefined ? { resumeSessionId } : {}),
    onPid,
    onTally,
  };
}

/**
 * Deduce a verdict from commits (#680): on an implementing step, a clean exit with no valid
 * verdict is often just a plain fact — the run pushed commits to the ticket branch — rather
 * than something only another model turn could answer. Every gate below must hold; missing
 * any one means no deduction, so the run falls through to the repair turn (#677) and then the
 * usual hold, exactly as before this feature existed.
 * @param {RunContext} rc
 * @param {Awaited<ReturnType<RunContext['spawnAgent']>>} firstSpawned
 * @returns {{commits: number}|undefined}
 */
export function deduceVerdict(rc, firstSpawned) {
  const { step, job, cancelled, hasWorktree, headBefore, meta, cfg, worktree } = rc;
  if (step.deduceVerdict === false) return undefined;
  if (firstSpawned.spawnError || firstSpawned.code !== 0 || firstSpawned.timedOut || cancelled.has(job.ref)) return undefined;
  const kind = step.kind ?? "implement";
  if (kind !== "implement" && kind !== "change") return undefined;
  if (!hasWorktree || !headBefore) return undefined;
  const key = meta?.stageKeys?.success;
  const successStage = key ? /** @type {Record<string, unknown>} */ (step)[key] : undefined;
  const target = typeof successStage === "string" ? stepForStage(cfg, successStage) : null;
  if (!target || target.manual) return undefined;
  const first = peekVerdict(rc, firstSpawned.code);
  if (!isNoValidVerdict(first)) return undefined;
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
 * @param {RunContext} rc
 * @param {Awaited<ReturnType<RunContext['spawnAgent']>>} firstSpawned
 * @returns {Promise<{turns: number, repaired: boolean, results: any[], turnStats: any[], final: Awaited<ReturnType<RunContext['spawnAgent']>>}|undefined>}
 */
export async function repairMissingVerdict(rc, firstSpawned) {
  const { step, job, cancelled, agent, sandboxed, maxMinutes, startedAt, verdictFile, spawnAgent } = rc;
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
  const first = peekVerdict(rc, firstSpawned.code);
  if (!isNoValidVerdict(first)) return undefined;

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
    const result = await spawnAgent(spawnOptions(rc, { prompt: verdictRepairPrompt(verdictFile), maxMs: totalMaxMs ? remainingMs : 0, resumeSessionId: sessionId }));
    results.push(result);
    if (result.turnStats) turnStats.push(result.turnStats);
    final = result;
    // A crashed, timed-out or spawn-errored repair turn resolves the whole run that way —
    // no further repair turns (finishStep reads this turn's code/timedOut as the run's).
    if (result.spawnError || result.code !== 0 || result.timedOut) break;
    if (typeof result.result?.session_id === "string") sessionId = result.result.session_id;
    const after = peekVerdict(rc, result.code);
    if (!isNoValidVerdict(after)) return { turns, repaired: true, results, turnStats, final };
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
 * @param {RunContext} rc
 * @param {Awaited<ReturnType<RunContext['spawnAgent']>>} lastSpawned
 * @param {string|undefined} sessionId
 * @param {{commits: number}|undefined} deduced
 * @returns {Promise<{gate: {result: "pass"|"fail", capExhausted?: boolean, reason?: string}, final: Awaited<ReturnType<RunContext['spawnAgent']>>, results: any[], turnStats: any[]}>}
 */
export async function runGateLoop(rc, lastSpawned, sessionId, deduced) {
  const { step, job, cfg, agent, meta, forge, creds, sandboxedRun, maxMinutes, startedAt, store, emit, pids, executorRuns, cancelled, logLine, logPath, cwd, executor, agentEnv, spawnStep, prompt, spawnAgent, verdictFile } = rc;
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
    const canResume = !!agent.resumeArgs && !!curSessionId && !(rc.sandboxed && agent.describe().sandboxResume === false);
    const repairText = gateRepairPrompt(verdictFile, g.tail, newNonce());
    const turn = await spawnAgent(spawnOptions(rc, { prompt: canResume ? repairText : `${prompt}\n\n${repairText}`, maxMs: totalMaxMs ? remainingMs : 0, ...(canResume ? { resumeSessionId: curSessionId } : {}) }));
    results.push(turn);
    if (turn.turnStats) turnStats.push(turn.turnStats);
    final = turn;
    if (turn.spawnError || turn.code !== 0 || turn.timedOut) return { gate: { result: "fail" }, final, results, turnStats };
    if (typeof turn.result?.session_id === "string") curSessionId = turn.result.session_id;
    const after = peekVerdict(rc, turn.code);
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
