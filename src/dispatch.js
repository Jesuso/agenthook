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

/** Reasoning-effort levels `claude -p --effort` accepts. An out-of-set value is
 * dropped (warn + omit the flag) so a typo falls back to the CLI default, never crashes. */
const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];

/**
 * Build the `claude -p` argv (pure, exported so the flag wiring is unit-testable
 * without a real spawn). Order is stable: prompt, then --model, --effort, then
 * --dangerously-skip-permissions.
 * @param {{prompt: string, model?: string, effort?: string, fullAuto?: boolean}} o
 * @returns {string[]}
 */
export function buildClaudeArgs({ prompt, model, effort, fullAuto }) {
  // --output-format stream-json + --verbose: stdout becomes JSONL we parse for the
  // per-run log (assistant text) and the token/cost tally (the final `result` event).
  const args = ["-p", prompt, "--output-format", "stream-json", "--verbose"];
  if (model) args.push("--model", model);
  if (effort) {
    if (EFFORT_LEVELS.includes(effort)) args.push("--effort", effort);
    else console.warn(`[dispatch] ignoring invalid effort "${effort}" (expected ${EFFORT_LEVELS.join("|")})`);
  }
  if (fullAuto) args.push("--dangerously-skip-permissions");
  return args;
}

/**
 * Incremental parser for `claude -p --output-format stream-json --verbose` stdout:
 * one JSON object per line. Buffers partial lines across chunk boundaries, renders
 * assistant **text** content blocks to human-readable log text (non-text blocks and
 * non-JSON lines ignored — never throws), keeps a running token tally, and captures
 * the final `{type:"result"}` event. Pure (no I/O), stateful — feed chunks via push(),
 * flush() any tail at EOF, then read `.tally` / `.result`. Exported for unit tests.
 * @returns {{push:(chunk:string)=>string, flush:()=>string, tally:{input:number,output:number}, result:any}}
 */
export function createStreamParser() {
  let buf = "";
  const tally = { input: 0, output: 0 };
  /** @type {any} */
  let result = null;

  /** @param {any} ev @returns {string} human-readable log text for this event */
  function handleEvent(ev) {
    if (!ev || typeof ev !== "object") return "";
    if (ev.type === "assistant" && ev.message && typeof ev.message === "object") {
      const u = ev.message.usage;
      if (u && typeof u === "object") {
        // Live estimate only (final record comes from the `result` event): sum output
        // across turns so the tally grows; track input as the latest turn's context size.
        if (typeof u.output_tokens === "number") tally.output += u.output_tokens;
        if (typeof u.input_tokens === "number") tally.input = u.input_tokens;
      }
      const content = ev.message.content;
      let text = "";
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b && b.type === "text" && typeof b.text === "string") text += b.text;
        }
      }
      return text ? text + "\n" : "";
    }
    if (ev.type === "result") {
      result = ev;
      const u = ev.usage;
      if (u && typeof u === "object") {
        if (typeof u.input_tokens === "number") tally.input = u.input_tokens;
        if (typeof u.output_tokens === "number") tally.output = u.output_tokens;
      }
      return "";
    }
    return "";
  }

  /** @param {string} line */
  function handleLine(line) {
    const t = line.trim();
    if (!t) return "";
    let ev;
    try {
      ev = JSON.parse(t);
    } catch {
      return ""; // non-JSON line (stray output) — skip, don't crash
    }
    return handleEvent(ev);
  }

  return {
    /** @param {string} chunk @returns {string} log text rendered from completed lines */
    push(chunk) {
      buf += chunk;
      let out = "";
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        out += handleLine(line);
      }
      return out;
    },
    /** Process any buffered tail (a final line with no trailing newline). */
    flush() {
      if (!buf) return "";
      const line = buf;
      buf = "";
      return handleLine(line);
    },
    get tally() {
      return tally;
    },
    get result() {
      return result;
    },
  };
}

/** First model key in a stream-json `modelUsage` map, or undefined. @param {any} mu */
function firstModel(mu) {
  if (!mu || typeof mu !== "object") return undefined;
  const keys = Object.keys(mu);
  return keys.length ? keys[0] : undefined;
}

/**
 * Build a UsageRecord from a captured stream-json `result` event. Pure; exported for
 * tests. Totals come straight from `result.usage` + `total_cost_usd`; the model falls
 * back to the first `modelUsage` key when the step set no explicit `--model`.
 * @param {{ref:string, stepId:string, model?:string, startedAt:string, endedAt:string, result:any}} o
 * @returns {import('./types.js').UsageRecord}
 */
export function buildUsageRecord({ ref, stepId, model, startedAt, endedAt, result }) {
  const u = (result && result.usage) || {};
  return {
    ref,
    stepId,
    model: model || firstModel(result && result.modelUsage),
    startedAt,
    endedAt,
    durationMs: typeof result?.duration_ms === "number" ? result.duration_ms : undefined,
    input: u.input_tokens || 0,
    output: u.output_tokens || 0,
    cacheRead: u.cache_read_input_tokens || 0,
    cacheCreate: u.cache_creation_input_tokens || 0,
    costUsd: typeof result?.total_cost_usd === "number" ? result.total_cost_usd : undefined,
    sessionId: typeof result?.session_id === "string" ? result.session_id : undefined,
  };
}

const DIFFICULTIES = /** @type {const} */ (["easy", "medium", "hard"]);

/**
 * Resolve the effective model and effort for a step, applying any difficulty escalation.
 * Pure — no I/O. Exported for unit tests.
 * @param {import('./types.js').Step} step
 * @param {string|undefined} difficulty  the stored difficulty for this ref (may be absent)
 * @returns {{model?: string, effort?: string}}
 */
export function resolveModelEffort(step, difficulty) {
  const base = { model: step.model, effort: step.effort };
  if (!difficulty || !step.escalate?.[difficulty]) return base;
  const esc = step.escalate[difficulty];
  return {
    model: esc.model ?? base.model,
    effort: esc.effort ?? base.effort,
  };
}

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
   * Spawn `claude -p` with a prompt. stdout is stream-json: a line parser renders the
   * assistant text to the log and accumulates the token tally + final `result` event;
   * stderr is piped raw. `onTally` fires when the running token count changes (i.e. per
   * assistant/result event, NOT per token) so the live record isn't rewritten per token.
   * @param {{prompt: string, cwd: string, logPath: string, model?: string, effort?: string, verdictFile?: string, onPid?: (pid: number|undefined) => void, onTally?: (tally: {input:number,output:number}) => void}} o
   * @returns {Promise<{code: number, result: any}>}
   */
  function spawnClaude({ prompt, cwd, logPath, model, effort, verdictFile, onPid, onTally }) {
    const logStream = fs.createWriteStream(logPath, { flags: "a" });
    const args = buildClaudeArgs({ prompt, model, effort, fullAuto: cfg.fullAuto });
    const parser = createStreamParser();
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
      let lastOut = -1;
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        const text = parser.push(chunk);
        if (text) logStream.write(text);
        if (onTally && parser.tally.output !== lastOut) {
          lastOut = parser.tally.output;
          onTally(parser.tally);
        }
      });
      child.stderr.pipe(logStream);
      child.on("close", (c) => {
        const tail = parser.flush();
        if (tail) logStream.write(tail);
        children?.delete(child);
        logStream.end();
        resolve({ code: c ?? 1, result: parser.result });
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
      difficulty: DIFFICULTIES.includes(raw?.difficulty) ? raw.difficulty : undefined,
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
        store?.clearAttempts(job.ref);
        store?.clearDifficulty(job.ref); // task is done — reset its per-ref state
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

    // Apply difficulty escalation: if a prior step (e.g. triage) stored a difficulty
    // tag and this step has a matching `escalate` key, override the base model/effort.
    const storedDifficulty = store?.getDifficulty(job.ref);
    const { model, effort } = resolveModelEffort(step, storedDifficulty);
    if (storedDifficulty && step.escalate?.[storedDifficulty]) {
      console.log(`[dispatch] escalating step ${step.id} ref ${job.ref} (difficulty=${storedDifficulty}): model=${model ?? "default"} effort=${effort ?? "default"}`);
    } else {
      console.log(`[dispatch] step ${step.id} ref ${job.ref}: model=${model ?? "default"} effort=${effort ?? "default"}`);
    }

    const startedAt = new Date().toISOString();
    const baseRunning = { stepId: step.id, startedAt, worktree: cwd };
    /** @type {number|undefined} */
    let pid;
    const { code, result } = await spawnClaude({
      prompt,
      cwd,
      logPath,
      model,
      effort,
      verdictFile,
      onPid: (p) => {
        pid = p;
        store?.setRunning(job.ref, { ...baseRunning, pid });
      },
      // Live token tally onto the running record (throttled — per assistant/result event).
      onTally: (t) => store?.setRunning(job.ref, { ...baseRunning, pid, input: t.input, output: t.output }),
    });
    store?.clearRunning(job.ref);

    // Persist the final per-run usage record from the captured `result` event (token
    // totals + cost). Append-only usage.jsonl, distinct from the rewritten state files.
    if (store && result) {
      store.recordUsage(
        buildUsageRecord({ ref: job.ref, stepId: step.id, model, startedAt, endedAt: new Date().toISOString(), result }),
      );
    }

    // Resolve the verdict from the exit code + the file the agent wrote.
    const verdict = readVerdict(code, verdictFile);
    try {
      fs.rmSync(verdictFile, { force: true });
    } catch {
      /* best effort */
    }

    // Persist a difficulty tag emitted by this step (typically triage) so later steps
    // (e.g. code) can gate their model/effort on it.
    if (verdict.difficulty && store) {
      store.setDifficulty(job.ref, verdict.difficulty);
      console.log(`[dispatch] stored difficulty=${verdict.difficulty} for ref ${job.ref}`);
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

    // Reset loop counters and difficulty when the task leaves the pipeline: a terminal
    // `fail` or a drained worktree (done). mid-pipeline hold/advance keeps them so a
    // later `changes` still counts against the cap and difficulty stays available.
    if (verdict.outcome === "fail" || drained) {
      store?.clearAttempts(job.ref);
      store?.clearDifficulty(job.ref);
    }

    return { kind: job.kind, ref: job.ref, name: task.name, url: task.url, code };
  };
}
