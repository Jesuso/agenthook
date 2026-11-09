import "./_setup.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { runStats } from "../src/stats.js";

const NOW = Date.parse("2026-11-08T12:00:00Z");

/** @param {string} ts @param {Record<string, any>} [x] */
const runEnd = (ts, x = {}) => ({ ts, event: "run_end", ref: x.ref ?? "1", step: x.step ?? "code", outcome: x.outcome ?? "advance", ...x });
/** @param {string} ts @param {Record<string, any>} [x] */
const failed = (ts, x = {}) => ({ ts, event: "failed", ref: x.ref ?? "1", step: x.step ?? "code", reason: x.reason ?? "timeout: exceeded maxMinutes=30", ...x });
/** @param {Record<string, any>} [x] */
const usage = (x = {}) => ({ ref: "1", stepId: "code", startedAt: "2026-11-08T11:58:00Z", endedAt: "2026-11-08T12:00:00Z", input: 100, output: 50, cacheRead: 0, cacheCreate: 0, ...x });

test("groups by harness, model, step, agent", () => {
  const u = [usage({ harness: "fast", model: "claude-sonnet-5", agent: "claude" })];
  const e = [runEnd("2026-11-08T12:00:00Z", { harness: "fast", model: "claude-sonnet-5" })];
  assert.equal(runStats(u, e, { by: "harness", now: NOW }).groups[0].key, "fast");
  assert.equal(runStats(u, e, { by: "model", now: NOW }).groups[0].key, "claude-sonnet-5");
  assert.equal(runStats(u, e, { by: "step", now: NOW }).groups[0].key, "code");
  assert.equal(runStats(u, e, { by: "agent", now: NOW }).groups[0].key, "claude");
});

test("a profile without harnesses gives a single (none) group", () => {
  const u = [usage()];
  const e = [runEnd("2026-11-08T12:00:00Z")];
  const r = runStats(u, e, { by: "harness", now: NOW });
  assert.equal(r.groups.length, 1);
  assert.equal(r.groups[0].key, "(none)");
});

test("agent falls back to the step's configured agent, then defaultAgent, then (unknown)", () => {
  const u = [usage()];
  const e = [runEnd("2026-11-08T12:00:00Z")];
  const r1 = runStats(u, e, { by: "agent", now: NOW, steps: [{ id: "code", agent: "cursor" }] });
  assert.equal(r1.groups[0].key, "cursor");
  const r2 = runStats(u, e, { by: "agent", now: NOW, defaultAgent: "opencode" });
  assert.equal(r2.groups[0].key, "opencode");
  const r3 = runStats(u, e, { by: "agent", now: NOW, defaultAgent: null });
  assert.equal(r3.groups[0].key, "(unknown)");
});

test("usage.agent wins over the step's configured agent and defaultAgent", () => {
  const u = [usage({ agent: "cursor" })];
  const e = [runEnd("2026-11-08T12:00:00Z")];
  const r = runStats(u, e, { by: "agent", now: NOW, steps: [{ id: "code", agent: "hermes" }], defaultAgent: "opencode" });
  assert.equal(r.groups[0].key, "cursor");
});

test("success rate excludes requeued from the denominator", () => {
  const e = [
    runEnd("2026-11-08T11:00:00Z", { outcome: "advance" }),
    runEnd("2026-11-08T11:05:00Z", { outcome: "fail" }),
    runEnd("2026-11-08T11:10:00Z", { outcome: "requeued", harness: "fast" }),
  ];
  const r = runStats([], e, { by: "step", now: NOW });
  const g = r.groups[0];
  assert.equal(g.runs, 3);
  assert.equal(g.outcomes.requeued, 1);
  assert.equal(g.successRate, 0.5); // 1 advance / (3 - 1 requeued)
});

test("success rate is null when the denominator is 0", () => {
  const e = [runEnd("2026-11-08T11:00:00Z", { outcome: "requeued", harness: "fast" })];
  const r = runStats([], e, { by: "step", now: NOW });
  assert.equal(r.groups[0].successRate, null);
});

test("a run_end with no usage row still counts (outcome yes, wall no)", () => {
  const e = [runEnd("2026-11-08T11:00:00Z", { outcome: "fail" })];
  const r = runStats([], e, { by: "step", now: NOW });
  assert.equal(r.groups[0].runs, 1);
  assert.equal(r.groups[0].outcomes.fail, 1);
  assert.equal(r.groups[0].wallP50Ms, null);
  assert.equal(r.groups[0].wallP90Ms, null);
});

test("a usage row with no run_end counts as unknown", () => {
  const u = [usage()];
  const r = runStats(u, [], { by: "step", now: NOW });
  assert.equal(r.groups[0].runs, 1);
  assert.equal(r.groups[0].outcomes.unknown, 1);
  assert.ok(typeof r.groups[0].wallP50Ms === "number");
});

test("nearest-within-5s join; each usage row consumed at most once", () => {
  const u = [usage({ endedAt: "2026-11-08T12:00:00.500Z" }), usage({ endedAt: "2026-11-08T12:00:08Z" })];
  const e = [runEnd("2026-11-08T12:00:00Z", { outcome: "advance" }), runEnd("2026-11-08T12:00:09Z", { outcome: "advance" })];
  const r = runStats(u, e, { by: "step", now: NOW });
  // Both run_ends matched a usage row (gaps 0.5s and 1s, both <= 5s); nothing left unmatched.
  assert.equal(r.groups[0].runs, 2);
  assert.equal(r.groups[0].outcomes.unknown, 0);
  assert.equal(r.groups[0].outcomes.advance, 2);
});

test("two run_ends within 5s of the same usage row: only the nearer one claims it", () => {
  // A single usage row at T; run_ends at T+1s and T+2s both sit within JOIN_MS of it.
  // Correct: the nearer run_end (gap 1s) claims it; the other gets no usage row (output 0),
  // so the group's total output is 999 once, not 1998 (double-matched) nor 0 (unmatched).
  const u = [usage({ ref: "a", endedAt: "2026-11-08T12:00:00Z", output: 999 })];
  const e = [
    runEnd("2026-11-08T12:00:01Z", { ref: "a", outcome: "advance" }),
    runEnd("2026-11-08T12:00:02Z", { ref: "a", outcome: "advance" }),
  ];
  const r = runStats(u, e, { by: "step", now: NOW });
  assert.equal(r.groups[0].runs, 2);
  assert.equal(r.groups[0].outcomes.advance, 2);
  assert.equal(r.groups[0].outcomes.unknown, 0);
  assert.equal(r.groups[0].output, 999);
});

test("one run_end with two candidate usage rows: nearer gap wins, not iteration order", () => {
  // Usage row A (gap 4s) is pushed first, usage row B (gap 1s) second — so "first row within
  // the window" would wrongly pick A. The run_end must match B (nearest); A is left unmatched
  // and counted as its own `unknown` run. Distinct `model` values on A/B let us tell which one
  // the run_end actually joined to, since both runs otherwise land in the same `step` group.
  const u = [
    usage({ endedAt: "2026-11-08T12:00:04Z", model: "model-a" }),
    usage({ endedAt: "2026-11-08T12:00:01Z", model: "model-b" }),
  ];
  const e = [runEnd("2026-11-08T12:00:00Z", { outcome: "advance" })];
  const r = runStats(u, e, { by: "model", now: NOW });
  const byKey = Object.fromEntries(r.groups.map((g) => [g.key, g]));
  assert.equal(byKey["model-b"]?.outcomes.advance, 1, "the nearer row (gap 1s) must be the one the run_end joins to");
  assert.equal(byKey["model-a"]?.outcomes.unknown, 1, "the farther row (gap 4s) is left unmatched");
});

test("fail + a following timeout: reason counts as timeout, not fail", () => {
  const e = [runEnd("2026-11-08T11:00:00Z", { outcome: "fail" }), failed("2026-11-08T11:00:02Z")];
  const r = runStats([], e, { by: "step", now: NOW });
  assert.equal(r.groups[0].outcomes.fail, 0);
  assert.equal(r.groups[0].outcomes.timeout, 1);
});

test("a plain fail (no following timeout reason) stays fail", () => {
  const e = [runEnd("2026-11-08T11:00:00Z", { outcome: "fail" }), failed("2026-11-08T11:00:02Z", { reason: "spawn failed: ENOENT" })];
  const r = runStats([], e, { by: "step", now: NOW });
  assert.equal(r.groups[0].outcomes.fail, 1);
  assert.equal(r.groups[0].outcomes.timeout, 0);
});

test("p50/p90 wall time", () => {
  const u = [10_000, 20_000, 30_000, 40_000].map((ms, i) =>
    usage({ ref: String(i), startedAt: "2026-11-08T12:00:00Z", endedAt: new Date(Date.parse("2026-11-08T12:00:00Z") + ms).toISOString() }),
  );
  const e = u.map((rec, i) => runEnd(rec.endedAt, { ref: String(i), outcome: "advance" }));
  const r = runStats(u, e, { by: "step", now: NOW });
  assert.equal(r.groups[0].wallP50Ms, 25_000);
  assert.equal(r.groups[0].wallP90Ms, 37_000);
});

test("missing turns/context give null means", () => {
  const u = [usage({ turns: 3, firstContext: 100, peakContext: 200 }), usage({ ref: "2" })];
  const e = [runEnd("2026-11-08T12:00:00Z"), runEnd("2026-11-08T12:00:00Z", { ref: "2" })];
  const r = runStats(u, e, { by: "step", now: NOW });
  assert.equal(r.groups[0].turns, 3);
  assert.equal(r.groups[0].firstContext, 100);
  assert.equal(r.groups[0].peakContext, 200);
  const r2 = runStats([usage({ ref: "3" })], [runEnd("2026-11-08T12:00:00Z", { ref: "3" })], { by: "step", now: NOW });
  assert.equal(r2.groups[0].turns, null);
  assert.equal(r2.groups[0].firstContext, null);
  assert.equal(r2.groups[0].peakContext, null);
});

test("compactions (#657): group mean ignores runs without the field, null when none have it", () => {
  const u = [usage({ turns: 2, compactions: 2 }), usage({ ref: "2", turns: 1, compactions: 0 }), usage({ ref: "3" })];
  const e = [runEnd("2026-11-08T12:00:00Z"), runEnd("2026-11-08T12:00:00Z", { ref: "2" }), runEnd("2026-11-08T12:00:00Z", { ref: "3" })];
  const r = runStats(u, e, { by: "step", now: NOW });
  assert.equal(r.groups[0].compactions, 1); // mean of 2 and 0, the ref-3 run (no field) excluded

  const r2 = runStats([usage({ ref: "4" })], [runEnd("2026-11-08T12:00:00Z", { ref: "4" })], { by: "step", now: NOW });
  assert.equal(r2.groups[0].compactions, null);
});

test("outPerMin only counts runs that have a wall time", () => {
  // Run A: output 60 over 1 minute wall -> outPerMin would be 60 if computed alone.
  // Run B: no usage row (no wall), but its own `output` on the run_end is large (1000) — it
  // must not inflate outPerMin's numerator or be treated as having a wall-minute denominator.
  const u = [usage({ output: 60, startedAt: "2026-11-08T12:00:00Z", endedAt: "2026-11-08T12:01:00Z" })];
  const e = [runEnd("2026-11-08T12:01:00Z", { outcome: "advance" }), runEnd("2026-11-08T12:00:00Z", { ref: "2", outcome: "fail", output: 1000 })];
  const r = runStats(u, e, { by: "step", now: NOW });
  assert.equal(r.groups[0].outPerMin, 60);
});

test("unpriced count excludes those runs from costUsd", () => {
  const u = [usage({ costUsd: 0.5 }), usage({ ref: "2", costUsd: 0.1, unpriced: true })];
  const e = [runEnd("2026-11-08T12:00:00Z"), runEnd("2026-11-08T12:00:00Z", { ref: "2" })];
  const r = runStats(u, e, { by: "step", now: NOW });
  assert.equal(r.groups[0].costUsd, 0.5);
  assert.equal(r.groups[0].unpriced, 1);
});

test("--since filters on run end time", () => {
  const e = [runEnd("2026-11-01T12:00:00Z", { ref: "old" }), runEnd("2026-11-08T11:00:00Z", { ref: "new" })];
  const r = runStats([], e, { by: "step", now: NOW, sinceMs: 24 * 3600 * 1000 });
  assert.equal(r.groups[0].runs, 1);
  const all = runStats([], e, { by: "step", now: NOW, sinceMs: null });
  assert.equal(all.groups[0].runs, 2);
});

test("--step and --harness filters", () => {
  const e = [runEnd("2026-11-08T11:00:00Z", { step: "code", harness: "fast" }), runEnd("2026-11-08T11:00:00Z", { step: "review", harness: "slow" })];
  const byStep = runStats([], e, { by: "harness", now: NOW, step: "code" });
  assert.equal(byStep.groups.length, 1);
  assert.equal(byStep.groups[0].key, "fast");
  const byHarness = runStats([], e, { by: "step", now: NOW, harness: "slow" });
  assert.equal(byHarness.groups.length, 1);
  assert.equal(byHarness.groups[0].key, "review");
});

test("groups sorted by runs desc", () => {
  const e = [
    runEnd("2026-11-08T11:00:00Z", { step: "a" }),
    runEnd("2026-11-08T11:00:00Z", { step: "b" }),
    runEnd("2026-11-08T11:01:00Z", { step: "b" }),
  ];
  const r = runStats([], e, { by: "step", now: NOW });
  assert.deepEqual(r.groups.map((g) => g.key), ["b", "a"]);
});
