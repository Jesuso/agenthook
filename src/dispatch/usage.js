// Post-exit usage capture (agent.finalize), per-run energy sampling, and the run's usage/cost
// record (runUsageRecord).
import fs from "node:fs";
import path from "node:path";
import { agentSpawnEnv } from "./spawn.js";
import { costOf } from "../shared/pricing.js";
import { energyFields } from "../shared/energy.js";

// Upper bound on an agent's best-effort post-exit usage export (hermes' `sessions export`,
// #395): bounds the extra wait past the run itself, on top of the adapter's own timeout.
export const FINALIZE_TIMEOUT_MS = 10_000;

/** @param {import('./context.js').DispatchState} ctx */
export function createUsage(ctx) {
  const { cfg, finalizeTimeoutMs, energySampler, meta, forge } = ctx;
  /**
   * Best-effort post-exit usage capture via `agent.finalize` (e.g. hermes' `sessions
   * export`, #395): same bin/env the run used, a scratch dir under the state dir — never
   * the repo or worktree — removed afterwards, bounded by FINALIZE_TIMEOUT_MS on top of the
   * adapter's own timeout. A throw, a timeout or a null result is logged and treated as
   * "no usage"; it never touches the run's code/verdict.
   * @param {import('../types/index.js').AgentAdapter} agent
   * @param {{sessionId: string, bin?: string, agentEnv?: Record<string,string>, env?: Record<string,string>, stepId: string, ref: string, logPath: string}} o
   */
  async function finalizeUsage(agent, { sessionId, bin, agentEnv, env, stepId, ref, logPath }) {
    if (!agent.finalize) return null;
    const safeRef = String(ref).replace(/[^A-Za-z0-9_.-]/g, "_");
    const dir = path.join(cfg.dataDir, "exports", `${safeRef}-${stepId}`);
    // Set once the race below resolves: a late rejection (execFile's own kill at the same
    // timeout) after our timer already warned must not log a second line.
    let settled = false;
    /** @param {string} reason */
    const warn = (reason) => {
      if (settled) return;
      settled = true;
      const msg = `[agenthook] hermes usage export failed: ${reason}`;
      console.error(msg);
      try {
        fs.appendFileSync(logPath, `${msg}\n`);
      } catch {
        /* best effort */
      }
    };
    const TIMED_OUT = Symbol("finalize-timeout");
    try {
      fs.mkdirSync(dir, { recursive: true });
      /** @type {NodeJS.Timeout|undefined} */
      let timer;
      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), finalizeTimeoutMs);
      });
      const run = agent
        .finalize({ sessionId, bin: bin || agent.defaults.bin || cfg.claudeBin, env: agentSpawnEnv({ cfg, agent, meta, forge, agentEnv, env }), dir, timeoutMs: finalizeTimeoutMs })
        .catch((e) => {
          warn(e.message);
          return null;
        });
      const result = await Promise.race([run, timeout]);
      clearTimeout(timer);
      if (result === TIMED_OUT) {
        warn(`timed out after ${finalizeTimeoutMs}ms`);
        return null;
      }
      settled = true;
      return result;
    } catch (e) {
      warn(e.message);
      return null;
    } finally {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  }

  /**
   * Start sampling one opted-in run (#396). Best-effort: a sampler error is logged and the run
   * goes unmeasured; the first failed reading is written to the run log once.
   * @param {string} ref @param {string} stepId @param {string} startedAt @param {string} logPath
   * @returns {string|null} the sampler's run id, or null when it could not start
   */
  function startEnergy(ref, stepId, startedAt, logPath) {
    if (!energySampler) return null;
    /** @param {string} reason */
    const onError = (reason) => {
      const msg = `[agenthook] energy reading failed: ${reason}`;
      console.error(msg);
      try {
        fs.appendFileSync(logPath, `${msg}\n`);
      } catch {
        /* best effort */
      }
    };
    const runId = `${ref}\0${stepId}\0${startedAt}`;
    try {
      energySampler.start(runId, { onError });
      return runId;
    } catch (e) {
      onError(e.message);
      return null;
    }
  }

  /** The run's measured energy, or null (never throws). @param {string} runId @returns {Promise<{kWh: number}|null>} */
  async function stopEnergy(runId) {
    try {
      return (await energySampler?.stop(runId)) ?? null;
    } catch (e) {
      console.error(`[agenthook] energy sampling failed: ${e.message}`);
      return null;
    }
  }

  return { finalizeUsage, startEnergy, stopEnergy };
}

/** @typedef {ReturnType<typeof createUsage>} Usage */

/** @typedef {{turns: number, peakContext?: number, lastContext?: number, compactions?: number}} TurnStat */
/** @typedef {{results: {result: unknown}[], turnStats: TurnStat[]}} ExtraTurns */

/**
 * Sum one extra set of turns (verdict-repair, #677, or gate-repair, #710) into `usage`: each
 * turn's `usageRecord` (tokens add; `costUsd`/`durationMs` add when numbers; the last `sessionId`
 * wins) then each turn's `turnStats` (`turns` add; `peakContext` takes the max with `?? 0`; the
 * last `lastContext` wins; `compactions` add). A no-op when `turns` had no results.
 * @param {import('../types.js').UsageRecord} usage
 * @param {ExtraTurns|undefined} turns
 * @param {import('../types.js').AgentAdapter} agent
 * @param {import('../types.js').AgentUsageCtx} meta
 */
export function addTurns(usage, turns, agent, meta) {
  if (!turns?.results?.length) return;
  for (const r of turns.results) {
    const ru = agent.usageRecord(r.result, meta);
    for (const k of /** @type {const} */ (["input", "output", "cacheRead", "cacheCreate"])) usage[k] = (usage[k] || 0) + (ru[k] || 0);
    if (typeof ru.costUsd === "number") usage.costUsd = (usage.costUsd || 0) + ru.costUsd;
    if (typeof ru.durationMs === "number") usage.durationMs = (usage.durationMs || 0) + ru.durationMs;
    if (typeof ru.sessionId === "string") usage.sessionId = ru.sessionId;
  }
  for (const ts of turns.turnStats) {
    usage.turns = (usage.turns || 0) + (ts.turns || 0);
    if (typeof ts.peakContext === "number") usage.peakContext = Math.max(usage.peakContext ?? 0, ts.peakContext);
    if (typeof ts.lastContext === "number") usage.lastContext = ts.lastContext;
    if (typeof ts.compactions === "number") usage.compactions = (usage.compactions || 0) + ts.compactions;
  }
}

/**
 * The run's usage and cost record: one per run, summed across the first turn and every
 * verdict-repair (#677) and gate-repair (#710) turn, ready for `store.recordUsage` and run_end.
 * @param {{agent: import('../types.js').AgentAdapter, result: unknown, meta: import('../types.js').AgentUsageCtx, finalized: {input?: number, output?: number, cacheRead?: number, cacheCreate?: number, model?: string}|null, model: string|undefined, turnStats: TurnStat|undefined, repair: ExtraTurns|undefined, gate: ExtraTurns|undefined, harness: {harness?: string|null}, remoteCwd: string|undefined, energy: {kWh: number}|null, cfg: Pick<import('../types.js').Config, "pricing"|"harnesses"|"energy">}} o
 */
export function runUsageRecord({ agent, result, meta, finalized, model, turnStats, repair, gate, harness, remoteCwd, energy, cfg }) {
  const usage = agent.usageRecord(result, meta);
  // An adapter that reports no `duration_ms` (opencode, hermes) still has a wall time: derive
  // it from the run's own timestamps. Adapters that report their own (claude, cursor) keep it.
  if (usage.durationMs === undefined) {
    const d = Date.parse(meta.endedAt) - Date.parse(meta.startedAt);
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
  // Verdict-repair (#677) and gate-repair (#710): sum each extra turn's usage into this single
  // record — tokens, cost and duration add; peakContext is the max across every turn;
  // lastContext and sessionId come from the final turn, so `ah resume` picks up the latest session.
  addTurns(usage, repair, agent, meta);
  addTurns(usage, gate, agent, meta);
  // A harness may have switched the agent: name it, so follow/resume find the run's transcript.
  if (harness.harness) usage.agent = agent.describe().name;
  // ...and the harness itself, so status can sum usage per harness (`harnessUsage`).
  if (typeof harness.harness === "string" && harness.harness) usage.harness = harness.harness;
  // A remote run (#830) carries where it lived, so follow/resume can reach the session on the
  // worker: the host + the worker cwd `executor.paths()` returned. Absent on older records —
  // those sessions can't be located on the worker (`resume` says so).
  if (remoteCwd) {
    const h = typeof harness.harness === "string" ? harness.harness : undefined;
    if (h) usage.host = cfg.harnesses?.[h]?.remote?.host;
    usage.remoteCwd = remoteCwd;
  }
  // Stamp the basis (src/shared/pricing.js): a reported run keeps `costUsd` alone; otherwise an
  // API-equivalent `estUsd` from the rate table, when the model has a rate and tokens.
  const priced = costOf(usage, cfg.pricing);
  if (priced.estUsd !== undefined) usage.estUsd = priced.estUsd;
  if (priced.costBasis) usage.costBasis = priced.costBasis;
  // A third, independent figure — never folded into costUsd/estUsd/costBasis.
  const energyRec = energy && cfg.energy ? energyFields(energy.kWh, cfg.energy.usdPerKwh, cfg.energy.source.type) : null;
  if (energyRec) Object.assign(usage, energyRec);
  return usage;
}
