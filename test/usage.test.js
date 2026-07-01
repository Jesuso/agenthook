// Pure-unit tests for usage aggregation helpers (no I/O, no network).
import test from "node:test";
import assert from "node:assert/strict";
import { sumRecords, groupBy, utcDay, isoWeek, modelSplit } from "../src/commands/usage.js";

/** @type {() => import('../src/types.js').UsageRecord} */
function rec(overrides = {}) {
  return {
    ref: "1",
    stepId: "code",
    model: "claude-sonnet-4-6",
    startedAt: "2026-07-01T10:00:00.000Z",
    endedAt: "2026-07-01T10:05:00.000Z",
    input: 100,
    output: 200,
    cacheRead: 50,
    cacheCreate: 25,
    costUsd: 0.01,
    ...overrides,
  };
}

test("sumRecords totals tokens and cost", () => {
  const recs = [rec({ input: 100, output: 200, cacheRead: 10, cacheCreate: 5, costUsd: 0.01 }), rec({ input: 300, output: 400, cacheRead: 20, cacheCreate: 15, costUsd: 0.02 })];
  const t = sumRecords(recs);
  assert.equal(t.input, 400);
  assert.equal(t.output, 600);
  assert.equal(t.cacheRead, 30);
  assert.equal(t.cacheCreate, 20);
  assert.ok(Math.abs(t.costUsd - 0.03) < 1e-9);
});

test("sumRecords tolerates missing costUsd", () => {
  const recs = [rec({ costUsd: undefined }), rec({ costUsd: 0.05 })];
  const t = sumRecords(recs);
  assert.ok(Math.abs(t.costUsd - 0.05) < 1e-9);
});

test("sumRecords all missing costUsd → undefined", () => {
  const recs = [rec({ costUsd: undefined }), rec({ costUsd: undefined })];
  const t = sumRecords(recs);
  assert.equal(t.costUsd, undefined);
});

test("groupBy groups records by key", () => {
  const recs = [rec({ ref: "1" }), rec({ ref: "2" }), rec({ ref: "1" })];
  const groups = groupBy(recs, (r) => r.ref);
  assert.equal(groups.get("1").length, 2);
  assert.equal(groups.get("2").length, 1);
});

test("utcDay extracts calendar date", () => {
  assert.equal(utcDay("2026-07-01T23:59:59.999Z"), "2026-07-01");
  assert.equal(utcDay("2026-12-31T00:00:00.000Z"), "2026-12-31");
});

test("isoWeek returns correct ISO week", () => {
  // 2026-07-01 is Wednesday of week 27
  assert.equal(isoWeek("2026-07-01T10:00:00.000Z"), "2026-W27");
  // 2026-01-01 is Thursday — ISO week 1 of 2026
  assert.equal(isoWeek("2026-01-01T00:00:00.000Z"), "2026-W01");
});

test("isoWeek groups records spanning two days in same week", () => {
  const recs = [rec({ startedAt: "2026-06-29T08:00:00.000Z" }), rec({ startedAt: "2026-07-01T10:00:00.000Z" })];
  const groups = groupBy(recs, (r) => isoWeek(r.startedAt));
  assert.equal(groups.size, 1, "both days should be in W27");
});

test("isoWeek separates records in different weeks", () => {
  const recs = [rec({ startedAt: "2026-07-01T00:00:00.000Z" }), rec({ startedAt: "2026-07-06T00:00:00.000Z" })];
  const groups = groupBy(recs, (r) => isoWeek(r.startedAt));
  assert.equal(groups.size, 2);
});

test("modelSplit counts tokens per model", () => {
  const recs = [rec({ model: "a", input: 100, output: 200, cacheRead: 0, cacheCreate: 0 }), rec({ model: "b", input: 50, output: 50, cacheRead: 0, cacheCreate: 0 }), rec({ model: "a", input: 10, output: 10, cacheRead: 0, cacheCreate: 0 })];
  const s = modelSplit(recs);
  assert.ok(s.includes("a:320"), `expected a:320 in "${s}"`);
  assert.ok(s.includes("b:100"), `expected b:100 in "${s}"`);
});

test("modelSplit falls back to 'unknown' for missing model", () => {
  const recs = [rec({ model: undefined, input: 10, output: 10, cacheRead: 0, cacheCreate: 0 })];
  const s = modelSplit(recs);
  assert.ok(s.includes("unknown:20"));
});
