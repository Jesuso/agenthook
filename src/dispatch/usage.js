// Post-exit usage capture (agent.finalize) and per-run energy sampling.
import fs from "node:fs";
import path from "node:path";
import { agentSpawnEnv } from "./spawn.js";

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
   * @param {import('../types.js').AgentAdapter} agent
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
