import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// A step's `gate` (#710), wired through step.js/finish.js — not just runGate in isolation
// (test/dispatch-gate.test.js covers that). Same fake-`claude` pattern as the verdict-repair
// tests in test/dispatch.test.js: a counter + optional session id + a prompt log, plus a small
// real shell "gate" that fails until a counter file it owns reaches $GATE_GOOD_AT.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createDispatcher } from "../src/dispatch.js";
import { createStore } from "../src/store.js";

/** @returns {string} */
function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agenthook-gate-wiring-"));
}

// A gate that fails until its own counter file reaches $GATE_GOOD_AT (unset/0 => never passes),
// echoing "gate-output-<n>" each run so the repair prompt / hold reason can be asserted against.
const GATE_SCRIPT = 'n=$(( $(cat "$GATE_COUNTER_FILE" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$GATE_COUNTER_FILE"; echo "gate-output-$n"; [ "$n" -ge "${GATE_GOOD_AT:-999}" ]';

/** @param {{steps?: any[], cfg?: any, meta?: any, forge?: any}} [o] */
function gateHarness({ steps, cfg: cfgOver, meta: metaOver, forge } = {}) {
  const dir = tmpDir();
  const bin = path.join(dir, "fake-claude.sh");
  const counterFile = path.join(dir, "counter");
  const resumedFile = path.join(dir, "resumed");
  const promptLog = path.join(dir, "prompts.log");
  const gateCounterFile = path.join(dir, "gate-counter");
  fs.writeFileSync(
    bin,
    [
      `#!/bin/sh`,
      `n=0`,
      `[ -f "$FAKE_COUNTER" ] && n=$(cat "$FAKE_COUNTER")`,
      `n=$((n + 1))`,
      `echo "$n" > "$FAKE_COUNTER"`,
      `{ echo "=== CALL $n ==="; printf '%s\\n' "$2"; } >> "$FAKE_PROMPT_LOG"`,
      `resumed=0`,
      `prev=""`,
      `for a in "$@"; do [ "$prev" = "-r" ] && resumed=1; prev="$a"; done`,
      `echo "$n:$resumed" >> "$FAKE_RESUMED"`,
      `if [ -n "$FAKE_NO_SESSION" ]; then`,
      `  printf '{"type":"result","subtype":"success","usage":{"input_tokens":%d,"output_tokens":%d},"total_cost_usd":0.01}\\n' "$n" "$n"`,
      `else`,
      `  printf '{"type":"result","subtype":"success","session_id":"ses_123","usage":{"input_tokens":%d,"output_tokens":%d},"total_cost_usd":0.01}\\n' "$n" "$n"`,
      `fi`,
      `if [ -n "$FAKE_VERDICT" ] && { [ -z "$FAKE_GOOD_AT_TURN" ] || [ "$n" -ge "$FAKE_GOOD_AT_TURN" ]; }; then printf '%s' "$FAKE_VERDICT" > "$AGENTHOOK_VERDICT_FILE"; fi`,
      `exit "\${FAKE_EXIT:-0}"`,
      ``,
    ].join("\n"),
    { mode: 0o755 },
  );
  const cfg = /** @type {any} */ ({
    pipeline: steps || [{ id: "code", gate: GATE_SCRIPT, gateTimeoutMinutes: 1, env: { GATE_COUNTER_FILE: gateCounterFile } }, { id: "done", manual: true }],
    agentEnvPassthrough: ["FAKE_*", "GATE_*"],
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
    describe: () => ({ platform: "GitHub", taskNoun: "issue", trigger: "@agent", commentHowTo: "comment", ...metaOver }),
    fetchTask: async (/** @type {string} */ ref) => ({ ref, name: "t", description: "d", url: "u", completed: false, assignedToUs: true }),
    advance: async (/** @type {string} */ ref, /** @type {string} */ stepId, /** @type {any} */ verdict) => advanced.push({ ref, stepId, ...verdict }),
  });
  const emit = (/** @type {string} */ event, /** @type {string} */ _ref, /** @type {string} */ _step, /** @type {any} */ extra) => events.push({ event, ...extra });
  const run = createDispatcher(cfg, adapter, undefined, store, emit, forge);
  /** @param {string} stepId @param {{verdict?: any, goodAtTurn?: number, exit?: number, noSession?: boolean, gateGoodAt?: number}} [o] */
  const runStep = async (stepId, { verdict, goodAtTurn, exit, noSession, gateGoodAt } = {}) => {
    process.env.FAKE_COUNTER = counterFile;
    process.env.FAKE_RESUMED = resumedFile;
    process.env.FAKE_PROMPT_LOG = promptLog;
    process.env.FAKE_VERDICT = verdict ? JSON.stringify(verdict) : "";
    if (goodAtTurn) process.env.FAKE_GOOD_AT_TURN = String(goodAtTurn);
    else delete process.env.FAKE_GOOD_AT_TURN;
    if (exit) process.env.FAKE_EXIT = String(exit);
    else delete process.env.FAKE_EXIT;
    if (noSession) process.env.FAKE_NO_SESSION = "1";
    else delete process.env.FAKE_NO_SESSION;
    if (gateGoodAt) process.env.GATE_GOOD_AT = String(gateGoodAt);
    else delete process.env.GATE_GOOD_AT;
    const log = console.log;
    console.log = () => {};
    try {
      await run({ kind: "pipeline", ref: "42", stepId, dedupKey: `k:${stepId}` });
    } finally {
      console.log = log;
    }
  };
  const calls = () => (fs.existsSync(counterFile) ? Number(fs.readFileSync(counterFile, "utf8").trim()) : 0);
  const resumedLog = () => (fs.existsSync(resumedFile) ? fs.readFileSync(resumedFile, "utf8").trim().split("\n") : []);
  const prompts = () => (fs.existsSync(promptLog) ? fs.readFileSync(promptLog, "utf8") : "");
  const gateCalls = () => (fs.existsSync(gateCounterFile) ? Number(fs.readFileSync(gateCounterFile, "utf8").trim()) : 0);
  return { store, advanced, events, runStep, calls, resumedLog, prompts, gateCalls, dir };
}

test("dispatch gate: an advance that fails the gate once, then passes on repair — no advance between passes", async () => {
  const h = gateHarness();
  await h.runStep("code", { verdict: { outcome: "advance" }, goodAtTurn: 1, gateGoodAt: 2 });
  assert.equal(h.gateCalls(), 2, "the gate ran twice: fail, then pass");
  assert.equal(h.calls(), 2, "one repair turn resumed the agent once");
  assert.deepEqual(h.resumedLog(), ["1:0", "2:1"], "the repair turn resumed the same session");
  assert.equal(h.advanced.length, 1, "advance only happens once, after the gate passes");
  assert.equal(h.advanced[0].outcome, "advance");

  const fail = h.events.find((e) => e.event === "gate_fail");
  const pass = h.events.find((e) => e.event === "gate_pass");
  const end = h.events.find((e) => e.event === "run_end");
  assert.ok(fail && pass && end, JSON.stringify(h.events));
  assert.equal(fail.exitCode, 1);
  assert.equal(pass.exitCode, 0);
  assert.equal(end.gate, "pass");
  assert.equal(end.outcome, "advance");
  const order = h.events.map((e) => e.event);
  assert.ok(order.indexOf("gate_fail") < order.indexOf("gate_pass"));
  assert.ok(order.indexOf("gate_pass") < order.indexOf("run_end"));

  // the repair turn's prompt carries the gate's output tail in a GATE_OUTPUT fence
  const prompts = h.prompts();
  assert.match(prompts, /GATE_OUTPUT/);
  assert.match(prompts, /gate-output-1/);
});

test("dispatch gate: a gate that never passes holds once maxAttempts is spent — gate repairs count toward it", async () => {
  const h = gateHarness();
  await h.runStep("code", { verdict: { outcome: "advance", summary: { plain: "hi" } }, goodAtTurn: 1 }); // gateGoodAt unset: the gate never passes
  assert.deepEqual(h.advanced.map((a) => a.outcome), ["hold"]);
  // the reason carries the *last* gate attempt's output tail, not every attempt's
  assert.match(h.advanced[0].reason, /^gate failed \(exit 1\) after \d+ attempt\(s\): [\s\S]*gate-output-\d+/);
  const end = h.events.find((e) => e.event === "run_end");
  assert.equal(end?.gate, "fail");
  assert.equal(end.verdictSource, undefined, "a gate-cap hold is receiver-forced: run_end has no verdictSource");
  assert.equal(h.store.getSummaries("42")?.code?.verdictSource, undefined, "neither does the stored summary");
  assert.equal(h.events.filter((e) => e.event === "gate_fail").length, h.gateCalls());
  assert.equal(h.events.find((e) => e.event === "gate_pass"), undefined);
  // default maxAttempts (3): the initial run already counts as attempt 1, so only 2 more
  // gate-repair turns fit under the cap before it's exhausted — 3 calls total, no more
  assert.equal(h.calls(), 3);
  assert.equal(h.store.getAttempt("42", "code"), 3);
});

test("dispatch gate: a long gate output keeps the *last* 1000 chars in the hold reason", async () => {
  const marker = "UNIQUE-END-MARKER-9f3a";
  const gate = `printf 'x%.0s' $(seq 1 2000); echo "${marker}"; exit 1`;
  const h = gateHarness({ steps: [{ id: "code", gate, gateTimeoutMinutes: 1 }, { id: "done", manual: true }] });
  await h.runStep("code", { verdict: { outcome: "advance" }, goodAtTurn: 1 });
  assert.deepEqual(h.advanced.map((a) => a.outcome), ["hold"]);
  const reason = String(h.advanced[0].reason);
  assert.match(reason, new RegExp(`${marker}\\s*$`), "the reason ends with the tail's end, not its head");
  assert.equal(reason.startsWith("gate failed"), true);
});

test("dispatch gate: no resume path (no session id) falls back to a fresh spawn, not a resume", async () => {
  const h = gateHarness();
  await h.runStep("code", { verdict: { outcome: "advance" }, goodAtTurn: 1, gateGoodAt: 2, noSession: true });
  assert.deepEqual(h.resumedLog(), ["1:0", "2:0"], "the repair turn was never resumed (-r), both calls fresh");
  assert.equal(h.advanced.length, 1);
  assert.equal(h.advanced[0].outcome, "advance");
});

for (const outcome of ["hold", "fail", "changes"]) {
  test(`dispatch gate: a "${outcome}" verdict never runs the gate`, async () => {
    const h = gateHarness();
    const verdict = outcome === "changes" ? { outcome: "changes", target: "done" } : { outcome };
    await h.runStep("code", { verdict, goodAtTurn: 1 });
    assert.equal(h.gateCalls(), 0, "the gate never ran");
    assert.equal(h.events.find((e) => e.event?.startsWith("gate_")), undefined);
  });
}

test("dispatch gate: a clean exit with no verdict (missing) never runs the gate", async () => {
  const h = gateHarness();
  await h.runStep("code", {}); // no FAKE_VERDICT, verdictRepairs default consumes the repair turn too
  assert.equal(h.gateCalls(), 0);
  assert.equal(h.events.find((e) => e.event?.startsWith("gate_")), undefined);
});

test("dispatch gate: a repaired advance (#677) also runs the gate", async () => {
  const h = gateHarness();
  await h.runStep("code", { verdict: { outcome: "advance" }, goodAtTurn: 2, gateGoodAt: 1 });
  assert.equal(h.calls(), 2, "the original run + one verdict-repair turn");
  assert.equal(h.gateCalls(), 1, "the gate ran once, right after the repair turn's advance");
  assert.equal(h.advanced.length, 1);
  assert.equal(h.advanced[0].outcome, "advance");
  assert.ok(h.events.find((e) => e.event === "verdict_repair"), "the verdict-repair loop ran first");
  assert.ok(h.events.find((e) => e.event === "gate_pass"));
});

// --- a deduced advance (#680) also runs the gate ---

/** A fake `claude` that writes no verdict but commits once (so the run is a DEDUCED advance, #680),
 * same shape as dispatch.test.js's deduceHarness, with a `gate` added to the pipeline step.
 * `gateGoodAt` sets when the gate starts passing (default: it passes on the first run). */
function gateDeduceHarness({ gateGoodAt = "1" } = {}) {
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
      `git commit -q --allow-empty -m c0`,
      `printf '{"type":"result","subtype":"success","session_id":"ses_123","usage":{"input_tokens":1,"output_tokens":1},"total_cost_usd":0.01}\\n'`,
      `exit 0`,
      ``,
    ].join("\n"),
    { mode: 0o755 },
  );
  const gateCounterFile = path.join(dir, "gate-counter");
  const cfg = /** @type {any} */ ({
    pipeline: [
      { id: "code", createsWorktree: true, sourceLabel: "src:code", successLabel: "src:review", gate: GATE_SCRIPT, gateTimeoutMinutes: 1, env: { GATE_COUNTER_FILE: gateCounterFile, GATE_GOOD_AT: gateGoodAt } },
      { id: "review", sourceLabel: "src:review" },
    ],
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
    describe: () => ({ platform: "GitHub", taskNoun: "issue", trigger: "@agent", commentHowTo: "comment", stageKeys: { source: "sourceLabel", success: "successLabel", failure: "failLabel", hold: "holdLabel", queue: "queueLabel" } }),
    fetchTask: async (/** @type {string} */ ref) => ({ ref, name: "t", description: "d", url: "u", completed: false, assignedToUs: true }),
    advance: async (/** @type {string} */ ref, /** @type {string} */ stepId, /** @type {any} */ verdict) => advanced.push({ ref, stepId, ...verdict }),
  });
  const emit = (/** @type {string} */ event, /** @type {string} */ _ref, /** @type {string} */ _step, /** @type {any} */ extra) => events.push({ event, ...extra });
  const run = createDispatcher(cfg, adapter, undefined, store, emit);
  const runStep = async () => {
    const log = console.log;
    console.log = () => {};
    try {
      await run({ kind: "pipeline", ref: "42", stepId: "code", dedupKey: "k:code" });
    } finally {
      console.log = log;
    }
  };
  const gateCalls = () => (fs.existsSync(gateCounterFile) ? Number(fs.readFileSync(gateCounterFile, "utf8").trim()) : 0);
  return { store, advanced, events, runStep, gateCalls };
}

test("dispatch gate: a deduced advance (#680) also runs the gate", async () => {
  const h = gateDeduceHarness();
  await h.runStep();
  assert.deepEqual(h.advanced.map((a) => a.outcome), ["advance"]);
  assert.equal(h.events.find((e) => e.event === "run_end")?.verdictSource, "deduced");
  assert.equal(h.gateCalls(), 1, "the gate ran once, after deduction");
  assert.ok(h.events.find((e) => e.event === "gate_pass"));
});

test("dispatch gate: a deduced advance whose gate never passes must never advance (#710 review)", async () => {
  const h = gateDeduceHarness({ gateGoodAt: "999" });
  await h.runStep();
  // the move (adapter.advance) is reached, but only as a hold — never an advance — and the
  // held reason carries the gate's output tail
  assert.deepEqual(h.advanced.map((a) => a.outcome), ["hold"], "the gate vetoed the deduced advance");
  assert.match(String(h.advanced[0].reason), /^gate failed \(exit 1\)/);
  const end = h.events.find((e) => e.event === "run_end");
  assert.equal(end.outcome, "hold", JSON.stringify(h.events));
  assert.equal(end.gate, "fail");
  assert.ok(h.events.find((e) => e.event === "gate_fail"), "the gate_fail event fired");
});

test("dispatch gate: the gate env carries no tracker or forge token, even though the agent's own env does", async () => {
  const saved = { GITHUB_TOKEN: process.env.GITHUB_TOKEN, GH_TOKEN: process.env.GH_TOKEN };
  Object.assign(process.env, { GITHUB_TOKEN: "tracker-pat", GH_TOKEN: "forge-pat" });
  try {
    const dumpFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agenthook-gate-env-")), "dump");
    const gate = `printf 'GITHUB_TOKEN=%s\\nGH_TOKEN=%s\\n' "\${GITHUB_TOKEN:-unset}" "\${GH_TOKEN:-unset}" > "${dumpFile}"; exit 0`;
    const h = gateHarness({
      steps: [{ id: "code", gate, gateTimeoutMinutes: 1 }, { id: "done", manual: true }],
      meta: { agentEnv: ["GITHUB_TOKEN"] },
      forge: { describe: () => ({ name: "github", agentEnv: ["GH_TOKEN"] }) },
    });
    await h.runStep("code", { verdict: { outcome: "advance" }, goodAtTurn: 1 });
    assert.equal(h.advanced[0]?.outcome, "advance", JSON.stringify(h.advanced));
    const dumped = fs.readFileSync(dumpFile, "utf8");
    assert.match(dumped, /GITHUB_TOKEN=unset/, "the gate must not see the tracker's token");
    assert.match(dumped, /GH_TOKEN=unset/, "the gate must not see the forge's token");
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

test("dispatch gate: no gate configured — no gate field on run_end, byte-identical to before #710", async () => {
  const h = gateHarness({ steps: [{ id: "code" }, { id: "done", manual: true }] });
  await h.runStep("code", { verdict: { outcome: "advance" }, goodAtTurn: 1 });
  assert.equal(h.advanced.length, 1);
  assert.equal(h.advanced[0].outcome, "advance");
  assert.equal(h.events.find((e) => e.event === "run_end")?.gate, undefined);
  assert.equal(h.events.find((e) => e.event?.startsWith("gate_")), undefined);
});
