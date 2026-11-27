import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// Pure-unit tests for runUsageRecord/addTurns (src/dispatch/usage.js): the run's usage+cost
// record, summed across the first turn and every verdict-repair (#677) / gate-repair (#710) turn.
import test from "node:test";
import assert from "node:assert/strict";
import { runUsageRecord } from "../src/dispatch/usage.js";

const META = { ref: "1", stepId: "code", model: "claude-sonnet-4-6", bin: undefined, claudeBin: undefined, startedAt: "2026-07-01T10:00:00.000Z", endedAt: "2026-07-01T10:05:00.000Z" };

/** A stub agent: usageRecord reads a plain result shape, describe names it "stub". */
function stubAgent() {
  return {
    usageRecord: (result, meta) => ({
      ref: meta.ref,
      stepId: meta.stepId,
      model: meta.model,
      startedAt: meta.startedAt,
      endedAt: meta.endedAt,
      input: result?.input ?? 0,
      output: result?.output ?? 0,
      cacheRead: 0,
      cacheCreate: 0,
      ...(result?.durationMs !== undefined ? { durationMs: result.durationMs } : {}),
      ...(result?.costUsd !== undefined ? { costUsd: result.costUsd } : {}),
      ...(result?.sessionId !== undefined ? { sessionId: result.sessionId } : {}),
    }),
    describe: () => ({ name: "stub" }),
  };
}

const CFG = { pricing: null, harnesses: {}, energy: null };

function base(o = {}) {
  return { agent: stubAgent(), result: { input: 100, output: 50, costUsd: 0.01, sessionId: "s0" }, meta: META, finalized: null, model: META.model, turnStats: undefined, repair: undefined, gate: undefined, harness: {}, remoteCwd: undefined, energy: null, cfg: CFG, ...o };
}

test("(a) no extra turns: the base record alone, priced from costUsd", () => {
  const usage = runUsageRecord(base());
  assert.equal(usage.input, 100);
  assert.equal(usage.output, 50);
  assert.equal(usage.costUsd, 0.01);
  assert.equal(usage.sessionId, "s0");
  assert.equal(usage.costBasis, "reported");
});

const REPAIR = {
  results: [{ result: { input: 10, output: 5, costUsd: 0.001, durationMs: 100, sessionId: "s1" } }, { result: { input: 20, output: 7, costUsd: 0.002, durationMs: 200, sessionId: "s2" } }],
  turnStats: [{ turns: 1, peakContext: 500, lastContext: 400, compactions: 1 }, { turns: 1, peakContext: 900, lastContext: 800, compactions: 0 }],
};

const GATE = {
  results: [{ result: { input: 1, output: 1, costUsd: 0.0005, durationMs: 50, sessionId: "g1" } }],
  turnStats: [{ turns: 1, peakContext: 300, lastContext: 250, compactions: 2 }],
};

test("(b) repair turns only: tokens/cost/duration sum, peakContext max, lastContext+sessionId from the final turn", () => {
  const usage = runUsageRecord(base({ repair: REPAIR }));
  assert.equal(usage.input, 130); // 100 + 10 + 20
  assert.equal(usage.output, 62); // 50 + 5 + 7
  assert.ok(Math.abs(usage.costUsd - 0.013) < 1e-9); // 0.01 + 0.001 + 0.002
  assert.equal(usage.sessionId, "s2", "last repair result's sessionId wins");
  assert.equal(usage.turns, 2);
  assert.equal(usage.peakContext, 900);
  assert.equal(usage.lastContext, 800, "last repair turnStats' lastContext wins");
  assert.equal(usage.compactions, 1); // 1 + 0
});

test("(c) gate turns only: same summation shape as repair", () => {
  const usage = runUsageRecord(base({ gate: GATE }));
  assert.equal(usage.input, 101);
  assert.equal(usage.output, 51);
  assert.ok(Math.abs(usage.costUsd - 0.0105) < 1e-9);
  assert.equal(usage.sessionId, "g1");
  assert.equal(usage.turns, 1);
  assert.equal(usage.peakContext, 300);
  assert.equal(usage.lastContext, 250);
  assert.equal(usage.compactions, 2);
});

test("(d) both repair and gate turns: repair applied before gate, gate's final turn wins", () => {
  const usage = runUsageRecord(base({ repair: REPAIR, gate: GATE }));
  assert.equal(usage.input, 131); // 100 + 10 + 20 + 1
  assert.equal(usage.output, 63); // 50 + 5 + 7 + 1
  assert.ok(Math.abs(usage.costUsd - 0.0135) < 1e-9);
  assert.equal(usage.sessionId, "g1", "gate ran after repair, so its last result's sessionId wins");
  assert.equal(usage.turns, 3);
  assert.equal(usage.peakContext, 900, "max across repair and gate turns");
  assert.equal(usage.lastContext, 250, "gate's last turnStats wins over repair's");
  assert.equal(usage.compactions, 3); // 1 (repair) + 2 (gate)
});

test("a turnStats entry is ignored when results is empty", () => {
  const usage = runUsageRecord(base({ repair: { results: [], turnStats: [{ turns: 5, peakContext: 9999 }] } }));
  assert.equal("turns" in usage, false);
  assert.equal("peakContext" in usage, false);
  assert.equal(usage.input, 100, "no repair results → base record only");
});

test("durationMs fallback: adapters with no duration_ms derive it from startedAt/endedAt", () => {
  const usage = runUsageRecord(base());
  assert.equal(usage.durationMs, 5 * 60 * 1000); // 10:00:00 → 10:05:00
});

test("durationMs: an adapter-reported value is kept, not overwritten by the fallback", () => {
  const agent = stubAgent();
  const usage = runUsageRecord(base({ agent, result: { input: 1, output: 1, costUsd: 0, durationMs: 42, sessionId: "s" } }));
  assert.equal(usage.durationMs, 42);
});

test("finalized overlay: finite non-negative token fields overlay, negative/non-finite/non-number are left alone", () => {
  const usage = runUsageRecord(base({ finalized: { input: 7, output: -1, cacheRead: Infinity, cacheCreate: "bad" } }));
  assert.equal(usage.input, 7, "finite ≥0 overlays");
  assert.equal(usage.output, 50, "negative is not overlaid, base value kept");
  assert.equal(usage.cacheRead, 0, "non-finite is not overlaid");
  assert.equal(usage.cacheCreate, 0, "non-number is not overlaid");
});

test("finalized model overlay only applies when the step resolved no model of its own", () => {
  const withModel = runUsageRecord(base({ model: "claude-sonnet-4-6", finalized: { model: "hermes" } }));
  assert.equal(withModel.model, "claude-sonnet-4-6", "step already resolved a model: finalized model is not overlaid");

  const noModel = runUsageRecord(base({ model: undefined, meta: { ...META, model: undefined }, finalized: { model: "hermes" } }));
  assert.equal(noModel.model, "hermes", "no step model: the finalized (adapter) model is overlaid");
});
