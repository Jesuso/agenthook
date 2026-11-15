import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// Dispatch — an unpriced (local-model) run's usage record, pickTurnStats (#657), the live
// context gauge (#658), and quota (#397) wiring.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDispatcher } from "../src/dispatch.js";
import { pickTurnStats } from "../src/dispatch/spawn.js";
import { createStore } from "../src/store.js";
import { tmpDir, timeoutRun } from "./_dispatch-helpers.js";

// --- run_end of an unpriced (local-model) run: no costUsd, unpriced:true ---

const RESULT_LINE = JSON.stringify({ type: "result", total_cost_usd: 0.75, usage: { input_tokens: 10, output_tokens: 5 }, modelUsage: { "claude-opus-4-8": {} } });

test("run_end: a priced run carries costUsd and no unpriced key", async () => {
  const r = await timeoutRun(`echo '${RESULT_LINE}'`, {});
  const end = r.events.find((e) => e.event === "run_end");
  assert.equal(end?.costUsd, 0.75);
  assert.equal("unpriced" in end, false);
});

test("run_end + usage record: turns/firstContext/peakContext/lastContext (#645) ride along when the parser saw turns", async () => {
  const ASSISTANT_LINE = JSON.stringify({ type: "assistant", message: { id: "msg_1", content: [], usage: { input_tokens: 1000 } } });
  const r = await timeoutRun(`echo '${ASSISTANT_LINE}'\necho '${RESULT_LINE}'`, {});
  const end = r.events.find((e) => e.event === "run_end");
  assert.deepEqual([end.turns, end.firstContext, end.peakContext, end.lastContext], [1, 1000, 1000, 1000]);
  assert.deepEqual([r.usage[0].turns, r.usage[0].firstContext, r.usage[0].peakContext, r.usage[0].lastContext], [1, 1000, 1000, 1000]);
});

test("run_end + usage record: no per-turn usage seen → turns/firstContext/peakContext/lastContext absent, not zero", async () => {
  const r = await timeoutRun(`echo '${RESULT_LINE}'`, {});
  const end = r.events.find((e) => e.event === "run_end");
  for (const k of ["turns", "firstContext", "peakContext", "lastContext", "compactions"]) {
    assert.equal(k in end, false, `${k} absent from run_end`);
    assert.equal(k in r.usage[0], false, `${k} absent from the usage record`);
  }
});

// --- pickTurnStats (src/dispatch/spawn.js): compactions (#657) rides the same `turns` guard ---

test("pickTurnStats: compactions is copied only alongside turns", () => {
  assert.deepEqual(pickTurnStats({ turns: 2, compactions: 1 }), { turns: 2, compactions: 1 });
  assert.equal(pickTurnStats({ compactions: 0 }), undefined, "no turns → undefined, even with compactions set");
  assert.deepEqual(pickTurnStats({ turns: 1 }), { turns: 1 }, "cursor/hermes-style tally (no compactions) yields no key");
  assert.deepEqual(pickTurnStats({ turns: 3, firstContext: 10, peakContext: 30, lastContext: 20, compactions: 0 }), { turns: 3, firstContext: 10, peakContext: 30, lastContext: 20, compactions: 0 });
});

test("run_end + usage record: a compact_boundary event rides along as compactions (#657)", async () => {
  const ASSISTANT_LINE = JSON.stringify({ type: "assistant", message: { id: "msg_1", content: [], usage: { input_tokens: 1000 } } });
  const BOUNDARY_LINE = JSON.stringify({ type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto", pre_tokens: 1000 } });
  const r = await timeoutRun(`echo '${ASSISTANT_LINE}'\necho '${BOUNDARY_LINE}'\necho '${RESULT_LINE}'`, {});
  const end = r.events.find((e) => e.event === "run_end");
  assert.equal(end.compactions, 1);
  assert.equal(r.usage[0].compactions, 1);
});

test("run_end: a non-Claude step model is unpriced — no costUsd", async () => {
  const r = await timeoutRun(`echo '${RESULT_LINE}'`, { model: "qwen3-coder" });
  const end = r.events.find((e) => e.event === "run_end");
  assert.equal(end?.unpriced, true);
  assert.equal("costUsd" in end, false);
  assert.equal("estUsd" in end, false, "no rate for qwen3-coder → no estimate");
  assert.deepEqual([end.model, end.input, end.output], ["qwen3-coder", 10, 5], "model + tokens ride along");
});

test("run_end + usage record: a reported run is tagged costBasis reported, costUsd unchanged, no estUsd", async () => {
  const r = await timeoutRun(`echo '${RESULT_LINE}'`, {});
  const end = r.events.find((e) => e.event === "run_end");
  assert.equal(end.costUsd, 0.75);
  assert.equal(end.costBasis, "reported");
  assert.equal("estUsd" in end, false);
  assert.equal(r.usage[0].costUsd, 0.75);
  assert.equal(r.usage[0].costBasis, "reported");
  assert.equal("estUsd" in r.usage[0], false);
});

test("run_end + usage record: an unpriced run whose model has a `pricing` rate is stamped estUsd / rate-table", async () => {
  const r = await timeoutRun(`echo '${RESULT_LINE}'`, { model: "qwen3-coder" }, 2000, { pricing: { "qwen3*": { input: 1e5, output: 1e5 } } });
  const end = r.events.find((e) => e.event === "run_end");
  assert.equal("costUsd" in end, false, "costUsd stays reported-only");
  assert.equal(end.estUsd, 1.5, "15 tokens × $100k/Mtok");
  assert.equal(end.costBasis, "rate-table");
  assert.equal(r.usage[0].costUsd, 0.75, "the raw figure is kept on the record");
  assert.equal(r.usage[0].unpriced, true);
  assert.equal(r.usage[0].estUsd, 1.5);
});

// --- live context gauge (#658): ctxMax on run_start/running.json, ctx once a turn is seen ---

test("run_start: ctxMax rides along only when the model's context window is known", async () => {
  const known = await timeoutRun(`echo '${RESULT_LINE}'`, { model: "claude-opus-5-5" });
  assert.equal(known.events.find((e) => e.event === "run_start")?.ctxMax, 1000000);
  const unknown = await timeoutRun(`echo '${RESULT_LINE}'`, { model: "qwen3-coder" });
  assert.equal("ctxMax" in (unknown.events.find((e) => e.event === "run_start") ?? {}), false);
});

test("running.json: ctxMax is set from the start; ctx joins it once the parser sees a turn", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthook-ctx-"));
  const bin = path.join(dir, "fake-claude.sh");
  const out = path.join(dir, "out");
  const runningPath = path.join(dir, "running.json");
  const ASSISTANT_LINE = JSON.stringify({ type: "assistant", message: { id: "msg_1", content: [], usage: { input_tokens: 500, output_tokens: 5 } } });
  fs.writeFileSync(
    bin,
    `#!/bin/sh\nprintf '%s\\n' '${ASSISTANT_LINE}'\nn=0; while ! grep -q '"ctx"' "${runningPath}" 2>/dev/null && [ $n -lt 100 ]; do sleep 0.05; n=$((n+1)); done\ncp "${runningPath}" "${out}.running"\nprintf '%s\\n' '${RESULT_LINE}'\nprintf '%s' '{"outcome":"advance"}' > "$AGENTHOOK_VERDICT_FILE"\n`,
    { mode: 0o755 },
  );
  const cfg = /** @type {any} */ ({
    pipeline: [{ id: "code", model: "claude-opus-5-5" }, { id: "done", manual: true }],
    claudeBin: bin,
    repoPath: dir,
    dataDir: dir,
    logDir: dir,
    instructionsFile: path.join(dir, "none.md"),
  });
  const adapter = /** @type {any} */ ({
    describe: () => ({ platform: "GitHub", taskNoun: "issue", trigger: "@agent", commentHowTo: "comment" }),
    fetchTask: async (/** @type {string} */ ref) => ({ ref, name: "t", description: "d", url: "u", completed: false, assignedToUs: true }),
    advance: async () => {},
  });
  const run = createDispatcher(cfg, adapter, undefined, createStore(dir), () => {});
  const log = console.log;
  console.log = () => {};
  try {
    await run({ kind: "pipeline", ref: "42", stepId: "code", dedupKey: "k" });
  } finally {
    console.log = log;
  }
  const running = JSON.parse(fs.readFileSync(`${out}.running`, "utf8"))["42"];
  assert.equal(running.ctxMax, 1000000, "set from the first running.json write, before any turn");
  assert.equal(running.ctx, 500, "lastContext from the parser's tally, after the first turn");
});

test("onTally: a run whose ctx exceeds ctxMax logs one warning naming the model, never more (#700)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthook-ctx-overflow-"));
  const bin = path.join(dir, "fake-claude.sh");
  const out = path.join(dir, "out");
  const runningPath = path.join(dir, "running.json");
  const turn = (id) => JSON.stringify({ type: "assistant", message: { id, content: [], usage: { input_tokens: 212000, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } });
  fs.writeFileSync(
    bin,
    `#!/bin/sh\nprintf '%s\\n' '${turn("msg_1")}'\nprintf '%s\\n' '${turn("msg_2")}'\nn=0; while ! grep -q '"ctx"' "${runningPath}" 2>/dev/null && [ $n -lt 100 ]; do sleep 0.05; n=$((n+1)); done\nsleep 0.3\nprintf '%s\\n' '${RESULT_LINE}'\nprintf '%s' '{"outcome":"advance"}' > "$AGENTHOOK_VERDICT_FILE"\n`,
    { mode: 0o755 },
  );
  const cfg = /** @type {any} */ ({
    pipeline: [{ id: "code", model: "claude-haiku-4-5" }, { id: "done", manual: true }],
    claudeBin: bin,
    repoPath: dir,
    dataDir: dir,
    logDir: dir,
    instructionsFile: path.join(dir, "none.md"),
  });
  const adapter = /** @type {any} */ ({
    describe: () => ({ platform: "GitHub", taskNoun: "issue", trigger: "@agent", commentHowTo: "comment" }),
    fetchTask: async (/** @type {string} */ ref) => ({ ref, name: "t", description: "d", url: "u", completed: false, assignedToUs: true }),
    advance: async () => {},
  });
  const run = createDispatcher(cfg, adapter, undefined, createStore(dir), () => {});
  const log = console.log;
  const warn = console.warn;
  const warnings = [];
  console.log = () => {};
  console.warn = (/** @type {any} */ m) => warnings.push(String(m));
  try {
    await run({ kind: "pipeline", ref: "42", stepId: "code", dedupKey: "k" });
  } finally {
    console.log = log;
    console.warn = warn;
  }
  assert.equal(warnings.length, 1, "exactly one console.warn for the run");
  assert.match(warnings[0], /claude-haiku-4-5/);
  assert.match(warnings[0], /212,000/);
  assert.match(warnings[0], /200,000/);
  const logFile = fs.readdirSync(dir).find((f) => f.endsWith("-step-code-42.log"));
  assert.ok(logFile, "run log exists");
  const logLines = fs.readFileSync(path.join(dir, logFile), "utf8").split("\n");
  assert.equal(logLines.filter((l) => l.includes("context window for model")).length, 1, "one warning line in the run log");
});

// --- quota (#397): a Claude run's rate_limit_event reaches opts.onQuota; other agents never do ---

test("onQuota: a claude run's rate_limit_event reaches the hook stamped with asOf; a non-claude agent's never does", async () => {
  const fixture = path.join(path.dirname(new URL(import.meta.url).pathname), "fixtures", "claude-rate-limit-event.jsonl");
  /** @param {string} agent */
  const runWith = async (agent) => {
    const dir = tmpDir();
    const bin = path.join(dir, "fake-agent.sh");
    fs.writeFileSync(bin, `#!/bin/sh\ncat "${fixture}"\nprintf '%s' '{"outcome":"advance"}' > "$AGENTHOOK_VERDICT_FILE"\n`, { mode: 0o755 });
    const cfg = /** @type {any} */ ({
      pipeline: [{ id: "code", agent, bin }, { id: "done", manual: true }],
      claudeBin: bin,
      repoPath: dir,
      worktreePrefix: path.join(dir, "wt"),
      dataDir: dir,
      logDir: dir,
      instructionsFile: path.join(dir, "none.md"),
    });
    const adapter = /** @type {any} */ ({
      describe: () => ({ platform: "GitHub", taskNoun: "issue", trigger: "@agent", commentHowTo: "comment" }),
      fetchTask: async (/** @type {string} */ ref) => ({ ref, name: "t", description: "d", url: "u", completed: false, assignedToUs: true }),
      advance: async () => {},
    });
    /** @type {any[]} */
    const seen = [];
    const run = createDispatcher(cfg, adapter, undefined, createStore(dir), () => {}, null, undefined, { onQuota: (q) => seen.push(q) });
    const log = console.log;
    console.log = () => {};
    try {
      await run({ kind: "pipeline", ref: "7", stepId: "code", dedupKey: "k" });
    } finally {
      console.log = log;
    }
    return seen;
  };
  const before = Date.now();
  const got = await runWith("claude");
  assert.equal(got.length, 1);
  const { asOf, ...q } = got[0];
  assert.deepEqual(q, { fiveHour: { utilization: 0.08, resetsAt: "2026-10-18T18:10:00.000Z" }, sevenDay: { utilization: 0.66, resetsAt: "2026-10-18T21:00:00.000Z" } });
  assert.ok(Date.parse(asOf) >= before - 1000);
  assert.deepEqual(await runWith("cursor"), []);
});

