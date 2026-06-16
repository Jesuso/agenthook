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
import { findStep, prevStep } from "./pipeline.js";
import { ensureWorktree, drainWorktree, worktreePath } from "./worktree.js";

// How many times one step may run for a single ref before a `changes` loop back
// into it is forced to fail. Caps an endless code↔review ping-pong (each loop is a
// fresh `claude -p` under fullAuto = real money + code exec). Per-step `maxAttempts`
// overrides. See store.bumpAttempt/getAttempt.
const DEFAULT_MAX_ATTEMPTS = 3;

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
   * @param {{prompt: string, cwd: string, logPath: string, model?: string, verdictFile?: string, onPid?: (pid: number|undefined) => void}} o
   * @returns {Promise<number>}
   */
  function spawnClaude({ prompt, cwd, logPath, model, verdictFile, onPid }) {
    const logStream = fs.createWriteStream(logPath, { flags: "a" });
    const args = ["-p", prompt];
    if (model) args.push("--model", model);
    if (cfg.fullAuto) args.push("--dangerously-skip-permissions");
    return new Promise((resolve) => {
      const child = spawn(cfg.claudeBin, args, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"], // close stdin -> no "no stdin data" stall
        // AGENTHOOK_VERDICT_FILE: where the agent writes its structured verdict; we
        // read it after exit to route the step (advance/hold/changes/fail).
        env: { ...process.env, ...(verdictFile ? { AGENTHOOK_VERDICT_FILE: verdictFile } : {}) },
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

  /** The path the agent writes its verdict to (one per run, under the state dir so a
   * worktree drain can't take it). @param {string} stepId @param {string} ref */
  function verdictPathFor(stepId, ref) {
    const dir = path.join(cfg.dataDir, "verdicts");
    fs.mkdirSync(dir, { recursive: true });
    const safeRef = String(ref).replace(/[^A-Za-z0-9_.-]/g, "_");
    return path.join(dir, `${safeRef}-${stepId}.json`);
  }

  /**
   * Resolve the run's verdict from (exit code, verdict file). A non-zero exit is a
   * crashed/errored agent → fail, and its file is NOT trusted. A clean exit honors a
   * valid verdict file; a missing/garbage one defaults to `advance` (the "clean exit
   * advances" spine from P1). @param {number} code @param {string} verdictFile
   * @returns {import('./types.js').Verdict}
   */
  function readVerdict(code, verdictFile) {
    if (code !== 0) return { outcome: "fail", reason: `non-zero exit (${code})` };
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(verdictFile, "utf8"));
    } catch {
      return { outcome: "advance", reason: "no verdict file — defaulting to advance" };
    }
    const allowed = ["advance", "fail", "hold", "changes"];
    if (!allowed.includes(raw?.outcome)) {
      return { outcome: "advance", reason: `unrecognized verdict ${JSON.stringify(raw?.outcome)} — defaulting to advance` };
    }
    return {
      outcome: raw.outcome,
      target: typeof raw.target === "string" ? raw.target : undefined,
      reason: typeof raw.reason === "string" ? raw.reason : undefined,
    };
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
        store?.clearAttempts(job.ref); // task is done — reset its loop counters
      }
      return { kind: job.kind, ref: job.ref, name: task.name, url: task.url, code: 0 };
    }

    // Count this run before it starts — the changes-loop guard reads it post-exit.
    store?.bumpAttempt(job.ref, step.id);

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

    // One verdict file per run, under the state dir. Clear any stale one first so a
    // crashed prior run can't leave a verdict the agent didn't write this time.
    const verdictFile = verdictPathFor(step.id, job.ref);
    try {
      fs.rmSync(verdictFile, { force: true });
    } catch {
      /* nothing to clear */
    }

    const standing = readInstructions(step.instructionsFile || cfg.instructionsFile);
    const base = stepPrompt(task, meta, step, { worktree: hasWorktree ? worktree : undefined, branch, verdictFile });
    const prompt = standing ? `${standing}\n\n=== TICKET ===\n\n${base}` : base;

    const logPath = logPathFor(step.id, job.ref);
    console.log(`[run] step ${step.id} ${job.ref} "${task.name}" -> ${logPath}`);

    const code = await spawnClaude({
      prompt,
      cwd,
      logPath,
      model: step.model,
      verdictFile,
      onPid: (pid) =>
        store?.setRunning(job.ref, { stepId: step.id, pid, startedAt: new Date().toISOString(), worktree: cwd }),
    });
    store?.clearRunning(job.ref);

    // Resolve the verdict from the exit code + the file the agent wrote.
    const verdict = readVerdict(code, verdictFile);
    try {
      fs.rmSync(verdictFile, { force: true });
    } catch {
      /* best effort */
    }

    // Changes-loop guard: route `changes` back to its target step (verdict.target, else
    // the previous step), but only while that step is under its attempt cap. At the cap,
    // stop the ping-pong — force fail. Resolve target to a concrete id for the adapter.
    if (verdict.outcome === "changes") {
      const target = verdict.target ? findStep(cfg, verdict.target) : prevStep(cfg, step.id);
      if (!target) {
        verdict.outcome = "fail";
        verdict.reason = `changes had no resolvable target from "${step.id}"`;
      } else {
        const ran = store?.getAttempt(job.ref, target.id) ?? 0;
        const cap = target.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
        if (ran >= cap) {
          verdict.outcome = "fail";
          verdict.reason = `changes loop hit cap (${cap}) on step "${target.id}"`;
        } else {
          verdict.target = target.id;
        }
      }
    }

    // Drain before advancing, so the worktree is gone by the time the next stage looks.
    // A `changes` keeps the worktree (the re-fired step reworks the same branch/PR).
    const drained = step.drainWorktree && verdict.outcome !== "changes";
    if (drained) {
      try {
        if (drainWorktree(cfg, job.ref)) console.log(`[worktree] drained ${job.ref} (${step.id})`);
      } catch (e) {
        console.error(`[worktree] drain failed for ${job.ref}:`, e.message);
      }
    }

    // The move to the next section is itself the event that fires the next step.
    console.log(`[verdict] ${step.id} ${job.ref} -> ${verdict.outcome}${verdict.reason ? ` (${verdict.reason})` : ""}`);
    try {
      await adapter.advance(job.ref, step.id, verdict);
    } catch (e) {
      console.error(`[advance] ${step.id} ${job.ref} (${verdict.outcome}) failed:`, e.message);
    }

    // Reset loop counters when the task leaves the loop: a terminal `fail` (off to the
    // failure lane) or a drained worktree (done). A `hold`/`advance` mid-pipeline keeps
    // them, so a later `changes` still counts against the cap.
    if (verdict.outcome === "fail" || drained) store?.clearAttempts(job.ref);

    return { kind: job.kind, ref: job.ref, name: task.name, url: task.url, code };
  };
}
