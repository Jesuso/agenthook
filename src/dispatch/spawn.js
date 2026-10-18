// Spawning the step's agent: argv/env, per-run log streaming, the max/idle timeouts and
// kill, the per-run file paths, and the agent's pre-spawn check.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { timeoutReason } from "./verdict.js";
import { agentEnvAllow, buildAgentEnv } from "../agent-env.js";

// How long a timed-out agent gets between SIGTERM and SIGKILL.
export const KILL_GRACE_MS = 10000;

// setTimeout fires immediately past this (~24.8 days), so clamp a huge cap to it.
const MAX_TIMER_MS = 2 ** 31 - 1;

/** The spawn env for an agent run (#470): the receiver's env filtered to the allowlist — the
 * base names, the agent CLI's `envPassthrough`, the tracker prompt's and the forge's `agentEnv`,
 * then the operator's `agentEnvPassthrough` — minus the run credentials' `strip` names, with the
 * adapter's `agent.env`, the run credentials' `env` (#474) and then the step's `env` spread on
 * top, unfiltered. Shared by `spawnAgent` and a post-exit `agent.finalize` (which never gets
 * `creds`: they are disposed by then) so the export sees the same `HERMES_HOME` the run used.
 * Never includes AGENTHOOK_VERDICT_FILE.
 * @param {{cfg: Pick<import('../types.js').Config, 'agentEnvPassthrough'>, agent: import('../types.js').AgentAdapter, meta?: import('../types.js').AdapterMeta, forge?: import('../types.js').Forge|null, agentEnv?: Record<string,string>, creds?: import('../types.js').RunCredentials|null, env?: Record<string,string>}} o
 * @returns {Record<string,string>} */
export function agentSpawnEnv({ cfg, agent, meta, forge, agentEnv, creds, env }) {
  const allow = agentEnvAllow({ agent: agent.envPassthrough, tracker: meta?.agentEnv, forge: forge?.describe?.().agentEnv, operator: cfg.agentEnvPassthrough });
  return buildAgentEnv({ source: process.env, allow, strip: creds?.strip, layers: [agentEnv, creds?.env, env] });
}

/** @param {import('./context.js').DispatchState} ctx */
export function createSpawn(ctx) {
  const { cfg, adapter, children, killGraceMs, killTimers, meta, forge } = ctx;
  /** SIGTERM now, SIGKILL after the grace (cleared when the run ends, so a recycled pid is never hit).
   * @param {string} ref @param {number} pid */
  function killNow(ref, pid) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      return false;
    }
    clearTimeout(killTimers.get(ref));
    killTimers.set(
      ref,
      setTimeout(() => {
        killTimers.delete(ref);
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }, killGraceMs).unref(),
    );
    return true;
  }

  /**
   * Spawn the step's agent with a prompt. The adapter builds the argv and parses stdout:
   * its parser renders log text and accumulates the token tally + final result record;
   * stderr also reaches the parser (`pushStderr`) and the log, raw. `onTally` fires when the
   * running token count changes (i.e. per assistant/result event, NOT per token) so the live
   * record isn't rewritten per token. `maxMs` caps the run's wall clock; `idleMs` caps the gap
   * between any output chunk, stdout or stderr. Past either the child gets SIGTERM, then
   * SIGKILL after the grace, and `timedOut` says which.
   * `bin`/`env` are the step's optional agent binary and extra environment (unset → the adapter's
   * default bin, else cfg.claudeBin, and the allowlisted env, see agentSpawnEnv); `agentEnv` (the adapter's `env`)
   * and `creds` (the run's adapter-minted credentials) sit under the step's, so a step can override
   * them; the verdict-file variable is set last so a step can't override it.
   * @param {{agent: import('../types.js').AgentAdapter, prompt: string, cwd: string, logPath: string, model?: string, effort?: string, provider?: string, toolsets?: string[], isolated?: boolean, bin?: string, agentEnv?: Record<string, string>, creds?: import('../types.js').RunCredentials|null, env?: Record<string, string>, verdictFile?: string, promptFile?: string, maxMs?: number, idleMs?: number, onPid?: (pid: number|undefined) => void, onTally?: (tally: {input:number,output:number,cacheRead:number,cacheCreate:number}) => void}} o
   * @returns {Promise<{code: number, result: any, quota: import('../quota.js').QuotaReading|null, timedOut?: "max"|"idle"}>}
   */
  function spawnAgent({ agent, prompt, cwd, logPath, model, effort, provider, toolsets, isolated, bin, agentEnv, creds, env, verdictFile, promptFile, maxMs, idleMs, onPid, onTally }) {
    const logStream = fs.createWriteStream(logPath, { flags: "a" });
    if (promptFile) {
      try {
        fs.writeFileSync(promptFile, prompt, { mode: 0o600 });
      } catch (e) {
        console.error(`[dispatch] prompt file write failed (${promptFile}):`, e.message);
      }
    }
    const args = agent.buildArgs({ prompt, model, effort, provider, fullAuto: cfg.fullAuto, promptFile, maxMs, toolsets, isolated });
    const parser = agent.createParser();
    return new Promise((resolve) => {
      const child = spawn(bin || agent.defaults.bin || cfg.claudeBin, args, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"], // close stdin -> no "no stdin data" stall
        // AGENTHOOK_VERDICT_FILE: where the agent writes its structured verdict; we
        // read it after exit to route the step (advance/hold/changes/fail).
        env: { ...agentSpawnEnv({ cfg, agent, meta, forge, agentEnv, creds, env }), ...(verdictFile ? { AGENTHOOK_VERDICT_FILE: verdictFile } : {}) },
      });
      children?.add(child);
      onPid?.(child.pid);

      /** @type {"max"|"idle"|undefined} */
      let timedOut;
      /** @type {NodeJS.Timeout|undefined} */ let maxTimer;
      /** @type {NodeJS.Timeout|undefined} */ let idleTimer;
      /** @type {NodeJS.Timeout|undefined} */ let killTimer;
      /** @param {"max"|"idle"} kind */
      const expire = (kind) => {
        if (timedOut) return;
        timedOut = kind;
        clearTimeout(maxTimer);
        clearTimeout(idleTimer);
        const minutes = ((kind === "max" ? maxMs : idleMs) ?? 0) / 60000;
        logStream.write(`\n[agenthook] killed: ${timeoutReason(kind, minutes)}\n`);
        child.kill("SIGTERM");
        killTimer = setTimeout(() => child.kill("SIGKILL"), killGraceMs);
      };
      if (maxMs) maxTimer = setTimeout(() => expire("max"), Math.min(maxMs, MAX_TIMER_MS));
      let exited = false;
      const armIdle = () => {
        if (!idleMs || timedOut || exited) return;
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => expire("idle"), Math.min(idleMs, MAX_TIMER_MS));
      };
      armIdle();
      // The child is gone, so nothing is left to time out — a timer firing now would relabel
      // a clean exit as a timeout. Its grandchildren (tool subprocesses) can still hold its
      // stdio open, delaying `close` (and the slot) indefinitely: drop our ends at once for a
      // killed child, else after the grace (time for its last output to drain).
      /** @type {NodeJS.Timeout|undefined} */ let drainTimer;
      const dropPipes = () => {
        child.stdout.destroy();
        child.stderr.destroy();
      };
      child.on("exit", () => {
        exited = true;
        clearTimeout(maxTimer);
        clearTimeout(idleTimer);
        if (timedOut) dropPipes();
        else drainTimer = setTimeout(dropPipes, killGraceMs);
      });

      let lastOut = 0;
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        armIdle();
        const text = parser.push(chunk);
        if (text) logStream.write(text);
        if (onTally && parser.tally.output !== lastOut) {
          lastOut = parser.tally.output;
          onTally(parser.tally);
        }
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        armIdle();
        parser.pushStderr?.(chunk);
        logStream.write(chunk);
      });
      child.on("close", (c) => {
        clearTimeout(maxTimer);
        clearTimeout(idleTimer);
        clearTimeout(killTimer);
        clearTimeout(drainTimer);
        const tail = parser.flush();
        if (tail) logStream.write(tail);
        children?.delete(child);
        logStream.end();
        if (promptFile) {
          try {
            fs.rmSync(promptFile, { force: true });
          } catch {
            /* best effort */
          }
        }
        resolve({ code: c ?? 1, result: parser.result, quota: parser.quota ?? null, ...(timedOut ? { timedOut } : {}) });
      });
    });
  }

  /** @param {string} stepId @param {string} ref */
  function logPathFor(stepId, ref) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const safeRef = String(ref).replace(/[^A-Za-z0-9_.-]/g, "_");
    return path.join(cfg.logDir, `${stamp}-step-${stepId}-${safeRef}.log`);
  }


  /** The path the agent writes its verdict to (one per run, under the state dir so a
   * worktree drain can't take it). @param {string} stepId @param {string} ref */
  function verdictPathFor(stepId, ref) {
    const dir = path.join(cfg.dataDir, "verdicts");
    fs.mkdirSync(dir, { recursive: true });
    const safeRef = String(ref).replace(/[^A-Za-z0-9_.-]/g, "_");
    return path.join(dir, `${safeRef}-${stepId}.json`);
  }

  /** The per-run dir an adapter's `runCredentials` may own (#474): `<dataDir>/run-creds/<safeRef>-<stepId>`.
   * Not created here — the adapter wipes and creates it. @param {string} stepId @param {string} ref */
  function runCredsDirFor(stepId, ref) {
    const safeRef = String(ref).replace(/[^A-Za-z0-9_.-]/g, "_");
    return path.join(cfg.dataDir, "run-creds", `${safeRef}-${stepId}`);
  }

  /**
   * The run's scoped credentials (#474): the forge's `runCredentials`, else the tracker's.
   * `{creds: null}` = nothing to scope (the #470 env applies). A throw becomes `refused` — the
   * run fails with that reason, written to the run log, and is never spawned; it never falls
   * back to the operator's credentials.
   * @param {import('../types.js').RunCredentialsInput} o
   * @returns {Promise<{creds: import('../types.js').RunCredentials|null, refused?: string}>}
   */
  async function runCredentials(o) {
    try {
      const creds = (await forge?.runCredentials?.(o)) ?? (await adapter.runCredentials?.(o)) ?? null;
      return { creds };
    } catch (e) {
      const refused = e?.message || String(e);
      o.log(refused);
      return { creds: null, refused };
    }
  }

  /** Append one `[agenthook] <line>` to a run log (best-effort). @param {string} logPath @param {string} line */
  function logLine(logPath, line) {
    try {
      fs.appendFileSync(logPath, `[agenthook] ${line}\n`);
    } catch (e) {
      console.error(`[run] log write failed for ${logPath}:`, e.message);
    }
  }

  /** The path an agent whose CLI takes the prompt from a file (`describe().promptFile`,
   * e.g. hermes' `--query-file`) reads it from — one per run, under the state dir;
   * `spawnAgent` removes it once the run exits. @param {string} stepId @param {string} ref */
  function promptFilePathFor(stepId, ref) {
    const dir = path.join(cfg.dataDir, "prompts");
    fs.mkdirSync(dir, { recursive: true });
    const safeRef = String(ref).replace(/[^A-Za-z0-9_.-]/g, "_");
    return path.join(dir, `${safeRef}-${stepId}.md`);
  }

  /**
   * The agent's pre-spawn check (`agent.preflight`, e.g. an isolated hermes step's home):
   * the reason to fail the run without spawning, written to the run log, else undefined.
   * A preflight that throws fails the run too — with its message.
   * @param {import('../types.js').AgentAdapter} agent @param {import('../types.js').Step} step
   * @param {string|undefined} provider @param {string} logPath
   * @returns {string|undefined}
   */
  function agentPreflight(agent, step, provider, logPath) {
    if (!agent.preflight) return undefined;
    let reason;
    try {
      reason = agent.preflight({ cfg, step, provider });
    } catch (e) {
      reason = `${agent.describe().name} preflight failed: ${e.message}`;
    }
    if (!reason) return undefined;
    try {
      fs.appendFileSync(logPath, `[agenthook] ${reason}\n`);
    } catch (e) {
      console.error(`[run] log write failed for ${logPath}:`, e.message);
    }
    return reason;
  }

  return { killNow, spawnAgent, logPathFor, verdictPathFor, promptFilePathFor, runCredsDirFor, runCredentials, logLine, agentPreflight };
}

/** @typedef {ReturnType<typeof createSpawn>} Spawn */
