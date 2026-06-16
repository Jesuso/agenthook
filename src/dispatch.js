// Spawns headless `claude -p` for one job, streams output to a per-run log, then
// asks the provider to ensure a comment-watch hook exists (so future "@agent ..."
// comments re-trigger). Provider-blind: everything platform-specific comes through
// the adapter.
//
// Two flows share the spawn plumbing:
//   - legacy    implement/change jobs → cwd = repoPath, agent makes its own worktree,
//               section moves via onStart/onFinish.
//   - pipeline  step jobs → the RECEIVER owns the worktree (cwd = worktree) and the
//               section moves (adapter.advance on a clean/failed exit), keyed by stepId.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { implementPrompt, changePrompt, stepPrompt } from "./prompts.js";
import { createDigest } from "./digest.js";
import { findStep } from "./pipeline.js";
import { ensureWorktree, drainWorktree, worktreePath } from "./worktree.js";

/** @param {string} file */
const readInstructions = (file) => {
  // Read fresh each run so edits to standing instructions need no restart.
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
  // Independent sign-off digest, off unless cfg.digest === true. Runs as its own
  // memory-less `claude -p` after a clean author exit (legacy flow only).
  const runDigest = createDigest(cfg, adapter, children);

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

  /** @param {string} kind @param {string} ref */
  const logPathFor = (kind, ref) => {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const safeRef = String(ref).replace(/[^A-Za-z0-9_.-]/g, "_");
    return path.join(cfg.logDir, `${stamp}-${kind}-${safeRef}.log`);
  };

  /**
   * Pipeline step: the receiver owns the worktree and the section transition.
   * @param {import('./types.js').Job} job
   */
  async function runPipelineStep(job) {
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
    const cwd = fs.existsSync(worktree) ? worktree : cfg.repoPath;

    const standing = readInstructions(step.instructionsFile || cfg.instructionsFile);
    const base = stepPrompt(task, meta, step, { worktree: fs.existsSync(worktree) ? worktree : undefined, branch });
    const prompt = standing ? `${standing}\n\n=== TICKET ===\n\n${base}` : base;

    const logPath = logPathFor(`step-${step.id}`, job.ref);
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

    // Comment hook so future "@agent ..." re-triggers a change on this task.
    try {
      await adapter.ensureCommentWebhook(job.ref);
    } catch (e) {
      console.error(`[hook] ensure failed:`, e.message);
    }

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
      await adapter.advance?.(job.ref, step.id, outcome);
    } catch (e) {
      console.error(`[advance] ${step.id} ${job.ref} (${outcome}) failed:`, e.message);
    }

    return { kind: job.kind, ref: job.ref, name: task.name, url: task.url, code };
  }

  /** @param {import('./types.js').Job} job */
  return async function runClaude(job) {
    if (job.kind === "pipeline") return runPipelineStep(job);

    const task = await adapter.fetchTask(job.ref);

    if (job.kind === "implement") {
      if (task.completed) {
        console.log(`[skip] ${job.ref} completed`);
        return { kind: job.kind, ref: job.ref, name: task.name, url: task.url, code: 0 };
      }
      if (!task.assignedToUs) {
        console.log(`[skip] ${job.ref} not assigned to us`);
        return { kind: job.kind, ref: job.ref, name: task.name, url: task.url, code: 0 };
      }
    }

    // Move the item into its "in progress" lane the moment work begins. Optional
    // per-adapter hook (Asana implements it; GitHub has no sections). After the
    // gates above, so skipped/unassigned/completed items are never moved.
    try {
      await adapter.onStart?.(job.ref);
    } catch (e) {
      console.error(`[section] onStart failed:`, e.message);
    }

    const base =
      job.kind === "implement" ? implementPrompt(task, meta) : changePrompt(task, job.text, meta);
    const standing = readInstructions(cfg.instructionsFile);
    const prompt = standing ? `${standing}\n\n=== TICKET ===\n\n${base}` : base;

    const logPath = logPathFor(job.kind, job.ref);
    console.log(`[run] ${job.kind} ${job.ref} "${task.name}" -> ${logPath}`);

    const code = await spawnClaude({ prompt, cwd: cfg.repoPath, logPath });

    if (job.kind === "implement") {
      try {
        await adapter.ensureCommentWebhook(job.ref);
      } catch (e) {
        console.error(`[hook] ensure failed:`, e.message);
      }
    }

    // Independent sign-off digest before the lane move, so the plain-language
    // card is already on the item when a human sees it land in review. A PR-
    // producing kind only (implement/change), clean author exit only, opt-in via
    // cfg.digest. Never let a digest failure block onFinish — it is advisory.
    if (code === 0 && cfg.digest && (job.kind === "implement" || job.kind === "change")) {
      try {
        await runDigest(job, task);
      } catch (e) {
        console.error(`[digest] failed (non-fatal):`, e.message);
      }
    }

    // Work done → hand off to its review lane. Optional per-adapter hook, mirror
    // of onStart. Only on a clean exit; a crashed agent stays put for inspection.
    if (code === 0) {
      try {
        await adapter.onFinish?.(job.ref);
      } catch (e) {
        console.error(`[section] onFinish failed:`, e.message);
      }
    }

    return { kind: job.kind, ref: job.ref, name: task.name, url: task.url, code };
  };
}
