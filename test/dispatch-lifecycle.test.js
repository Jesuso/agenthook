import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// Dispatch — step timeouts (maxMinutes/idleMinutes), move_refused reporting (#265), and
// verdict `summary` parsing/storage (#563).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createDispatcher } from "../src/dispatch/index.js";
import { parseSummary, MAX_OPTION_CHARS, MAX_SUMMARY_CHARS } from "../src/dispatch/verdict.js";
import { createStore } from "../src/store/index.js";
import { DEFAULT_MAX_MINUTES } from "../src/pipeline.js";
import { createEmitter, reportMoveFailure } from "../src/events.js";
import { MoveRefusedError } from "../src/trackers/owner.js";
import { tmpDir, heldHarness, timeoutRun } from "./_dispatch-helpers.js";

// --- step timeouts (maxMinutes / idleMinutes) through the real dispatcher ---
// Fractional minutes keep the windows tiny (0.001 min = 60 ms); killGraceMs is injected.
// timeoutRun lives in test/_dispatch-helpers.js — test/dispatch-usage.test.js uses it too.

test("timeout: a run past maxMinutes is killed and fails with `timeout`; a pre-kill verdict file is ignored", async () => {
  const r = await timeoutRun(`printf '%s' '{"outcome":"advance"}' > "$AGENTHOOK_VERDICT_FILE"\nexec sleep 5`, { maxMinutes: 0.001 });
  assert.ok(r.elapsed < 4000, `killed early (${r.elapsed} ms)`);
  assert.equal(r.advanced.length, 1);
  assert.equal(r.advanced[0].outcome, "fail");
  assert.equal(r.advanced[0].reason, "timeout: exceeded maxMinutes=0.001");
  const failed = r.events.find((e) => e.event === "failed");
  assert.match(failed?.reason, /^timeout/);
  assert.equal(r.events.find((e) => e.event === "run_end")?.outcome, "fail");
  assert.match(r.logText, /\[agenthook\] killed: timeout: exceeded maxMinutes=0\.001/);
  assert.equal(r.verdictLeft, false, "verdict file still removed");
  assert.equal(r.children.size, 0);
});

test("timeout: a run past maxMinutes still fails with requireVerdict:true (timeout wins over the flag)", async () => {
  const r = await timeoutRun(`exec sleep 5`, { maxMinutes: 0.001, requireVerdict: true });
  assert.equal(r.advanced.length, 1);
  assert.equal(r.advanced[0].outcome, "fail");
  assert.match(r.advanced[0].reason, /^timeout/);
});

test("timeout: idleMinutes kills a silent agent", async () => {
  const r = await timeoutRun("exec sleep 5", { maxMinutes: 0, idleMinutes: 0.001 });
  assert.ok(r.elapsed < 4000);
  assert.equal(r.advanced[0].outcome, "fail");
  assert.equal(r.advanced[0].reason, "timeout: no output for idleMinutes=0.001");
});

test("timeout: an agent that keeps printing past idleMinutes is not killed", async () => {
  // a line every 30 ms for ~300 ms, idle window 120 ms
  const r = await timeoutRun(
    `i=0; while [ $i -lt 10 ]; do echo '{"type":"system"}'; sleep 0.03; i=$((i+1)); done\nprintf '%s' '{"outcome":"advance"}' > "$AGENTHOOK_VERDICT_FILE"`,
    { idleMinutes: 0.002 },
  );
  assert.equal(r.advanced[0].outcome, "advance");
  assert.doesNotMatch(r.logText, /killed/);
});

test("timeout: a child ignoring SIGTERM is SIGKILLed after the grace and the slot frees", async () => {
  const r = await timeoutRun(`trap '' TERM\nwhile :; do sleep 0.05; done`, { maxMinutes: 0.001 }, 100);
  assert.ok(r.elapsed < 3000, `freed after grace (${r.elapsed} ms)`);
  assert.equal(r.advanced[0].outcome, "fail");
  assert.match(r.advanced[0].reason, /^timeout/);
  assert.equal(r.children.size, 0);
});

test("timeout: a clean exit keeps its verdict even if a grandchild holds stdout past maxMinutes", async () => {
  // claude exits 0 at once; a backgrounded `sleep 2` keeps the pipe open past the 60 ms cap
  const r = await timeoutRun(`printf '%s' '{"outcome":"advance"}' > "$AGENTHOOK_VERDICT_FILE"\nsleep 2 &\nexit 0`, { maxMinutes: 0.001 }, 100);
  assert.equal(r.advanced[0].outcome, "advance");
  assert.doesNotMatch(r.logText, /killed/);
  assert.ok(r.elapsed < 1500, `slot freed after the drain grace, not the grandchild (${r.elapsed} ms)`);
  assert.equal(r.children.size, 0);
});

test("timeout: maxMinutes 0 sets no wall-clock cap; a default run behaves as before", async () => {
  const off = await timeoutRun(`sleep 0.2\nprintf '%s' '{"outcome":"advance"}' > "$AGENTHOOK_VERDICT_FILE"`, { maxMinutes: 0 });
  assert.equal(off.advanced[0].outcome, "advance");
  const dflt = await timeoutRun(`printf '%s' '{"outcome":"hold","reason":"q"}' > "$AGENTHOOK_VERDICT_FILE"`, {});
  assert.deepEqual([dflt.advanced[0].outcome, dflt.advanced[0].reason], ["hold", "q"]);
  assert.equal(DEFAULT_MAX_MINUTES, 120);
});

// --- a verdict's move that doesn't happen is reported (#265): move_refused after run_end ---

/** Run one clean `code` step whose adapter.advance throws `err`; return events.jsonl. @param {Error} err */
async function refusedRun(err) {
  const dir = tmpDir();
  const bin = path.join(dir, "fake-claude.sh");
  fs.writeFileSync(bin, `#!/bin/sh\nprintf '%s' '{"outcome":"advance"}' > "$AGENTHOOK_VERDICT_FILE"\n`, { mode: 0o755 });
  const cfg = /** @type {any} */ ({ pipeline: [{ id: "code" }, { id: "review" }], claudeBin: bin, repoPath: dir, dataDir: dir, logDir: dir, instructionsFile: path.join(dir, "none.md") });
  const adapter = /** @type {any} */ ({
    describe: () => ({ platform: "GitHub", taskNoun: "issue", trigger: "@agent", commentHowTo: "comment", usesPR: false }),
    fetchTask: async (/** @type {string} */ ref) => ({ ref, name: "t", description: "d", url: "u", completed: false, assignedToUs: true }),
    advance: async () => {
      throw err;
    },
  });
  const run = createDispatcher(cfg, adapter, undefined, createStore(dir), createEmitter(dir));
  const { log, error } = console;
  console.log = console.error = () => {};
  try {
    await run({ kind: "pipeline", ref: "42", stepId: "code", dedupKey: "k" });
  } finally {
    Object.assign(console, { log, error });
  }
  return fs.readFileSync(path.join(dir, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
}

test("dispatch: a refused advance emits move_refused {outcome, reason} after run_end", async () => {
  const evs = await refusedRun(new MoveRefusedError("owner_check_failed"));
  const names = evs.map((e) => e.event);
  const i = names.indexOf("move_refused");
  assert.ok(i > names.indexOf("run_end") && names.indexOf("run_end") >= 0, names.join(","));
  assert.deepEqual([evs[i].ref, evs[i].step, evs[i].outcome, evs[i].reason], ["42", "code", "advance", "owner_check_failed"]);
});

test("dispatch: a generic advance throw emits move_refused reason move_error with detail", async () => {
  const evs = await refusedRun(new Error("Asana addTask 500"));
  const e = evs.find((x) => x.event === "move_refused");
  assert.deepEqual([e?.outcome, e?.reason, e?.detail], ["advance", "move_error", "Asana addTask 500"]);
});

test("reportMoveFailure clips detail to 200 chars and tolerates a missing emit", () => {
  /** @type {any[]} */
  const got = [];
  reportMoveFailure((ev, ref, step, extra) => got.push({ ev, ref, step, ...extra }), "1", "s", "fail", new Error("x".repeat(500)));
  assert.equal(got[0].detail.length, 200);
  assert.equal(got[0].reason, "move_error");
  reportMoveFailure(undefined, "1", "s", "fail", new Error("y"));
});

// --- verdict `summary`: parsed, stored per (ref, step), replaced/cleared, never prompted ---

test("parseSummary: keeps a small plain object; drops non-objects and oversize with one log line", () => {
  /** @type {string[]} */
  const lines = [];
  const log = console.log;
  console.log = (/** @type {string} */ l) => lines.push(l);
  try {
    assert.equal(parseSummary(undefined), undefined);
    assert.deepEqual(lines, [], "absent → silent");
    const ok = { tier: "low", label: "🟢 low" };
    assert.equal(parseSummary(ok), ok);
    for (const bad of ["low", ["low"], null, 3, true]) assert.equal(parseSummary(bad), undefined);
    assert.equal(lines.length, 5);
    assert.ok(lines.every((l) => l === "[verdict] dropping summary (non-object)"));
    lines.length = 0;
    const big = { text: "x".repeat(300) };
    assert.equal(parseSummary(big), undefined);
    assert.deepEqual(lines, [`[verdict] dropping summary (oversize ${JSON.stringify(big).length} chars)`]);
  } finally {
    console.log = log;
  }
});

/** A held-style harness over code → review → done (manual drain). */
const summaryHarness = () =>
  heldHarness({ steps: [{ id: "code" }, { id: "review", kind: "review" }, { id: "done", manual: true, drainWorktree: true }] });

test("dispatch: a review summary is stored with the applied outcome + run, survives the manual drain, and never reaches a prompt", async () => {
  const { store, runStep, run } = summaryHarness();
  await runStep("review", { outcome: "advance", summary: { tier: "low", label: "🟢 low" } });
  const rec = store.getSummaries("42")?.review;
  assert.deepEqual(rec?.summary, { tier: "low", label: "🟢 low" });
  assert.equal(rec?.outcome, "advance");
  assert.match(String(rec?.run), /^[0-9T-]+Z-step-review-42\.log$/);
  assert.ok(rec?.at);

  // the manual drain step (done) runs before the PR merges — the summary must outlive it
  const log = console.log;
  console.log = () => {};
  try {
    await run({ kind: "pipeline", ref: "42", stepId: "done", dedupKey: "k:done" });
  } finally {
    console.log = log;
  }
  assert.equal(store.getSummaries("42")?.review?.outcome, "advance");

  // a later step's prompt never carries the stored summary text
  const prompt = await runStep("code", { outcome: "advance" });
  assert.ok(!prompt.includes("🟢 low"));
});

test("dispatch: a re-run replaces the summary; a re-run without one removes it; fail clears all", async () => {
  const { store, runStep } = summaryHarness();
  await runStep("review", { outcome: "advance", summary: { tier: "low" } });
  await runStep("review", { outcome: "hold", summary: { tier: "high" } });
  assert.deepEqual(store.getSummaries("42")?.review?.summary, { tier: "high" });
  assert.equal(store.getSummaries("42")?.review?.outcome, "hold");
  await runStep("review", { outcome: "advance" });
  assert.equal(store.getSummaries("42"), undefined, "no stale summary after a summary-less re-run");

  await runStep("code", { outcome: "advance", summary: { note: "c" } });
  await runStep("review", { outcome: "advance", summary: { tier: "low" } });
  assert.deepEqual(Object.keys(store.getSummaries("42") ?? {}).sort(), ["code", "review"]);
  await runStep("code", { outcome: "fail", summary: { note: "c2" } });
  assert.equal(store.getSummaries("42"), undefined, "terminal fail clears every step's summary");
});

test("dispatch: a bad summary is dropped with the outcome kept; a changes verdict's summary is stored as changes", async () => {
  const { store, runStep, advanced } = summaryHarness();
  await runStep("review", { outcome: "changes", summary: ["not", "an", "object"] });
  assert.equal(advanced.at(-1)[2], "changes", "outcome unaffected by the dropped summary");
  assert.equal(store.getSummaries("42"), undefined);
  await runStep("review", { outcome: "changes", summary: { tier: "medium" } });
  assert.equal(store.getSummaries("42")?.review?.outcome, "changes");
});

test("parseSummary: plain is measured apart from the cap — clipped on its own, dropped when not a string (#563)", () => {
  const files = Array.from({ length: 8 }, (_, i) => `src/some/dir/file-${i}.js`);
  const near = { verdict: "feature", files: files.slice(0, 7) };
  assert.ok(JSON.stringify(near).length <= 300);
  const withPlain = { ...near, plain: "Ready for coding: agents will write one plain sentence per run, shown in place of the reason." };
  assert.ok(JSON.stringify(withPlain).length > 300, "fixture: plain pushes it past the cap");
  assert.equal(parseSummary(withPlain), withPlain, "kept whole");
  const long = parseSummary({ risk: "low", plain: "x".repeat(500) });
  assert.equal(long?.plain.length, 300);
  assert.ok(long?.plain.endsWith("…"));
  assert.deepEqual(parseSummary({ risk: "low", plain: 3 }), { risk: "low" });
});

test("parseSummary: options is measured apart from the cap — 2-4 short strings kept, cleaned, never counted (#565)", () => {
  const withOptions = { risk: "low", options: Array.from({ length: 4 }, (_, i) => "x".repeat(MAX_OPTION_CHARS - 1) + i) };
  assert.ok(JSON.stringify(withOptions).length > MAX_SUMMARY_CHARS, "fixture: 4x80-char options alone would exceed the cap");
  const kept = parseSummary(withOptions);
  assert.deepEqual(kept, withOptions, "kept — options didn't count toward the cap");

  const collapsed = parseSummary({ options: ["  Postgres ", "SQLite\nnow", "MySQL", "none"] });
  assert.deepEqual(collapsed?.options, ["Postgres", "SQLite now", "MySQL", "none"]);
});

test("parseSummary: drops options alone (rest of summary survives) when not 2-4 short non-empty strings (#565)", () => {
  /** @type {string[]} */
  const lines = [];
  const log = console.log;
  console.log = (/** @type {string} */ l) => lines.push(l);
  try {
    const base = { risk: "low" };
    assert.deepEqual(parseSummary({ ...base, options: ["only one"] }), base, "1 entry dropped");
    assert.deepEqual(parseSummary({ ...base, options: ["a", "b", "c", "d", "e"] }), base, "5 entries dropped");
    assert.deepEqual(parseSummary({ ...base, options: ["ok", ""] }), base, "empty entry dropped");
    assert.deepEqual(parseSummary({ ...base, options: ["ok", "  "] }), base, "whitespace-only entry dropped");
    assert.deepEqual(parseSummary({ ...base, options: ["ok", 3] }), base, "non-string entry dropped");
    assert.deepEqual(parseSummary({ ...base, options: ["ok", "x".repeat(MAX_OPTION_CHARS + 1)] }), base, "oversize entry dropped");
    assert.deepEqual(parseSummary({ ...base, options: "not an array" }), base, "non-array dropped");
    assert.ok(lines.length >= 7 && lines.every((l) => l === "[verdict] dropping summary.options (not 2-4 short strings)"));
  } finally {
    console.log = log;
  }
});

test("run_end carries summary.plain whitespace-collapsed; absent when missing, blank or not a string (#563)", async () => {
  const { events, runStep } = summaryHarness();
  const ends = () => events.filter((e) => e.event === "run_end");
  await runStep("review", { outcome: "hold", summary: { plain: "  Needs a call\n on  the API name. ", tier: "low" } });
  assert.equal(ends().at(-1).plain, "Needs a call on the API name.");
  for (const summary of [undefined, { tier: "low" }, { plain: "   " }, { plain: 3 }]) {
    await runStep("review", { outcome: "advance", ...(summary ? { summary } : {}) });
    assert.equal("plain" in ends().at(-1), false, JSON.stringify(summary));
  }
  assert.deepEqual(ends().at(-1), { event: "run_end", outcome: "advance", verdictSource: "agent" }, "a verdict without plain emits run_end as before, now with verdictSource (#680)");
});

test("run_end carries summary.options only on a hold with valid options (#565)", async () => {
  const { events, runStep } = summaryHarness();
  const ends = () => events.filter((e) => e.event === "run_end");
  await runStep("review", { outcome: "hold", summary: { options: ["Postgres", "SQLite"], tier: "low" } });
  assert.deepEqual(ends().at(-1).options, ["Postgres", "SQLite"], "hold + valid options → carried");

  await runStep("review", { outcome: "advance", summary: { options: ["Postgres", "SQLite"] } });
  assert.equal("options" in ends().at(-1), false, "advance with options → dropped (not a hold)");

  await runStep("review", { outcome: "hold" });
  assert.equal("options" in ends().at(-1), false, "hold without options → absent");

  await runStep("review", { outcome: "hold", summary: { options: ["only one"] } });
  assert.equal("options" in ends().at(-1), false, "hold with invalid options → dropped");
});

