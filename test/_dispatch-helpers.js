// Shared fixtures for the dispatch-*.test.js files (split from the former dispatch.test.js
// so no single test file costs ~40K tokens to read — see #717). Not matched by the
// `test/*.test.js` glob `npm test` runs, so it is never itself executed as a test file.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDispatcher } from "../src/dispatch.js";
import { createStore } from "../src/store.js";

export const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "agenthook-dispatch-"));

// --- held-state lifecycle (the `@agent` resume) through the real dispatcher ---
// A fake `claude` (a tiny sh script, no network) writes $FAKE_VERDICT to the verdict
// file and records the prompt it was handed, so runClaude runs end to end.

/** @param {{steps?: any[], meta?: any, cfg?: any, forge?: any}} [o] */
export function heldHarness({ steps, meta, cfg: cfgOver, forge } = {}) {
  const dir = tmpDir();
  const bin = path.join(dir, "fake-claude.sh");
  fs.writeFileSync(bin, `#!/bin/sh\nprintf '%s' "$2" > "$FAKE_PROMPT_OUT"\nprintf '%s' "$FAKE_VERDICT" > "$AGENTHOOK_VERDICT_FILE"\n`, { mode: 0o755 });
  const cfg = /** @type {any} */ ({
    pipeline: steps || [{ id: "triage", kind: "triage" }, { id: "code" }, { id: "done", manual: true, drainWorktree: true }],
    agentEnvPassthrough: ["FAKE_*"], // the fake reads its knobs from the receiver's env (#470)
    claudeBin: bin,
    repoPath: dir,
    worktreePrefix: path.join(dir, "wt"),
    dataDir: dir,
    logDir: dir,
    instructionsFile: path.join(dir, "none.md"),
    ...cfgOver,
  });
  const store = createStore(dir);
  /** @type {any[]} */
  const advanced = [];
  /** @type {any[]} */
  const events = [];
  const adapter = /** @type {any} */ ({
    describe: () => ({ platform: "GitHub", taskNoun: "issue", trigger: "@agent", commentHowTo: "comment", ...meta }),
    fetchTask: async (/** @type {string} */ ref) => ({ ref, name: "t", description: "d", url: "u", completed: false, assignedToUs: true }),
    advance: async (/** @type {string} */ ref, /** @type {string} */ stepId, /** @type {any} */ verdict) => advanced.push([ref, stepId, verdict.outcome]),
  });
  const emit = (/** @type {string} */ event, /** @type {string} */ _ref, /** @type {string} */ _step, /** @type {any} */ extra) => events.push({ event, ...extra });
  const run = createDispatcher(cfg, adapter, undefined, store, emit, forge);
  const promptOut = path.join(dir, "prompt.txt");
  /** @param {string} stepId @param {any} verdict @param {string} [comment] @param {{prompt?: boolean}} [o] */
  const runStep = async (stepId, verdict, comment, { prompt = true } = {}) => {
    process.env.FAKE_VERDICT = typeof verdict === "string" ? verdict : JSON.stringify(verdict);
    process.env.FAKE_PROMPT_OUT = promptOut;
    const log = console.log;
    console.log = () => {};
    try {
      await run({ kind: "pipeline", ref: "42", stepId, dedupKey: `k:${stepId}`, ...(comment ? { comment } : {}) });
    } finally {
      console.log = log;
    }
    return prompt ? fs.readFileSync(promptOut, "utf8") : "";
  };
  return { store, advanced, events, runStep, run, dir };
}

// --- verdict-repair (#677): a fake `claude` that counts its own invocations, writes a
// stream-json `result` with a session id every call, and writes $FAKE_VERDICT to the verdict
// file only once its invocation count reaches $FAKE_GOOD_AT_TURN (unset = never). Detects
// whether it was resumed (argv carries `-r <sessionId>`) and records that too.

/** @param {{steps?: any[], cfg?: any}} [o] */
export function repairHarness({ steps, cfg: cfgOver } = {}) {
  const dir = tmpDir();
  const bin = path.join(dir, "fake-claude.sh");
  const counterFile = path.join(dir, "counter");
  const resumedFile = path.join(dir, "resumed");
  fs.writeFileSync(
    bin,
    [
      `#!/bin/sh`,
      `n=0`,
      `[ -f "$FAKE_COUNTER" ] && n=$(cat "$FAKE_COUNTER")`,
      `n=$((n + 1))`,
      `echo "$n" > "$FAKE_COUNTER"`,
      `resumed=0`,
      `prev=""`,
      `for a in "$@"; do [ "$prev" = "-r" ] && resumed=1; prev="$a"; done`,
      `echo "$n:$resumed" >> "$FAKE_RESUMED"`,
      `printf '{"type":"result","subtype":"success","session_id":"ses_123","usage":{"input_tokens":%d,"output_tokens":%d},"total_cost_usd":0.01}\\n' "$n" "$n"`,
      `if [ -n "$FAKE_GOOD_AT_TURN" ] && [ "$n" -ge "$FAKE_GOOD_AT_TURN" ]; then printf '%s' "$FAKE_VERDICT" > "$AGENTHOOK_VERDICT_FILE"; fi`,
      `exit "\${FAKE_EXIT:-0}"`,
      ``,
    ].join("\n"),
    { mode: 0o755 },
  );
  const cfg = /** @type {any} */ ({
    pipeline: steps || [{ id: "code" }, { id: "done", manual: true }],
    agentEnvPassthrough: ["FAKE_*"],
    claudeBin: bin,
    repoPath: dir,
    worktreePrefix: path.join(dir, "wt"),
    dataDir: dir,
    logDir: dir,
    instructionsFile: path.join(dir, "none.md"),
    ...cfgOver,
  });
  const store = createStore(dir);
  /** @type {any[]} */
  const advanced = [];
  /** @type {any[]} */
  const events = [];
  const adapter = /** @type {any} */ ({
    describe: () => ({ platform: "GitHub", taskNoun: "issue", trigger: "@agent", commentHowTo: "comment" }),
    fetchTask: async (/** @type {string} */ ref) => ({ ref, name: "t", description: "d", url: "u", completed: false, assignedToUs: true }),
    advance: async (/** @type {string} */ ref, /** @type {string} */ stepId, /** @type {any} */ verdict) => advanced.push([ref, stepId, verdict.outcome]),
  });
  const emit = (/** @type {string} */ event, /** @type {string} */ _ref, /** @type {string} */ _step, /** @type {any} */ extra) => events.push({ event, ...extra });
  const run = createDispatcher(cfg, adapter, undefined, store, emit);
  /** @param {string} stepId @param {{verdict?: any, goodAtTurn?: number, exit?: number}} [o] */
  const runStep = async (stepId, { verdict, goodAtTurn, exit } = {}) => {
    process.env.FAKE_COUNTER = counterFile;
    process.env.FAKE_RESUMED = resumedFile;
    process.env.FAKE_VERDICT = verdict ? JSON.stringify(verdict) : "";
    if (goodAtTurn) process.env.FAKE_GOOD_AT_TURN = String(goodAtTurn);
    else delete process.env.FAKE_GOOD_AT_TURN;
    if (exit) process.env.FAKE_EXIT = String(exit);
    else delete process.env.FAKE_EXIT;
    const log = console.log;
    console.log = () => {};
    try {
      await run({ kind: "pipeline", ref: "42", stepId, dedupKey: `k:${stepId}` });
    } finally {
      console.log = log;
    }
  };
  /** How many times the fake was spawned. */
  const calls = () => (fs.existsSync(counterFile) ? Number(fs.readFileSync(counterFile, "utf8").trim()) : 0);
  /** Each call's "<n>:<resumed 0|1>" line, in order. */
  const resumedLog = () => (fs.existsSync(resumedFile) ? fs.readFileSync(resumedFile, "utf8").trim().split("\n") : []);
  return { store, advanced, events, runStep, calls, resumedLog, dir };
}

// --- step timeouts (maxMinutes / idleMinutes) through the real dispatcher ---
// Fractional minutes keep the windows tiny (0.001 min = 60 ms); killGraceMs is injected.

/** @param {string} script  fake `claude` body (sh) @param {any} step @param {number} [killGraceMs] */
export async function timeoutRun(script, step, killGraceMs = 2000, cfgOver = {}) {
  const dir = tmpDir();
  const bin = path.join(dir, "fake-claude.sh");
  fs.writeFileSync(bin, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  const cfg = /** @type {any} */ ({
    pipeline: [{ id: "code", ...step }, { id: "done", manual: true }],
    claudeBin: bin,
    repoPath: dir,
    dataDir: dir,
    logDir: dir,
    instructionsFile: path.join(dir, "none.md"),
    ...cfgOver,
  });
  /** @type {any[]} */
  const advanced = [];
  /** @type {any[]} */
  const events = [];
  const adapter = /** @type {any} */ ({
    describe: () => ({ platform: "GitHub", taskNoun: "issue", trigger: "@agent", commentHowTo: "comment" }),
    fetchTask: async (/** @type {string} */ ref) => ({ ref, name: "t", description: "d", url: "u", completed: false, assignedToUs: true }),
    advance: async (/** @type {string} */ _ref, /** @type {string} */ _stepId, /** @type {any} */ verdict) => advanced.push(verdict),
  });
  const emit = (/** @type {string} */ event, /** @type {string} */ _ref, /** @type {string} */ _step, /** @type {any} */ extra) => events.push({ event, ...extra });
  const children = new Set();
  const run = createDispatcher(cfg, adapter, children, createStore(dir), emit, null, undefined, { killGraceMs });
  const log = console.log;
  console.log = () => {};
  const t0 = Date.now();
  try {
    await run({ kind: "pipeline", ref: "42", stepId: "code", dedupKey: "k" });
  } finally {
    console.log = log;
  }
  const logText = fs.readdirSync(dir).filter((f) => f.endsWith(".log")).map((f) => fs.readFileSync(path.join(dir, f), "utf8")).join("");
  return { advanced, events, children, elapsed: Date.now() - t0, logText, verdictLeft: fs.existsSync(path.join(dir, "verdicts", "42-code.json")), usage: createStore(dir).readUsage() };
}
