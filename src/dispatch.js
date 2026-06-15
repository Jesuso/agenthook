// Spawns headless `claude -p` for one job, streams output to a per-run log,
// then asks the provider to ensure a comment-watch hook exists (so future
// "@agent ..." comments re-trigger). Provider-blind: everything platform-
// specific comes through the adapter.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { implementPrompt, changePrompt } from "./prompts.js";

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
 */
export function createDispatcher(cfg, adapter, children) {
  const meta = adapter.describe();

  /** @param {import('./types.js').Job} job */
  return async function runClaude(job) {
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

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const safeRef = String(job.ref).replace(/[^A-Za-z0-9_.-]/g, "_");
    const logPath = path.join(cfg.logDir, `${stamp}-${job.kind}-${safeRef}.log`);
    const logStream = fs.createWriteStream(logPath, { flags: "a" });
    console.log(`[run] ${job.kind} ${job.ref} "${task.name}" -> ${logPath}`);

    const args = ["-p", prompt];
    if (cfg.fullAuto) args.push("--dangerously-skip-permissions");

    const code = await new Promise((resolve) => {
      const child = spawn(cfg.claudeBin, args, {
        cwd: cfg.repoPath,
        stdio: ["ignore", "pipe", "pipe"], // close stdin -> no "no stdin data" stall
        env: { ...process.env },
      });
      children?.add(child);
      child.stdout.pipe(logStream);
      child.stderr.pipe(logStream);
      child.on("close", (c) => {
        children?.delete(child);
        logStream.end();
        resolve(c);
      });
    });

    if (job.kind === "implement") {
      try {
        await adapter.ensureCommentWebhook(job.ref);
      } catch (e) {
        console.error(`[hook] ensure failed:`, e.message);
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
