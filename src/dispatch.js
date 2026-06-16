// Spawns headless `claude -p` for one pipeline step, streams output to a per-run
// log, and resolves the step's section transition on exit. Provider-blind: section
// gids and the move itself live behind the adapter (advance()).
//
// The receiver OWNS the worktree: the step that sets createsWorktree gets one made
// (shared by task ref across all its steps, cwd = it); drainWorktree removes it.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { stepPrompt } from "./prompts.js";
import { findStep } from "./pipeline.js";
import { ensureWorktree, drainWorktree, worktreePath } from "./worktree.js";

/** @param {string} file */
const readInstructions = (file) => {
  // Read fresh each run so edits to a step's standing instructions need no restart.
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
};

/**
 * @param {import('./types.js').Config} cfg
 * @param {import('./types.js').Adapter} adapter
 * @param {Set<import('node:child_process').ChildProcess>} [children]  live `claude -p` procs, for force-kill on shutdown
 * @param {import('./types.js').Store} [store]  for in-flight (crash-recovery) records
 */
export function createDispatcher(cfg, adapter, children, store) {
  const meta = adapter.describe();

  /**
   * Spawn `claude -p` with a prompt, stream to a log, resolve the exit code.
   * @param {{prompt: string, cwd: string, logPath: string, model?: string, onPid?: (pid: number|undefined) => void}} o
   * @returns {Promise<number>}
   */
  function spawnClaude({ prompt, cwd, logPath, model, onPid }) {
    const logStream = fs.createWriteStream(logPath, { flags: "a" });
    const args = ["-p", prompt];
    if (model) args.push("--model", model);
    if (cfg.fullAuto) args.push("--dangerously-skip-permissions");
    return new Promise((resolve) => {
      const child = spawn(cfg.claudeBin, args, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"], // close stdin -> no "no stdin data" stall
        env: { ...process.env },
      });
      children?.add(child);
      onPid?.(child.pid);
      child.stdout.pipe(logStream);
      child.stderr.pipe(logStream);
      child.on("close", (c) => {
        children?.delete(child);
        logStream.end();
        resolve(c ?? 1);
      });
    });
  }

  /** @param {string} stepId @param {string} ref */
  function logPathFor(stepId, ref) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const safeRef = String(ref).replace(/[^A-Za-z0-9_.-]/g, "_");
    return path.join(cfg.logDir, `${stamp}-step-${stepId}-${safeRef}.log`);
  }

  /** @param {import('./types.js').Job} job */
  return async function runClaude(job) {
    const step = findStep(cfg, job.stepId);
    if (!step) throw new Error(`unknown pipeline step "${job.stepId}"`);
    const task = await adapter.fetchTask(job.ref);

    // Manual stage (e.g. "done"): no agent — entering it only runs system actions.
    if (step.manual) {
      if (step.drainWorktree) {
        try {
          if (drainWorktree(cfg, job.ref)) console.log(`[worktree] drained ${job.ref} (${step.id})`);
        } catch (e) {
          console.error(`[worktree] drain failed for ${job.ref}:`, e.message);
        }
      }
      return { kind: job.kind, ref: job.ref, name: task.name, url: task.url, code: 0 };
    }

    // System-owned worktree: create it on the step that declares createsWorktree,
    // otherwise reuse the one an earlier step made (same deterministic path).
    let worktree = worktreePath(cfg, job.ref);
    let branch;
    if (step.createsWorktree) {
      const wt = ensureWorktree(cfg, job.ref);
      worktree = wt.worktree;
      branch = wt.branch;
      console.log(`[worktree] ${wt.created ? "created" : "reuse"} ${worktree} (branch ${branch})`);
    }
    const hasWorktree = fs.existsSync(worktree);
    const cwd = hasWorktree ? worktree : cfg.repoPath;

    const standing = readInstructions(step.instructionsFile || cfg.instructionsFile);
    const base = stepPrompt(task, meta, step, { worktree: hasWorktree ? worktree : undefined, branch });
    const prompt = standing ? `${standing}\n\n=== TICKET ===\n\n${base}` : base;

    const logPath = logPathFor(step.id, job.ref);
    console.log(`[run] step ${step.id} ${job.ref} "${task.name}" -> ${logPath}`);

    const code = await spawnClaude({
      prompt,
      cwd,
      logPath,
      model: step.model,
      onPid: (pid) =>
        store?.setRunning(job.ref, { stepId: step.id, pid, startedAt: new Date().toISOString(), worktree: cwd }),
    });
    store?.clearRunning(job.ref);

    // Drain before advancing, so the worktree is gone by the time the next stage looks.
    if (code === 0 && step.drainWorktree) {
      try {
        if (drainWorktree(cfg, job.ref)) console.log(`[worktree] drained ${job.ref} (${step.id})`);
      } catch (e) {
        console.error(`[worktree] drain failed for ${job.ref}:`, e.message);
      }
    }

    // Resolve the transition. P1: clean exit advances, anything else fails. The move
    // to the next section is itself the event that fires the next step.
    const outcome = code === 0 ? "advance" : "fail";
    try {
      await adapter.advance(job.ref, step.id, outcome);
    } catch (e) {
      console.error(`[advance] ${step.id} ${job.ref} (${outcome}) failed:`, e.message);
    }

    return { kind: job.kind, ref: job.ref, name: task.name, url: task.url, code };
  };
}
