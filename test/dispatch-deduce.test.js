import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// Dispatch — deduced verdict (#680): a clean exit with no valid verdict, on a qualifying
// implement/change step whose worktree branch gained commits, advances without a repair spawn.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createDispatcher, NO_VALID_VERDICT, QUESTION_HOLD } from "../src/dispatch.js";
import { createStore } from "../src/store.js";
import { tmpDir } from "./_dispatch-helpers.js";

// --- deduced verdict (#680): a clean exit with no valid verdict, on a qualifying implement/change
// step whose worktree branch gained commits, advances without a repair spawn ---

const DEDUCE_PIPELINE = [
  { id: "code", createsWorktree: true, sourceLabel: "src:code", successLabel: "src:review" },
  { id: "review", sourceLabel: "src:review", successLabel: "src:done" },
  { id: "done", manual: true, sourceLabel: "src:done" },
];

/** A fake `claude` that, inside the real worktree it's spawned in, makes `$FAKE_COMMITS` empty
 * commits and/or dirties the tree, then optionally writes a verdict. Backed by a real git repo
 * (not just a tmp dir) so `branchHead`/`commitsSince` (src/worktree.js) see real history.
 * @param {{steps?: any[], cfg?: any}} [o] */
function deduceHarness({ steps, cfg: cfgOver } = {}) {
  const dir = tmpDir();
  const repoDir = path.join(dir, "repo");
  fs.mkdirSync(repoDir, { recursive: true });
  execFileSync("git", ["init", "-q", repoDir]);
  execFileSync("git", ["-C", repoDir, "config", "user.email", "a@a.com"]);
  execFileSync("git", ["-C", repoDir, "config", "user.name", "a"]);
  fs.writeFileSync(path.join(repoDir, "f"), "x\n");
  execFileSync("git", ["-C", repoDir, "add", "f"]);
  execFileSync("git", ["-C", repoDir, "commit", "-q", "-m", "init"]);
  const bin = path.join(dir, "fake-claude.sh");
  fs.writeFileSync(
    bin,
    [
      `#!/bin/sh`,
      `n=0`,
      `[ -f "$FAKE_COUNTER" ] && n=$(cat "$FAKE_COUNTER")`,
      `n=$((n + 1))`,
      `echo "$n" > "$FAKE_COUNTER"`,
      `i=0`,
      `while [ "$i" -lt "\${FAKE_COMMITS:-0}" ]; do`,
      `  git commit -q --allow-empty -m "c$i"`,
      `  i=$((i + 1))`,
      `done`,
      `if [ -n "$FAKE_DIRTY" ]; then echo dirty >> dirty.txt; fi`,
      `if [ -n "$FAKE_RESULT_TEXT" ]; then printf '{"type":"result","subtype":"success","session_id":"ses_123","usage":{"input_tokens":1,"output_tokens":1},"total_cost_usd":0.01,"result":%s}\\n' "$FAKE_RESULT_TEXT"; else printf '{"type":"result","subtype":"success","session_id":"ses_123","usage":{"input_tokens":1,"output_tokens":1},"total_cost_usd":0.01}\\n'; fi`,
      `if [ -n "$FAKE_VERDICT" ] && { [ -z "$FAKE_GOOD_AT_TURN" ] || [ "$n" -ge "$FAKE_GOOD_AT_TURN" ]; }; then printf '%s' "$FAKE_VERDICT" > "$AGENTHOOK_VERDICT_FILE"; fi`,
      `exit "\${FAKE_EXIT:-0}"`,
      ``,
    ].join("\n"),
    { mode: 0o755 },
  );
  const cfg = /** @type {any} */ ({
    pipeline: steps || DEDUCE_PIPELINE,
    agentEnvPassthrough: ["FAKE_*"],
    claudeBin: bin,
    repoPath: repoDir,
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
    describe: () => ({
      platform: "GitHub",
      taskNoun: "issue",
      trigger: "@agent",
      commentHowTo: "comment",
      stageKeys: { source: "sourceLabel", success: "successLabel", failure: "failLabel", hold: "holdLabel", queue: "queueLabel" },
    }),
    fetchTask: async (/** @type {string} */ ref) => ({ ref, name: "t", description: "d", url: "u", completed: false, assignedToUs: true }),
    advance: async (/** @type {string} */ ref, /** @type {string} */ stepId, /** @type {any} */ verdict) => advanced.push({ ref, stepId, ...verdict }),
  });
  const emit = (/** @type {string} */ event, /** @type {string} */ _ref, /** @type {string} */ _step, /** @type {any} */ extra) => events.push({ event, ...extra });
  const run = createDispatcher(cfg, adapter, undefined, store, emit);
  const counterFile = path.join(dir, "counter");
  /** @param {string} stepId @param {{commits?: number, dirty?: boolean, verdict?: any, exit?: number, resultText?: string, goodAtTurn?: number}} [o] */
  const runStep = async (stepId, { commits, dirty, verdict, exit, resultText, goodAtTurn } = {}) => {
    process.env.FAKE_COUNTER = counterFile;
    process.env.FAKE_COMMITS = String(commits ?? 0);
    if (dirty) process.env.FAKE_DIRTY = "1";
    else delete process.env.FAKE_DIRTY;
    process.env.FAKE_VERDICT = verdict ? JSON.stringify(verdict) : "";
    if (resultText) process.env.FAKE_RESULT_TEXT = JSON.stringify(resultText);
    else delete process.env.FAKE_RESULT_TEXT;
    if (exit) process.env.FAKE_EXIT = String(exit);
    else delete process.env.FAKE_EXIT;
    if (goodAtTurn) process.env.FAKE_GOOD_AT_TURN = String(goodAtTurn);
    else delete process.env.FAKE_GOOD_AT_TURN;
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
  return { store, advanced, events, runStep, calls, dir, repoDir };
}

test("dispatch: a clean exit with no verdict and new commits deduces advance — no repair spawn", async () => {
  // No verdictRepairs: 0 here on purpose: the default (1 repair turn) applies, and the fake
  // would really spawn again on a repair turn (it returns a session_id) — so calls() === 1
  // actually proves deduction pre-empted the repair, not just that repairs were disabled.
  const h = deduceHarness({ steps: [{ id: "code", createsWorktree: true, sourceLabel: "src:code", successLabel: "src:review" }, { id: "review", sourceLabel: "src:review" }] });
  await h.runStep("code", { commits: 2 });
  assert.deepEqual(h.advanced, [{ ref: "42", stepId: "code", outcome: "advance", reason: "no verdict written; advanced because the run added 2 commits" }]);
  assert.equal(h.store.getHeld("42"), undefined);
  assert.equal(h.calls(), 1, "the agent was spawned exactly once — deduction pre-empted the repair spawn");
  assert.equal(h.events.find((e) => e.event === "verdict_repair"), undefined, "the repair spawn never ran — deduction pre-empted it");
  const end = h.events.find((e) => e.event === "run_end");
  assert.equal(end?.verdictSource, "deduced");
  assert.equal(end?.plain, undefined, "no invented summary — the agent wrote none");
});

test("dispatch: deduceVerdict gate — no new commits (clean exit, verdict missing) falls through to the usual hold", async () => {
  const h = deduceHarness({ steps: [{ id: "code", createsWorktree: true, sourceLabel: "src:code", successLabel: "src:review", verdictRepairs: 0 }, { id: "review", sourceLabel: "src:review" }] });
  await h.runStep("code", { commits: 0 });
  assert.deepEqual(h.advanced, [{ ref: "42", stepId: "code", outcome: "hold", reason: NO_VALID_VERDICT }]);
  assert.equal(h.events.find((e) => e.event === "run_end")?.verdictSource, undefined);
});

test("dispatch: deduceVerdict gate — a dirty tree with no commit does not count", async () => {
  const h = deduceHarness({ steps: [{ id: "code", createsWorktree: true, sourceLabel: "src:code", successLabel: "src:review", verdictRepairs: 0 }, { id: "review", sourceLabel: "src:review" }] });
  await h.runStep("code", { commits: 0, dirty: true });
  assert.deepEqual(h.advanced, [{ ref: "42", stepId: "code", outcome: "hold", reason: NO_VALID_VERDICT }]);
  assert.equal(h.events.find((e) => e.event === "run_end")?.verdictSource, undefined);
});

test("dispatch: deduceVerdict gate — a review-kind step is never deduced, even with commits", async () => {
  const h = deduceHarness({
    steps: [{ id: "code", kind: "review", createsWorktree: true, sourceLabel: "src:code", successLabel: "src:review", verdictRepairs: 0 }, { id: "review", sourceLabel: "src:review" }],
  });
  await h.runStep("code", { commits: 2 });
  assert.deepEqual(h.advanced, [{ ref: "42", stepId: "code", outcome: "hold", reason: NO_VALID_VERDICT }]);
  assert.equal(h.events.find((e) => e.event === "run_end")?.verdictSource, undefined);
});

test("dispatch: deduceVerdict gate — a triage-kind step is never deduced, even with commits", async () => {
  const h = deduceHarness({
    steps: [{ id: "code", kind: "triage", createsWorktree: true, sourceLabel: "src:code", successLabel: "src:review", verdictRepairs: 0 }, { id: "review", sourceLabel: "src:review" }],
  });
  await h.runStep("code", { commits: 2 });
  assert.deepEqual(h.advanced, [{ ref: "42", stepId: "code", outcome: "hold", reason: NO_VALID_VERDICT }]);
  assert.equal(h.events.find((e) => e.event === "run_end")?.verdictSource, undefined);
});

test("dispatch: deduceVerdict gate — a success target that's a manual step is never deduced", async () => {
  const h = deduceHarness({
    steps: [{ id: "code", createsWorktree: true, sourceLabel: "src:code", successLabel: "src:done", verdictRepairs: 0 }, { id: "done", manual: true, sourceLabel: "src:done" }],
  });
  await h.runStep("code", { commits: 2 });
  assert.deepEqual(h.advanced, [{ ref: "42", stepId: "code", outcome: "hold", reason: NO_VALID_VERDICT }]);
  assert.equal(h.events.find((e) => e.event === "run_end")?.verdictSource, undefined);
});

test("dispatch: deduceVerdict gate — a non-zero exit is never deduced (fails closed on commits alone)", async () => {
  const h = deduceHarness({ steps: [{ id: "code", createsWorktree: true, sourceLabel: "src:code", successLabel: "src:review", verdictRepairs: 0 }, { id: "review", sourceLabel: "src:review" }] });
  await h.runStep("code", { commits: 2, exit: 1 });
  assert.equal(h.advanced[0]?.outcome, "fail");
  assert.equal(h.advanced[0]?.reason, "non-zero exit (1)");
  assert.equal(h.events.find((e) => e.event === "run_end")?.verdictSource, undefined);
});

test("dispatch: deduceVerdict gate — a run that ended with a question (#655) is never deduced, even with commits", async () => {
  const h = deduceHarness({ steps: [{ id: "code", createsWorktree: true, sourceLabel: "src:code", successLabel: "src:review", verdictRepairs: 0 }, { id: "review", sourceLabel: "src:review" }] });
  await h.runStep("code", { commits: 2, resultText: "Want me to open the PR?" });
  assert.equal(h.advanced[0]?.outcome, "hold");
  assert.equal(h.advanced[0]?.reason, `${QUESTION_HOLD}: "Want me to open the PR?"`);
  assert.equal(h.events.find((e) => e.event === "run_end")?.verdictSource, undefined);
});

test("dispatch: deduceVerdict: false opts a step out, falling through to repair then hold as before #680", async () => {
  const h = deduceHarness({ steps: [{ id: "code", createsWorktree: true, sourceLabel: "src:code", successLabel: "src:review", deduceVerdict: false, verdictRepairs: 0 }, { id: "review", sourceLabel: "src:review" }] });
  await h.runStep("code", { commits: 2 });
  assert.deepEqual(h.advanced, [{ ref: "42", stepId: "code", outcome: "hold", reason: NO_VALID_VERDICT }]);
  assert.equal(h.events.find((e) => e.event === "run_end")?.verdictSource, undefined);
});

test("dispatch: a valid agent verdict always wins over deduction, commits or not — hold/fail included", async () => {
  const h = deduceHarness({ steps: [{ id: "code", createsWorktree: true, sourceLabel: "src:code", successLabel: "src:review", verdictRepairs: 0 }, { id: "review", sourceLabel: "src:review" }] });
  await h.runStep("code", { commits: 3, verdict: { outcome: "hold", reason: "needs a call" } });
  assert.equal(h.advanced[0]?.outcome, "hold");
  assert.equal(h.advanced[0]?.reason, "needs a call");
  assert.equal(h.events.find((e) => e.event === "run_end")?.verdictSource, "agent");
});

test("dispatch: a repaired run carries verdictSource 'repaired' (deduction never got a chance — the first spawn had no commits)", async () => {
  const h = deduceHarness({
    steps: [{ id: "code", createsWorktree: true, sourceLabel: "src:code", successLabel: "src:review" }, { id: "review", sourceLabel: "src:review" }],
  });
  // No commits on the first spawn -> deduceVerdict can't fire -> the default verdictRepairs: 1
  // repair turn runs instead, and writes a verdict on its turn (goodAtTurn: 2).
  await h.runStep("code", { commits: 0, verdict: { outcome: "advance" }, goodAtTurn: 2 });
  assert.equal(h.calls(), 2, "the original run + exactly one repair turn");
  const end = h.events.find((e) => e.event === "run_end");
  assert.equal(h.advanced[0]?.outcome, "advance");
  assert.equal(end?.verdictSource, "repaired");
  assert.equal(end?.repaired, true);
});

test("dispatch: an unrepaired hold (no deduction, no repair) carries no verdictSource", async () => {
  const h = deduceHarness({ steps: [{ id: "code", createsWorktree: true, sourceLabel: "src:code", successLabel: "src:review", verdictRepairs: 0 }, { id: "review", sourceLabel: "src:review" }] });
  await h.runStep("code", { commits: 0 });
  const end = h.events.find((e) => e.event === "run_end");
  assert.equal(h.advanced[0]?.outcome, "hold");
  assert.equal(end?.verdictSource, undefined);
  assert.equal(end?.repaired, undefined);
});

test("dispatch: deduceVerdict gate — an idle-timed-out run is never deduced, even with commits", async () => {
  // Commits first (so commitsSince alone would allow deduction), then goes idle until
  // idleMinutes kills it; `trap` makes the kill resolve as a clean exit(0), so only the
  // `timedOut` gate (step.js) stands between this and a spurious deduced advance.
  const dir = tmpDir();
  const repoDir = path.join(dir, "repo");
  fs.mkdirSync(repoDir, { recursive: true });
  execFileSync("git", ["init", "-q", repoDir]);
  execFileSync("git", ["-C", repoDir, "config", "user.email", "a@a.com"]);
  execFileSync("git", ["-C", repoDir, "config", "user.name", "a"]);
  fs.writeFileSync(path.join(repoDir, "f"), "x\n");
  execFileSync("git", ["-C", repoDir, "add", "f"]);
  execFileSync("git", ["-C", repoDir, "commit", "-q", "-m", "init"]);
  const bin = path.join(dir, "fake-claude.sh");
  fs.writeFileSync(
    bin,
    [
      `#!/bin/sh`,
      `n=0`,
      `[ -f "$FAKE_COUNTER" ] && n=$(cat "$FAKE_COUNTER")`,
      `n=$((n + 1))`,
      `echo "$n" > "$FAKE_COUNTER"`,
      `git commit -q --allow-empty -m c0`,
      `trap 'exit 0' TERM`,
      `printf '{"type":"result","subtype":"success","session_id":"ses_123","usage":{"input_tokens":1,"output_tokens":1},"total_cost_usd":0.01}\\n'`,
      // dash only checks for a pending trap between commands, not while blocked inside one — a
      // single long `sleep` would eat the SIGTERM and get SIGKILLed instead of hitting `exit 0`.
      `i=0; while [ $i -lt 200 ]; do sleep 0.05; i=$((i + 1)); done`,
      ``,
    ].join("\n"),
    { mode: 0o755 },
  );
  const cfg = /** @type {any} */ ({
    pipeline: [{ id: "code", createsWorktree: true, idleMinutes: 0.001, sourceLabel: "src:code", successLabel: "src:review", verdictRepairs: 0 }, { id: "review", sourceLabel: "src:review" }],
    agentEnvPassthrough: ["FAKE_*"],
    claudeBin: bin,
    repoPath: repoDir,
    worktreePrefix: path.join(dir, "wt"),
    dataDir: dir,
    logDir: dir,
    instructionsFile: path.join(dir, "none.md"),
  });
  const store = createStore(dir);
  /** @type {any[]} */
  const advanced = [];
  /** @type {any[]} */
  const events = [];
  const adapter = /** @type {any} */ ({
    describe: () => ({
      platform: "GitHub",
      taskNoun: "issue",
      trigger: "@agent",
      commentHowTo: "comment",
      stageKeys: { source: "sourceLabel", success: "successLabel", failure: "failLabel", hold: "holdLabel", queue: "queueLabel" },
    }),
    fetchTask: async (/** @type {string} */ ref) => ({ ref, name: "t", description: "d", url: "u", completed: false, assignedToUs: true }),
    advance: async (/** @type {string} */ ref, /** @type {string} */ stepId, /** @type {any} */ v) => advanced.push({ ref, stepId, ...v }),
  });
  const emit = (/** @type {string} */ event, /** @type {string} */ _ref, /** @type {string} */ _step, /** @type {any} */ extra) => events.push({ event, ...extra });
  const run = createDispatcher(cfg, adapter, undefined, store, emit);
  process.env.FAKE_COUNTER = path.join(dir, "counter");
  const log = console.log;
  console.log = () => {};
  try {
    await run({ kind: "pipeline", ref: "42", stepId: "code", dedupKey: "k" });
  } finally {
    console.log = log;
    delete process.env.FAKE_COUNTER;
  }
  assert.equal(advanced[0]?.outcome, "fail");
  assert.match(advanced[0]?.reason, /^timeout/);
  assert.equal(events.find((e) => e.event === "run_end")?.verdictSource, undefined, "a timed-out run is never deduced, even though it committed");
});

test("dispatch: deduceVerdict gate — a cancelled run is never deduced, even with commits", async () => {
  // Commits first (so commitsSince alone would allow deduction), then goes idle until the
  // operator cancels it; `trap` makes the kill resolve as a clean exit(0), so only the
  // `cancelled.has(job.ref)` gate (step.js) stands between this and a spurious deduced advance.
  const dir = tmpDir();
  const repoDir = path.join(dir, "repo");
  fs.mkdirSync(repoDir, { recursive: true });
  execFileSync("git", ["init", "-q", repoDir]);
  execFileSync("git", ["-C", repoDir, "config", "user.email", "a@a.com"]);
  execFileSync("git", ["-C", repoDir, "config", "user.name", "a"]);
  fs.writeFileSync(path.join(repoDir, "f"), "x\n");
  execFileSync("git", ["-C", repoDir, "add", "f"]);
  execFileSync("git", ["-C", repoDir, "commit", "-q", "-m", "init"]);
  const bin = path.join(dir, "fake-claude.sh");
  fs.writeFileSync(
    bin,
    [
      `#!/bin/sh`,
      `n=0`,
      `[ -f "$FAKE_COUNTER" ] && n=$(cat "$FAKE_COUNTER")`,
      `n=$((n + 1))`,
      `echo "$n" > "$FAKE_COUNTER"`,
      `git commit -q --allow-empty -m c0`,
      `trap 'exit 0' TERM`,
      `printf '{"type":"result","subtype":"success","session_id":"ses_123","usage":{"input_tokens":1,"output_tokens":1},"total_cost_usd":0.01}\\n'`,
      `touch "$FAKE_READY"`,
      // dash only checks for a pending trap between commands, not while blocked inside one — a
      // single long `sleep` would eat the SIGTERM and get SIGKILLed instead of hitting `exit 0`.
      `i=0; while [ $i -lt 600 ]; do sleep 0.05; i=$((i + 1)); done`,
      ``,
    ].join("\n"),
    { mode: 0o755 },
  );
  const cfg = /** @type {any} */ ({
    pipeline: [{ id: "code", createsWorktree: true, sourceLabel: "src:code", successLabel: "src:review", verdictRepairs: 0 }, { id: "review", sourceLabel: "src:review" }],
    agentEnvPassthrough: ["FAKE_*"],
    claudeBin: bin,
    repoPath: repoDir,
    worktreePrefix: path.join(dir, "wt"),
    dataDir: dir,
    logDir: dir,
    instructionsFile: path.join(dir, "none.md"),
  });
  const store = createStore(dir);
  /** @type {any[]} */
  const advanced = [];
  /** @type {any[]} */
  const events = [];
  const adapter = /** @type {any} */ ({
    describe: () => ({
      platform: "GitHub",
      taskNoun: "issue",
      trigger: "@agent",
      commentHowTo: "comment",
      stageKeys: { source: "sourceLabel", success: "successLabel", failure: "failLabel", hold: "holdLabel", queue: "queueLabel" },
    }),
    fetchTask: async (/** @type {string} */ ref) => ({ ref, name: "t", description: "d", url: "u", completed: false, assignedToUs: true }),
    advance: async (/** @type {string} */ ref, /** @type {string} */ stepId, /** @type {any} */ v) => advanced.push({ ref, stepId, ...v }),
  });
  const emit = (/** @type {string} */ event, /** @type {string} */ _ref, /** @type {string} */ _step, /** @type {any} */ extra) => events.push({ event, ...extra });
  const run = createDispatcher(cfg, adapter, undefined, store, emit, undefined, undefined, { killGraceMs: 200 });
  const readyFile = path.join(dir, "ready");
  process.env.FAKE_COUNTER = path.join(dir, "counter");
  process.env.FAKE_READY = readyFile;
  const log = console.log;
  console.log = () => {};
  const done = run({ kind: "pipeline", ref: "42", stepId: "code", dedupKey: "k" });
  try {
    for (let i = 0; i < 200 && !fs.existsSync(readyFile); i++) await new Promise((r) => setTimeout(r, 25));
    assert.ok(fs.existsSync(readyFile), "fake agent reached the ready marker");
    assert.ok(store.listRunning()["42"]?.pid, "agent is running");
    assert.equal(run.cancel("42"), true);
    await done;
  } finally {
    console.log = log;
    delete process.env.FAKE_COUNTER;
    delete process.env.FAKE_READY;
  }
  assert.equal(advanced[0]?.outcome, "fail");
  assert.equal(advanced[0]?.reason, "cancelled by operator");
  assert.equal(events.find((e) => e.event === "run_end")?.verdictSource, undefined, "a cancelled run is never deduced, even though it committed");
});

