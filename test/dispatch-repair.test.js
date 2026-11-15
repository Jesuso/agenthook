import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// Dispatch — requireVerdict (#358, #500) and verdict-repair (#677): a clean exit with no
// valid verdict holds by default, or gets one receiver-driven resume turn first. Harnesses
// live in test/_dispatch-helpers.js.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createDispatcher, NO_VALID_VERDICT } from "../src/dispatch.js";
import { createStore } from "../src/store.js";
import { tmpDir, heldHarness, repairHarness } from "./_dispatch-helpers.js";

// --- requireVerdict (#358, #500): a clean exit with no valid verdict holds by default ---

test("dispatch: a clean exit with no readable verdict (empty file) holds by default", async () => {
  const h = heldHarness({ steps: [{ id: "code" }, { id: "done", manual: true }] });
  await h.runStep("code", "");
  assert.deepEqual(h.advanced, [["42", "code", "hold"]]);
  assert.equal(h.store.getHeld("42")?.stepId, "code");
  assert.equal(h.store.getHeld("42")?.reason, NO_VALID_VERDICT);
  const missing = h.events.find((e) => e.event === "verdict_missing");
  assert.equal(missing?.reason, NO_VALID_VERDICT);
  const blocked = h.events.find((e) => e.event === "blocked");
  assert.equal(blocked?.reason, NO_VALID_VERDICT);
  assert.ok(h.events.indexOf(missing) < h.events.indexOf(blocked), "verdict_missing fires before blocked");
});

test("dispatch: a clean exit with garbage verdict JSON holds by default too", async () => {
  const h = heldHarness({ steps: [{ id: "code" }, { id: "done", manual: true }] });
  await h.runStep("code", "not json");
  assert.deepEqual(h.advanced, [["42", "code", "hold"]]);
  assert.equal(h.store.getHeld("42")?.reason, NO_VALID_VERDICT);
});

test("dispatch: requireVerdict:false restores the old advance-on-clean-exit default", async () => {
  const h = heldHarness({ steps: [{ id: "code", requireVerdict: false }, { id: "done", manual: true }] });
  await h.runStep("code", "");
  assert.deepEqual(h.advanced, [["42", "code", "advance"]]);
  assert.equal(h.store.getHeld("42"), undefined);
  assert.equal(h.events.find((e) => e.event === "verdict_missing"), undefined);
});

// --- verdict-repair (#677): a clean exit with no valid verdict gets one receiver-driven
// resume turn (default verdictRepairs: 1) before a human is involved ---

test("dispatch: a clean exit with no verdict gets resumed once and advances once the resume turn writes one", async () => {
  const h = repairHarness();
  await h.runStep("code", { verdict: { outcome: "advance" }, goodAtTurn: 2 });
  assert.equal(h.calls(), 2, "the original run + exactly one repair turn");
  assert.deepEqual(h.resumedLog(), ["1:0", "2:1"], "the repair turn's argv carries -r <sessionId>");
  assert.deepEqual(h.advanced, [["42", "code", "advance"]]);
  assert.equal(h.store.getHeld("42"), undefined);
  const repairEvt = h.events.find((e) => e.event === "verdict_repair");
  const endEvt = h.events.find((e) => e.event === "run_end");
  assert.deepEqual(repairEvt, { event: "verdict_repair", result: "repaired", turns: 1 });
  assert.equal(endEvt?.repaired, true);
  assert.ok(h.events.indexOf(repairEvt) < h.events.indexOf(endEvt), "verdict_repair fires before run_end");
  // Usage summed across both turns (1 + 2 tokens each of input/output).
  assert.equal(endEvt?.input, 3);
  assert.equal(endEvt?.output, 3);
});

test("dispatch: a repair turn that also writes nothing holds, naming the repair attempt in the reason", async () => {
  const h = repairHarness();
  await h.runStep("code", {});
  assert.equal(h.calls(), 2, "the original run + exactly verdictRepairs (default 1) repair turns, no more");
  assert.deepEqual(h.resumedLog(), ["1:0", "2:1"]);
  assert.deepEqual(h.advanced, [["42", "code", "hold"]]);
  assert.equal(h.store.getHeld("42")?.reason, `${NO_VALID_VERDICT} (after 1 repair turn)`);
  assert.deepEqual(h.events.find((e) => e.event === "verdict_repair"), { event: "verdict_repair", result: "still_missing", turns: 1 });
  assert.equal(h.events.find((e) => e.event === "run_end")?.repaired, false);
  assert.equal(h.events.find((e) => e.event === "verdict_missing")?.reason, `${NO_VALID_VERDICT} (after 1 repair turn)`);
});

test("dispatch: verdictRepairs: 0 disables the repair turn — byte-identical to before #677", async () => {
  const h = repairHarness({ steps: [{ id: "code", verdictRepairs: 0 }, { id: "done", manual: true }] });
  await h.runStep("code", {});
  assert.equal(h.calls(), 1, "no resume spawn");
  assert.deepEqual(h.advanced, [["42", "code", "hold"]]);
  assert.equal(h.store.getHeld("42")?.reason, NO_VALID_VERDICT, "no repair-turn suffix");
  assert.equal(h.events.find((e) => e.event === "verdict_repair"), undefined);
  assert.equal(h.events.find((e) => e.event === "run_end")?.repaired, undefined);
});

test("dispatch: a crashed (non-zero exit) run gets no repair spawn", async () => {
  const h = repairHarness();
  await h.runStep("code", { exit: 1 });
  assert.equal(h.calls(), 1, "no resume spawn — a crash is never repaired");
  assert.deepEqual(h.advanced, [["42", "code", "fail"]]);
  assert.equal(h.events.find((e) => e.event === "verdict_repair"), undefined);
});

test("dispatch: requireVerdict:false gets no repair spawn either (nothing to repair)", async () => {
  const h = repairHarness({ steps: [{ id: "code", requireVerdict: false }, { id: "done", manual: true }] });
  await h.runStep("code", {});
  assert.equal(h.calls(), 1, "no resume spawn");
  assert.deepEqual(h.advanced, [["42", "code", "advance"]]);
  assert.equal(h.events.find((e) => e.event === "verdict_repair"), undefined);
});

test("dispatch: under 60s of maxMinutes left gets no repair spawn — byte-identical to no repair (#677 rework)", async () => {
  const h = repairHarness({ steps: [{ id: "code", maxMinutes: 1 }, { id: "done", manual: true }] });
  await h.runStep("code", {});
  assert.equal(h.calls(), 1, "no resume spawn — not enough of maxMinutes left for a repair turn");
  assert.deepEqual(h.advanced, [["42", "code", "hold"]]);
  assert.equal(h.store.getHeld("42")?.reason, NO_VALID_VERDICT, "no repair-turn suffix");
  assert.equal(h.events.find((e) => e.event === "verdict_repair"), undefined);
  assert.equal(h.events.find((e) => e.event === "run_end")?.repaired, undefined);
});

test("dispatch: an idle-timed-out run gets no repair spawn — byte-identical to no repair", async () => {
  // Prints a session_id (so the session-id gate alone wouldn't block a repair), then goes
  // silent until idleMinutes kills it; `trap` makes the kill resolve as a clean exit(0), so
  // only the `timedOut` gate (step.js) stands between this and a spurious repair spawn.
  const dir = tmpDir();
  const bin = path.join(dir, "fake-claude.sh");
  fs.writeFileSync(
    bin,
    [
      `#!/bin/sh`,
      `n=0`,
      `[ -f "$FAKE_COUNTER" ] && n=$(cat "$FAKE_COUNTER")`,
      `n=$((n + 1))`,
      `echo "$n" > "$FAKE_COUNTER"`,
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
    pipeline: [{ id: "code", idleMinutes: 0.001 }, { id: "done", manual: true }],
    agentEnvPassthrough: ["FAKE_*"],
    claudeBin: bin,
    repoPath: dir,
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
    describe: () => ({ platform: "GitHub", taskNoun: "issue", trigger: "@agent", commentHowTo: "comment" }),
    fetchTask: async (/** @type {string} */ ref) => ({ ref, name: "t", description: "d", url: "u", completed: false, assignedToUs: true }),
    advance: async (/** @type {string} */ _ref, /** @type {string} */ _step, /** @type {any} */ v) => advanced.push(v),
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
  assert.equal(fs.readFileSync(path.join(dir, "counter"), "utf8").trim(), "1", "no resume spawn — a timed-out run is never repaired");
  assert.equal(advanced[0].outcome, "fail");
  assert.match(advanced[0].reason, /^timeout/);
  assert.equal(events.find((e) => e.event === "verdict_repair"), undefined);
  assert.equal(events.find((e) => e.event === "run_end")?.repaired, undefined);
});

test("dispatch: a cancelled run gets no repair spawn — resolves as fail, cancelled by operator", async () => {
  // Prints a session_id before going idle, so the session-id gate alone wouldn't block a
  // repair; `trap` makes the operator's kill resolve as a clean exit(0), so only the
  // `cancelled.has(job.ref)` gate (step.js) stands between this and a spurious repair spawn.
  const dir = tmpDir();
  const bin = path.join(dir, "fake-claude.sh");
  fs.writeFileSync(
    bin,
    [
      `#!/bin/sh`,
      `n=0`,
      `[ -f "$FAKE_COUNTER" ] && n=$(cat "$FAKE_COUNTER")`,
      `n=$((n + 1))`,
      `echo "$n" > "$FAKE_COUNTER"`,
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
    pipeline: [{ id: "code" }, { id: "done", manual: true }],
    agentEnvPassthrough: ["FAKE_*"],
    claudeBin: bin,
    repoPath: dir,
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
    describe: () => ({ platform: "GitHub", taskNoun: "issue", trigger: "@agent", commentHowTo: "comment" }),
    fetchTask: async (/** @type {string} */ ref) => ({ ref, name: "t", description: "d", url: "u", completed: false, assignedToUs: true }),
    advance: async (/** @type {string} */ ref, /** @type {string} */ step, /** @type {any} */ v) => advanced.push({ ref, step, ...v }),
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
    // Wait for the fake to have emitted (and, as far as this test can observe, given the
    // parser a chance to capture) session_id before cancelling — otherwise the race between
    // process-spawn (pid set) and stdout parsing makes the session-id gate, not the
    // cancelled-gate, block the repair, and this test would pass for the wrong reason.
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
  assert.equal(fs.readFileSync(path.join(dir, "counter"), "utf8").trim(), "1", "no resume spawn — a cancelled run is never repaired");
  assert.equal(advanced.length, 1);
  assert.equal(advanced[0].outcome, "fail");
  assert.equal(advanced[0].reason, "cancelled by operator");
  assert.equal(events.find((e) => e.event === "verdict_repair"), undefined);
  assert.equal(events.find((e) => e.event === "run_end")?.repaired, undefined);
});

test("dispatch: an agent with no resumeArgs (hermes) gets no repair spawn — same hold as before #677", async () => {
  // Writes a session_id to stderr (hermes's own resume-id channel), so the session-id gate
  // alone wouldn't block a repair; only `!agent.resumeArgs` (step.js) stands between this
  // and a spurious fresh hermes chat using just the repair prompt.
  const dir = tmpDir();
  const bin = path.join(dir, "fake-hermes.sh");
  fs.writeFileSync(
    bin,
    [
      `#!/bin/sh`,
      // Only a "chat" call is a run (not hermes's own post-exit "sessions export" finalize
      // call, which must not inflate the repair-spawn count).
      `if [ "$1" = "chat" ]; then`,
      `  n=0`,
      `  [ -f "$FAKE_COUNTER" ] && n=$(cat "$FAKE_COUNTER")`,
      `  n=$((n + 1))`,
      `  echo "$n" > "$FAKE_COUNTER"`,
      `  printf 'session_id: ses_h\\n' >&2`,
      `  printf '%s' "Done with the fix."`,
      `  exit 0`,
      `fi`,
      `exit 1`,
      ``,
    ].join("\n"),
    { mode: 0o755 },
  );
  const cfg = /** @type {any} */ ({
    pipeline: [{ id: "code", agent: "hermes", bin, isolated: false }],
    agent: "hermes",
    agentEnvPassthrough: ["FAKE_*"],
    claudeBin: bin,
    repoPath: dir,
    worktreePrefix: path.join(dir, "wt"),
    dataDir: dir,
    logDir: dir,
    instructionsFile: path.join(dir, "none.md"),
  });
  const store = createStore(dir);
  /** @type {any[]} */
  const events = [];
  const adapter = /** @type {any} */ ({
    describe: () => ({ platform: "GitHub", taskNoun: "issue", trigger: "@agent", commentHowTo: "comment" }),
    fetchTask: async (/** @type {string} */ ref) => ({ ref, name: "t", description: "d", url: "u", completed: false, assignedToUs: true }),
    advance: async () => {},
  });
  const emit = (/** @type {string} */ event, /** @type {string} */ _ref, /** @type {string} */ _step, /** @type {any} */ extra) => events.push({ event, ...extra });
  const run = createDispatcher(cfg, adapter, undefined, store, emit);
  process.env.FAKE_COUNTER = path.join(dir, "counter");
  const log = console.log;
  console.log = () => {};
  try {
    await run({ kind: "pipeline", ref: "42", stepId: "code", dedupKey: "k:code" });
  } finally {
    console.log = log;
    delete process.env.FAKE_COUNTER;
  }
  assert.equal(fs.readFileSync(path.join(dir, "counter"), "utf8").trim(), "1", "no resume spawn — hermes has no resumeArgs");
  assert.equal(store.getHeld("42")?.reason, NO_VALID_VERDICT);
  assert.equal(events.find((e) => e.event === "verdict_repair"), undefined);
  assert.equal(events.find((e) => e.event === "run_end")?.repaired, undefined);
});

// A sandboxed opencode run (sandboxResume:false) is covered end to end in
// test/dispatch-sandbox.test.js, which already has the real-worktree + fake-docker harness
// this needs (agent.sandbox(), sandbox.describe().home, trustedGitDirs on a real checkout).

test("dispatch: a repair turn that crashes on its second call (not the first) resolves fail with the usual reason", async () => {
  const dir = tmpDir();
  const bin = path.join(dir, "fake-claude.sh");
  fs.writeFileSync(
    bin,
    [
      `#!/bin/sh`,
      `n=0`,
      `[ -f "$FAKE_COUNTER" ] && n=$(cat "$FAKE_COUNTER")`,
      `n=$((n + 1))`,
      `echo "$n" > "$FAKE_COUNTER"`,
      `printf '{"type":"result","subtype":"success","session_id":"ses_123","usage":{"input_tokens":1,"output_tokens":1},"total_cost_usd":0.01}\\n'`,
      `if [ "$n" -ge 2 ]; then exit 1; fi`,
      `exit 0`,
      ``,
    ].join("\n"),
    { mode: 0o755 },
  );
  const cfg = /** @type {any} */ ({
    pipeline: [{ id: "code" }, { id: "done", manual: true }],
    agentEnvPassthrough: ["FAKE_*"],
    claudeBin: bin,
    repoPath: dir,
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
    describe: () => ({ platform: "GitHub", taskNoun: "issue", trigger: "@agent", commentHowTo: "comment" }),
    fetchTask: async (/** @type {string} */ ref) => ({ ref, name: "t", description: "d", url: "u", completed: false, assignedToUs: true }),
    advance: async (/** @type {string} */ ref, /** @type {string} */ step, /** @type {any} */ v) => advanced.push({ ref, step, ...v }),
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
  assert.equal(fs.readFileSync(path.join(dir, "counter"), "utf8").trim(), "2", "the original run + exactly one repair turn, no more after it crashes");
  assert.equal(advanced[0].outcome, "fail", "the crashed repair turn's own code resolves the run, not NO_VALID_VERDICT");
  assert.equal(advanced[0].reason, "non-zero exit (1)");
  assert.deepEqual(events.find((e) => e.event === "verdict_repair"), { event: "verdict_repair", result: "still_missing", turns: 1 });
  assert.equal(events.find((e) => e.event === "run_end")?.repaired, false);
});

test("dispatch: repair-turn cost is summed into the run's usage record", async () => {
  const h = repairHarness();
  await h.runStep("code", { verdict: { outcome: "advance" }, goodAtTurn: 2 });
  assert.equal(h.calls(), 2);
  const usage = createStore(h.dir).readUsage();
  const row = usage.find((/** @type {any} */ u) => u.ref === "42" && u.stepId === "code");
  assert.ok(row, "a usage row was written");
  assert.equal(row.costUsd, 0.02, "0.01 per call, summed across the original run and the repair turn");
});

