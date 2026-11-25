// Spawning the step's agent: argv/env, per-run log streaming, the max/idle timeouts and
// kill, the per-run file paths, and the agent's pre-spawn check.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { timeoutReason } from "./verdict.js";
import { containerEnv, runtimeEnv } from "./sandbox.js";
import { agentEnvAllow, buildAgentEnv, redactSecrets } from "../agent-env.js";
import { modelApiFailure } from "./harness.js";
import { classifySshFailure, sshConfigFailureReason } from "./executor-ssh.js";

/** How much of a run's rendered stdout + raw stderr the harness breaker's connection-failure scan
 * (`modelApiFailure`) keeps, tail-bounded — enough for the one line that matters, not the whole run. */
const API_SCAN_BUF_BYTES = 64 * 1024;

/** How much of a run's RENDERED stdout (stdout only, stderr excluded) the harness keeps to detect a
 * run that ended its turn on a question (the question-hold reason, verdict.js `endedWithQuestion`) —
 * the final line lives in the last few KB, so this is far smaller than the API-scan buffer. */
const STDOUT_TAIL_BUF_BYTES = 4 * 1024;

/** How much of a run's raw STDERR (stderr only) is kept to pull the breaker's `errorLine` (#688)
 * from when the final result carries no text — same size as the stdout tail, for the same reason. */
const STDERR_TAIL_BUF_BYTES = 4 * 1024;

/** The last non-blank, trimmed line of `s`; undefined when `s` is empty/undefined or all blank.
 * @param {string|undefined} s @returns {string|undefined} */
function lastNonBlankLine(s) {
  if (!s) return undefined;
  const lines = s.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1] : undefined;
}

/** The defined subset of a parser's per-turn stats (#645), or undefined when the parser never
 * saw a turn (`tally.turns` unset) — so a result with no per-turn usage adds nothing to the
 * record rather than zeros. `compactions` (#657) rides along the same guard — a tally without
 * `turns` carries no `compactions` either, even when the agent can detect them. Pure.
 * @param {{turns?: number, firstContext?: number, peakContext?: number, lastContext?: number, compactions?: number}} tally
 * @returns {{turns: number, firstContext?: number, peakContext?: number, lastContext?: number, compactions?: number}|undefined} */
export function pickTurnStats(tally) {
  if (typeof tally.turns !== "number") return undefined;
  /** @type {{turns: number, firstContext?: number, peakContext?: number, lastContext?: number, compactions?: number}} */
  const out = { turns: tally.turns };
  if (typeof tally.firstContext === "number") out.firstContext = tally.firstContext;
  if (typeof tally.peakContext === "number") out.peakContext = tally.peakContext;
  if (typeof tally.lastContext === "number") out.lastContext = tally.lastContext;
  if (typeof tally.compactions === "number") out.compactions = tally.compactions;
  return out;
}

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

/** The path the agent writes its verdict to (one per run, under the state dir so a
 * worktree drain can't take it). @param {import('../types.js').Config} cfg @param {string} stepId @param {string} ref */
export function verdictPathFor(cfg, stepId, ref) {
  const dir = path.join(cfg.dataDir, "verdicts");
  fs.mkdirSync(dir, { recursive: true });
  const safeRef = String(ref).replace(/[^A-Za-z0-9_.-]/g, "_");
  return path.join(dir, `${safeRef}-${stepId}.json`);
}

/** A sandboxed run's verdict path: its own dir (`verdicts/run-<ref>-<step>/`, 0700, emptied
 * first), the only one mounted into its container — mounting `verdicts/` would let one
 * ticket's agent write another running ticket's verdict. @param {import('../types.js').Config} cfg @param {string} stepId @param {string} ref */
export function sandboxVerdictPathFor(cfg, stepId, ref) {
  const safeRef = String(ref).replace(/[^A-Za-z0-9_.-]/g, "_");
  const dir = path.join(cfg.dataDir, "verdicts", `run-${safeRef}-${stepId}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return path.join(dir, "verdict.json");
}

/** @param {import('./context.js').DispatchState} ctx */
export function createSpawn(ctx) {
  const { cfg, adapter, children, killGraceMs, killTimers, meta, forge, sandbox, executorRuns, cancelled } = ctx;
  /** SIGTERM now, SIGKILL after the grace (cleared when the run ends, so a recycled pid is never hit).
   * A sandboxed run's pid is the runtime client's, whose SIGKILL would leave the container
   * running: an operator stop force-stops the container too, right away.
   * @param {string} ref @param {number} pid */
  function killNow(ref, pid) {
    // A live stdin pipe (an ssh run, #689): end it first — some ssh clients forward a closed
    // local stdin as an immediate half-close, which is often faster than waiting on the SIGTERM
    // below to tear the connection down.
    for (const child of children ?? []) {
      if (child.pid === pid) child.stdin?.end();
    }
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      return false;
    }
    executorRuns.get(ref)?.kill().catch((e) => console.error(`[sandbox] kill failed for ${ref}: ${e.message}`));
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
   * and `creds` (the run's adapter-minted credentials, #474) sit under the step's, so a step can override
   * them; the verdict-file variable is set last so a step can't override it.
   * `sandboxed` runs it through the profile's sandbox instead: `wrap()` turns the same argv and
   * env (minus host-only keys, plus `sandboxed.env`) into a runtime-client spawn with `mounts`
   * and `egress` (the run's network policy), in the harness's `image` when it has one;
   * a `wrap()` rejection fails the run (`refused`) with nothing spawned. The run's sandbox report
   * comes back as `sandboxReport`.
   * A spawn that errors (e.g. ENOENT: the bin is missing) never throws: it is written to the log
   * and comes back as `spawnError` once the child closes. `noOutput` says the parser counted no
   * model output tokens (the harness breaker's fast-exit signal). `apiDown` is the first
   * connection-level model-API failure line found in a bounded tail of the run's rendered stdout,
   * raw stderr and final result text (the harness breaker's any-duration signal, src/dispatch/harness.js).
   * `resumeSessionId` (#677): a verdict-repair turn resuming the same session — the argv comes
   * from `agent.resumeArgs` (same options plus the session id) instead of `buildArgs`; everything
   * else (env incl. AGENTHOOK_VERDICT_FILE, the sandbox wrap, timers, parser, the same `logPath`
   * appended to) is unchanged. Ignored when the agent has no `resumeArgs`.
   * @param {{agent: import('../types.js').AgentAdapter, prompt: string, cwd: string, logPath: string, model?: string, effort?: string, provider?: string, toolsets?: string[], isolated?: boolean, allow?: import('../types.js').StepPolicy, deny?: import('../types.js').StepPolicy, bin?: string, agentEnv?: Record<string, string>, creds?: import('../types.js').RunCredentials|null, env?: Record<string, string>, verdictFile?: string, promptFile?: string, maxMs?: number, idleMs?: number, onPid?: (pid: number|undefined) => void, onTally?: (tally: {input:number,output:number,cacheRead:number,cacheCreate:number,lastContext?:number}) => void,
    *   sandboxed?: {ref: string, stepId: string, step: import('../types.js').Step, mounts: import('../types.js').SandboxMount[], env?: Record<string, string>, egress?: import('../types.js').SandboxEgress, image?: string, files?: {dst: string, content: string, mode?: number}[], args?: string[], hub?: {repoId: string, repoPath: string, worktree?: string, branch?: string}}, executor?: import('../types.js').Executor, resumeSessionId?: string}} o
   * `lastText` is the run's last output the question-hold detector inspects: the final result text
   * when the parser captured one (a non-empty string), else the tail of the run's rendered stdout
   * (stdout only) — `undefined` when neither produced anything.
   * `errorLine` (#688) is the breaker's agent-side detail for its fast-exit reason: the last
   * non-blank line of the final result text when there is one, else of a small raw-stderr tail —
   * redacted (src/agent-env.js redactSecrets) and clipped to 200 chars; absent when there is none.
   * @returns {Promise<{code: number, result: any, quota: import('../quota.js').QuotaReading|null, turnStats?: {turns: number, firstContext?: number, peakContext?: number, lastContext?: number, compactions?: number}, timedOut?: "max"|"idle", refused?: string, sandboxReport?: import('../types.js').SandboxReport, spawnError?: string, unreachable?: string, sshConfigFailure?: string, noOutput?: boolean, apiDown?: string, lastText?: string, errorLine?: string}>}
   */
  async function spawnAgent({ agent, prompt, cwd, logPath, model, effort, provider, toolsets, isolated, allow, deny, bin, agentEnv, creds, env, verdictFile, promptFile, maxMs, idleMs, onPid, onTally, sandboxed, executor, resumeSessionId }) {
    const logStream = fs.createWriteStream(logPath, { flags: "a" });
    if (promptFile) {
      try {
        fs.writeFileSync(promptFile, prompt, { mode: 0o600 });
      } catch (e) {
        console.error(`[dispatch] prompt file write failed (${promptFile}):`, e.message);
      }
    }
    const argOpts = { prompt, model, effort, provider, fullAuto: cfg.fullAuto, attribution: cfg.attribution, promptFile, maxMs, toolsets, isolated, allow, deny, cwd, verdictFile };
    const args = resumeSessionId && agent.resumeArgs ? agent.resumeArgs({ ...argOpts, sessionId: resumeSessionId }) : agent.buildArgs(argOpts);
    // The sandbox hook's extra agent flags (pi: --append-system-prompt files) go right before
    // the argv's `--` separator (or at the end when there is none), applied to repair turns too.
    if (sandboxed?.args?.length) {
      const sep = args.indexOf("--");
      if (sep === -1) args.push(...sandboxed.args);
      else args.splice(sep, 0, ...sandboxed.args);
    }
    const agentBin = bin || agent.defaults.bin || cfg.claudeBin;
    // AGENTHOOK_VERDICT_FILE: where the agent writes its structured verdict; we
    // read it after exit to route the step (advance/hold/changes/fail).
    const runEnv = { ...agentSpawnEnv({ cfg, agent, meta, forge, agentEnv, creds, env }), ...(sandboxed?.env ?? {}), ...(verdictFile ? { AGENTHOOK_VERDICT_FILE: verdictFile } : {}) };
    /** @type {{bin: string, args: string[], env: Record<string, string>}} */
    let launch = { bin: agentBin, args, env: runEnv };
    /** @type {import('../types.js').ExecutorRun|undefined} */
    let box;
    if (sandboxed && executor) {
      const { ref } = sandboxed;
      /** Nothing was (or will be) spawned: close the log, drop the prompt file. @param {string} [note] */
      const unspawned = (note) => {
        if (note) logStream.write(`[agenthook] ${note}\n`);
        logStream.end();
        if (promptFile) fs.rmSync(promptFile, { force: true });
      };
      try {
        box = await executor.launch({ runId: path.basename(logPath, ".log"), ref, stepId: sandboxed.stepId, bin: agentBin, defaultBin: agent.defaults.bin, args, env: containerEnv(runEnv), cwd, mounts: sandboxed.mounts, step: sandboxed.step, prompt, ...(sandboxed.egress ? { egress: sandboxed.egress } : {}), ...(sandboxed.image ? { image: sandboxed.image } : {}), ...(sandboxed.files ? { files: sandboxed.files } : {}), ...(sandboxed.hub ? { hub: sandboxed.hub } : {}), ...(sandboxed.env ? { remoteEnv: sandboxed.env } : {}), ...(resumeSessionId ? { resume: true } : {}) });
      } catch (e) {
        // A classified ssh sync failure (#828) already carries its user-facing reason: a
        // misconfigured worker is a refusal with that exact text (no "executor could not start"
        // wrapper), and an unreachable worker keeps the raw reason in `refused` while the
        // `unreachable` marker is what finish.js hands to the breaker (a trip requeues; it never
        // fails the ticket).
        const classified = /** @type {{sshConfigFailure?: string}} */ (e).sshConfigFailure;
        const reason = classified ?? (executor.name === "sandbox" ? `sandbox (${sandbox?.describe().name}) could not start the run: ${e.message}` : `${executor.name} executor could not start the run: ${e.message}`);
        unspawned(reason);
        return { code: 1, result: null, quota: null, refused: reason, ...(e.unreachable ? { unreachable: /** @type {{unreachable?: string}} */ (e).unreachable } : {}), ...(classified ? { sshConfigFailure: classified } : {}) };
      }
      executorRuns.set(ref, box);
      // A cancel that landed while launch() was pending: never spawn.
      if (cancelled.has(ref)) {
        await box.kill().catch((e) => console.error(`[sandbox] kill failed for ${ref}: ${e.message}`));
        await box.done().catch(() => {});
        executorRuns.delete(ref);
        unspawned();
        return { code: 1, result: null, quota: null };
      }
      launch = { bin: box.bin, args: box.args, env: { ...runtimeEnv(process.env), ...box.env } };
    }
    const run = box;
    const parser = agent.createParser();
    // An ssh run (#689): its env+prompt travel over the LOCAL ssh client's own stdin (never
    // argv), kept open until exit or kill — closing it is itself one of the remote launcher's
    // kill signals. Every other run closes stdin at once (no "no stdin data" stall).
    const stdinPayload = box?.stdin;
    return new Promise((resolve) => {
      // Always piped (never "ignore"): a conditional stdio kind would lose spawn()'s literal-tuple
      // typing (every stream would type as possibly-null). A run with no payload ends its stdin
      // at once below — the same "no stdin data" outcome "ignore" gave host/sandbox runs.
      const child = spawn(launch.bin, launch.args, {
        cwd: executor?.name === "ssh" ? undefined : cwd, // cwd is the AGENT's path (the worker's), meaningless for the local ssh client's own cwd
        stdio: ["pipe", "pipe", "pipe"],
        env: launch.env,
      });
      // `child.stdin`'s own `error` event is distinct from the child's: ssh exiting before it
      // reads stdin (e.g. an unreachable host, 255) makes the write below fail EPIPE on its own
      // stream, which with no listener is an uncaught exception that kills the receiver — the
      // exact run the 255/spawnError path below exists to report, so this must never throw.
      child.stdin.on("error", (e) => {
        logStream.write(`[agenthook] stdin write failed: ${e.message}\n`);
      });
      if (stdinPayload !== undefined) child.stdin.write(stdinPayload);
      else child.stdin.end();
      children?.add(child);
      /** @type {string|undefined} */
      let spawnError;
      // An ssh exit-255 classified as an auth/host-key config failure (#828): the worker answers
      // but the connection is misconfigured. Carried out as `refused` (the run fails without a
      // verdict) AND as `sshConfigFailure`, which finish.js uses to keep the breaker from
      // tripping on it — a config failure is never retried.
      /** @type {string|undefined} */
      let sshConfigFailure;
      // An ssh exit-255 classified as an UNREACHABLE worker (#828): a harness health signal — the
      // `unreachable` marker is what finish.js hands to the breaker (a trip requeues; it never
      // fails the ticket) and `refused` carries the same reason so a run without a harness fails
      // on it instead of falling through to the verdict file. Carried out the same way as the
      // sync-path marker (the launch() rejection above), never as `spawnError` — so the trip
      // reason is `worker unreachable: <host> (…)`, verbatim and identical for sync and launch.
      /** @type {string|undefined} */
      let unreachable;
      // Without a listener a spawn error (a missing bin) is an uncaught `error` event that takes
      // the whole receiver down; `close` still follows, so the run resolves there as failed.
      child.on("error", (e) => {
        spawnError ??= e.message;
        logStream.write(`[agenthook] spawn failed: ${e.message}\n`);
      });
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
        child.stdin?.end(); // an ssh run (#689): a closed local stdin can tear the connection down faster than SIGTERM alone
        child.kill("SIGTERM");
        killTimer = setTimeout(() => {
          child.kill("SIGKILL");
          run?.kill().catch((e) => console.error(`[sandbox] kill failed for ${run.id}: ${e.message}`)); // the client's SIGKILL alone leaves the container running
        }, killGraceMs);
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

      // The harness breaker's any-duration signal (src/dispatch/harness.js modelApiFailure):
      // a tail-bounded buffer of rendered stdout + raw stderr, scanned once the run closes.
      let apiBuf = "";
      /** @param {string} s */
      const bufferApi = (s) => {
        if (!s) return;
        apiBuf = (apiBuf + s).slice(-API_SCAN_BUF_BYTES);
      };
      // Rendered stdout only (stderr excluded), for the question-hold detector: it inspects the
      // last line of what the agent printed, so a small tail suffices.
      let stdoutTail = "";
      /** @param {string} s */
      const bufferStdout = (s) => {
        if (!s) return;
        stdoutTail = (stdoutTail + s).slice(-STDOUT_TAIL_BUF_BYTES);
      };
      // Raw stderr, tail-bounded, for the breaker's errorLine (#688) when the result carries no text.
      let stderrTail = "";
      /** @param {string} s */
      const bufferStderr = (s) => {
        if (!s) return;
        stderrTail = (stderrTail + s).slice(-STDERR_TAIL_BUF_BYTES);
      };

      let lastOut = 0;
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        armIdle();
        const text = parser.push(chunk);
        if (text) logStream.write(text);
        bufferApi(text);
        bufferStdout(text);
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
        bufferApi(chunk);
        bufferStderr(chunk);
      });
      child.on("close", async (c) => {
        clearTimeout(maxTimer);
        clearTimeout(idleTimer);
        clearTimeout(killTimer);
        clearTimeout(drainTimer);
        const tail = parser.flush();
        if (tail) logStream.write(tail);
        bufferApi(tail);
        bufferStdout(tail);
        if (typeof parser.result?.result === "string") bufferApi(parser.result.result);
        // ssh's own exit 255 with no model output (#689) means the connection/launcher itself
        // failed (auth, host unreachable, the remote script erroring before the agent ran) — a
        // harness-health signal at any wall time, not a 0-attempt non-zero exit from the agent.
        if (!spawnError && executor?.name === "ssh" && c === 255 && !(parser.tally.output > 0)) {
          // Exit 255 is ssh's own failure code: classify it (#828). An unreachable worker is a
          // harness health signal — the `unreachable` marker trips the breaker with the verbatim
          // `worker unreachable: <host> (<detail>)` reason (no `spawn failed:` prefix); auth/
          // host-key is a worker config failure (refuse, never retried) whose reason names the
          // class and the ssh line; anything else keeps the generic reason.
          const cls = classifySshFailure(stderrTail);
          if (cls?.kind === "unreachable") {
            unreachable = `worker unreachable: ${executor.host ?? "remote"} (${cls.detail})`;
          } else if (cls?.kind === "config") {
            sshConfigFailure = sshConfigFailureReason(executor.host ?? "remote", cls);
          } else {
            spawnError = `ssh failed (exit ${c})`;
          }
        }
        const apiDown = modelApiFailure(apiBuf);
        // The run's last output the question-hold detector inspects: the final result text when the
        // parser captured one (a non-empty string), else the tail of its rendered stdout. Omitted
        // when neither produced anything, so a run with no output can't trip the question-hold.
        const resultText = typeof parser.result?.result === "string" && parser.result.result ? parser.result.result : undefined;
        const lastText = resultText ?? (stdoutTail ? stdoutTail : undefined);
        // The breaker's errorLine (#688): the agent's own last word, not just the receiver's "no
        // output" observation — the final result text's last line when there is one, else the
        // stderr tail's; redacted (the run's spawn env + ours, so a leaked token never reaches a
        // harness_down reason) and clipped well short of the reason's own 300-char bound.
        const rawErrorLine = lastNonBlankLine(resultText) ?? lastNonBlankLine(stderrTail);
        // Redact against each env in turn (not a merged object) so a host value a run env
        // overrides with a different value still gets masked.
        const errorLine = rawErrorLine ? redactSecrets(redactSecrets(rawErrorLine, process.env), runEnv).slice(0, 200) : undefined;
        children?.delete(child);
        /** @type {import('../types.js').SandboxReport|undefined} */
        let sandboxReport;
        if (run && sandboxed) {
          // A killed client may have left its container behind: make sure it is gone.
          try {
            if (timedOut || cancelled.has(sandboxed.ref)) await run.kill();
            sandboxReport = await run.done();
          } catch (e) {
            console.error(`[sandbox] post-run cleanup failed for ${run.id}: ${e.message}`);
          }
          executorRuns.delete(sandboxed.ref);
          for (const note of sandboxReport?.notes ?? []) logStream.write(`[agenthook] ${note}\n`);
        }
        logStream.end();
        if (promptFile) {
          try {
            fs.rmSync(promptFile, { force: true });
          } catch {
            /* best effort */
          }
        }
        const turnStats = pickTurnStats(parser.tally);
        resolve({ code: c ?? 1, result: parser.result, quota: parser.quota ?? null, ...(turnStats ? { turnStats } : {}), ...(timedOut ? { timedOut } : {}), ...(sandboxReport ? { sandboxReport } : {}), ...(spawnError ? { spawnError } : {}), ...(unreachable ? { refused: unreachable, unreachable } : {}), ...(sshConfigFailure ? { refused: sshConfigFailure, sshConfigFailure } : {}), noOutput: !(parser.tally.output > 0), ...(apiDown ? { apiDown } : {}), ...(lastText ? { lastText } : {}), ...(errorLine ? { errorLine } : {}) });
      });
    });
  }

  /** @param {string} stepId @param {string} ref */
  function logPathFor(stepId, ref) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const safeRef = String(ref).replace(/[^A-Za-z0-9_.-]/g, "_");
    return path.join(cfg.logDir, `${stamp}-step-${stepId}-${safeRef}.log`);
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
   * A preflight that throws fails the run too — with its message. A step `allow`/`deny` policy
   * the agent can't enforce (`describe().policy`) is refused first: it never runs unrestricted.
   * Then a sandboxed run of an agent with no `sandbox` hook: it never falls back to the host silently.
   * `health` is set only when the agent's own preflight refused — the one branch that says the
   * backend is down (the harness breaker's signal); the policy and sandbox refusals are config.
   * @param {import('../types.js').AgentAdapter} agent @param {import('../types.js').Step} step
   * @param {string|undefined} provider @param {string} logPath
   * @param {{sandboxed?: boolean, env?: Record<string, string>}} [o]  `env` = the spawn env (agentSpawnEnv)
   * @returns {{reason: string, health?: true}|undefined}
   */
  function agentPreflight(agent, step, provider, logPath, { sandboxed = false, env } = {}) {
    let reason;
    let health = false;
    const policy = agent.describe().policy;
    const unenforced = /** @type {const} */ (["allow", "deny"]).find((k) => step[k] && !policy?.[k]);
    if (unenforced) {
      reason = `${agent.describe().name} cannot enforce step "${step.id}" ${unenforced} policy — the run is refused rather than run unrestricted (see agenthook doctor)`;
    } else if (sandboxed && !agent.sandbox) {
      reason = `${agent.describe().name} does not support the sandbox yet — the run is refused rather than run on the host (set "sandbox": false on step "${step.id}" to run it unsandboxed)`;
    } else if (agent.preflight) {
      try {
        reason = agent.preflight({ cfg, step, provider, sandboxed, env });
      } catch (e) {
        reason = `${agent.describe().name} preflight failed: ${e.message}`;
      }
      health = !!reason;
    }
    if (!reason) return undefined;
    try {
      fs.appendFileSync(logPath, `[agenthook] ${reason}\n`);
    } catch (e) {
      console.error(`[run] log write failed for ${logPath}:`, e.message);
    }
    return { reason, ...(health ? { health: /** @type {const} */ (true) } : {}) };
  }

  return {
    killNow,
    spawnAgent,
    logPathFor,
    verdictPathFor: (/** @type {string} */ stepId, /** @type {string} */ ref) => verdictPathFor(cfg, stepId, ref),
    sandboxVerdictPathFor: (/** @type {string} */ stepId, /** @type {string} */ ref) => sandboxVerdictPathFor(cfg, stepId, ref),
    promptFilePathFor,
    runCredsDirFor,
    runCredentials,
    logLine,
    agentPreflight,
  };
}

/** @typedef {ReturnType<typeof createSpawn>} Spawn */
