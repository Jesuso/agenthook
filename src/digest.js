// Independent sign-off digest pass. Runs as a SEPARATE `claude -p` AFTER the
// author agent exits cleanly, with no memory of the implementation — so the
// adversarial review isn't correlated with the code's own blind spots.
//
// It produces a plain-language card for the tracker (easy human sign-off) and a
// technical concerns list for the PR, via the repo's `pr-digest` skill. It never
// edits code or moves the item — read-and-report only. A failed digest is logged
// and swallowed: it must never block the author's clean finish or the lane move.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { digestPrompt } from "./prompts.js";

/**
 * @param {import('./types.js').Config} cfg
 * @param {import('./types.js').Adapter} adapter
 * @param {Set<import('node:child_process').ChildProcess>} [children]  live procs, for force-kill on shutdown
 */
export function createDigest(cfg, adapter, children) {
  const meta = adapter.describe();

  /**
   * @param {import('./types.js').Job} job
   * @param {import('./types.js').Task} task  already fetched by the dispatcher
   * @returns {Promise<number>} exit code (non-zero is non-fatal to the caller)
   */
  return async function runDigest(job, task) {
    const prompt = digestPrompt(task, meta, cfg);

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const safeRef = String(job.ref).replace(/[^A-Za-z0-9_.-]/g, "_");
    const logPath = path.join(cfg.logDir, `${stamp}-digest-${safeRef}.log`);
    const logStream = fs.createWriteStream(logPath, { flags: "a" });
    console.log(`[digest] ${job.ref} "${task.name}" -> ${logPath}`);

    const args = ["-p", prompt];
    if (cfg.fullAuto) args.push("--dangerously-skip-permissions");

    const code = await new Promise((resolve) => {
      const child = spawn(cfg.claudeBin, args, {
        cwd: cfg.repoPath, // skill resolves the worktree itself from the task gid
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env },
      });
      children?.add(child);
      child.stdout.pipe(logStream);
      child.stderr.pipe(logStream);
      child.on("close", (c) => {
        children?.delete(child);
        logStream.end();
        resolve(c ?? 1);
      });
    });

    if (code !== 0) console.error(`[digest] ${job.ref} exited ${code} (non-fatal) — see ${logPath}`);
    return code;
  };
}
