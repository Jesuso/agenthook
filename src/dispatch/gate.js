// A step's gate (#710): a command the receiver runs, in the run's own executor, after an
// `advance` and before the move — it can only veto that advance, never grant one. Always goes
// through the run's executor (host/sandbox/ssh); never a host spawn for a sandboxed or ssh run.
import { spawn } from "node:child_process";
import { redactSecrets } from "../agent-env.js";
import { containerEnv, runtimeEnv } from "./sandbox.js";
import { KILL_GRACE_MS } from "./spawn.js";

/** Tail of gate output kept for the hold reason / repair prompt, same size as the harness's own
 * question-hold stdout tail (src/dispatch/spawn.js STDOUT_TAIL_BUF_BYTES). */
const GATE_TAIL_BUF_BYTES = 4 * 1024;

/** One gate run's result (#710). `exitCode` null + `timedOut` = the timeout kill; `refused` = the
 * executor had no way to run the gate at all (not a gate failure — a hold reason in its own right). */
/** @typedef {{exitCode: number|null, timedOut: boolean, durationMs: number, tail: string, refused?: string}} GateResult */

/**
 * Run a step's `gate` to veto (never grant) an `advance`. Always goes through `executor`: host
 * spawns the argv directly in `cwd`; sandbox wraps it through `executor.launch` with the run's
 * own mounts/egress/image, then spawns the wrapped client command; ssh runs it on the worker via
 * a `raw` launch (code already synced there by the main run). An executor with no way to run a
 * gate (an unrecognized `executor.name`) vetoes with a reason instead of falling back to the host.
 * @param {{executor: import('../types.js').Executor, sandboxedRun?: {mounts: import('../types.js').SandboxMount[], step: import('../types.js').Step, env?: Record<string,string>, egress?: import('../types.js').SandboxEgress, image?: string, hub?: {repoId: string, repoPath: string, worktree?: string, branch?: string}}, argv: string[], cwd: string, env: Record<string,string>, timeoutMs: number, ref: string, stepId: string, runId: string, logPath: string, pids: Map<string, number>, executorRuns: Map<string, import('../types.js').ExecutorRun>, cancelled: Set<string>, logLine: (logPath: string, line: string) => void}} o
 * @returns {Promise<{exitCode: number|null, timedOut: boolean, durationMs: number, tail: string, refused?: string}>}
 */
export async function runGate({ executor, sandboxedRun, argv, cwd, env, timeoutMs, ref, stepId, runId, logPath, pids, executorRuns, cancelled, logLine }) {
  const started = Date.now();
  const bin = argv[0];
  const args = argv.slice(1);
  /** @type {{bin: string, args: string[], env: Record<string,string>}} */
  let launch = { bin, args, env };
  /** @type {import('../types.js').ExecutorRun|undefined} */
  let box;
  if (executor.name === "sandbox") {
    try {
      box = await executor.launch({ runId, ref, stepId, bin, args, env: containerEnv(env), cwd, mounts: sandboxedRun?.mounts ?? [], step: /** @type {import('../types.js').Step} */ (sandboxedRun?.step), ...(sandboxedRun?.egress ? { egress: sandboxedRun.egress } : {}), ...(sandboxedRun?.image ? { image: sandboxedRun.image } : {}) });
    } catch (e) {
      return { exitCode: null, timedOut: false, durationMs: Date.now() - started, tail: "", refused: `gate could not start on the sandbox executor: ${e.message}` };
    }
    executorRuns.set(ref, box);
    launch = { bin: box.bin, args: box.args, env: { ...runtimeEnv(process.env), ...box.env } };
  } else if (executor.name === "ssh") {
    try {
      box = await executor.launch({ runId, ref, stepId, bin, args, env, cwd, mounts: [], step: /** @type {import('../types.js').Step} */ (sandboxedRun?.step), ...(sandboxedRun?.hub ? { hub: sandboxedRun.hub } : {}), raw: true });
    } catch (e) {
      return { exitCode: null, timedOut: false, durationMs: Date.now() - started, tail: "", refused: `gate could not start on the ssh executor: ${e.message}` };
    }
    executorRuns.set(ref, box);
    launch = { bin: box.bin, args: box.args, env: { ...runtimeEnv(process.env), ...box.env } };
  } else if (executor.name !== "host") {
    return { exitCode: null, timedOut: false, durationMs: Date.now() - started, tail: "", refused: `gate cannot run on the ${executor.name} executor` };
  }

  return new Promise((resolve) => {
    // Own process group (like src/energy-sampler.js): a gate that is a test runner or build tool
    // commonly forks grandchildren, which can hold stdout/stderr open (or keep running) past the
    // direct child's own exit. Killing -pid (the whole group) on timeout, not just the child, is
    // what actually stops it; killing only the child left a `sleep` grandchild alive for its full
    // duration in testing.
    const child = spawn(launch.bin, launch.args, {
      cwd: executor.name === "host" ? cwd : undefined,
      stdio: ["pipe", "pipe", "pipe"],
      env: launch.env,
      detached: true,
    });
    child.stdin.on("error", () => {});
    if (box?.stdin !== undefined) child.stdin.write(box.stdin);
    else child.stdin.end();
    pids.set(ref, /** @type {number} */ (child.pid));

    let tail = "";
    /** @param {string} s */
    const append = (s) => {
      if (!s) return;
      const redacted = redactSecrets(redactSecrets(s, process.env), env);
      tail = (tail + redacted).slice(-GATE_TAIL_BUF_BYTES);
      try {
        logLine(logPath, redacted.trimEnd());
      } catch {
        /* best effort */
      }
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d) => append(d));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d) => append(d));

    /** @param {NodeJS.Signals} sig */
    const killGroup = (sig) => {
      try {
        if (child.pid) process.kill(-child.pid, sig);
      } catch {
        try {
          child.kill(sig);
        } catch {
          /* already gone */
        }
      }
    };

    let timedOut = false;
    /** @type {NodeJS.Timeout|undefined} */
    let killTimer;
    /** @type {NodeJS.Timeout|undefined} */
    let dropTimer;
    const dropPipes = () => {
      child.stdout.destroy();
      child.stderr.destroy();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup("SIGTERM");
      killTimer = setTimeout(() => {
        killGroup("SIGKILL");
        // A grandchild holding our end of stdout/stderr could otherwise delay `close`
        // indefinitely even after the whole group is dead.
        dropTimer = setTimeout(dropPipes, KILL_GRACE_MS);
      }, KILL_GRACE_MS);
    }, timeoutMs);

    child.on("error", (e) => append(`[agenthook] gate spawn failed: ${e.message}\n`));
    child.on("close", async (code) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      clearTimeout(dropTimer);
      if (box) {
        try {
          if (timedOut || cancelled.has(ref)) await box.kill();
          await box.done();
        } catch (e) {
          console.error(`[gate] cleanup failed for ${ref}: ${e.message}`);
        }
        executorRuns.delete(ref);
      }
      pids.delete(ref);
      resolve({ exitCode: timedOut ? null : code, timedOut, durationMs: Date.now() - started, tail });
    });
  });
}
