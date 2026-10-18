import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// Pure-unit tests for usage aggregation helpers (no I/O, no network).
import test from "node:test";
import assert from "node:assert/strict";
import { sumRecords, groupBy, utcDay, isoWeek, modelSplit, runCost, spendCell, energyTotalLine } from "../src/commands/usage.js";

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

test("sumRecords: tokens sum every record, costUsd only priced + old (no-field) ones", () => {
  const recs = [rec({ costUsd: 0.25 }), rec({ costUsd: 9, unpriced: true }), rec({ costUsd: 0.5, unpriced: undefined })];
  const t = sumRecords(recs);
  assert.equal(t.input, 300);
  assert.equal(t.output, 600);
  assert.ok(Math.abs(t.costUsd - 0.75) < 1e-9);
  assert.equal(sumRecords([rec({ unpriced: true }), rec({ unpriced: true })]).costUsd, undefined, "all unpriced → no cost");
});

test("runCost: reported dollars, else a rate-table estimate, else unpriced", () => {
  assert.equal(runCost(rec({ costUsd: 0.01 })), "$0.0100");
  // claude-sonnet-4-6: 100×3 + 200×15 + 50×0.3 + 25×3.75 = 3408.75 µ$
  assert.equal(runCost(rec({ costUsd: 9, unpriced: true })), "~$0.0034 est.", "the raw unpriced figure is never shown");
  assert.equal(runCost(rec({ model: "qwen3.8", costUsd: 9, unpriced: true })), "unpriced", "no rate → no estimate");
  assert.equal(runCost(rec({ model: "qwen3.8", costUsd: 9, unpriced: true }), { "qwen*": { input: 1, output: 1 } }), "~$0.0003 est.");
  assert.equal(runCost(rec({ model: "mystery", costUsd: undefined })), "—");
  assert.equal(runCost(rec({ costUsd: 9, unpriced: true, estUsd: 0.5 })), "~$0.5000 est.", "a stamped estimate is used as-is");
});

test("sumRecords + spendCell: reported and estimated stay apart; runs with neither are counted", () => {
  const recs = [rec({ costUsd: 0.25 }), rec({ unpriced: true, estUsd: 0.1 }), rec({ model: "local", unpriced: true }), rec({ model: "local", unpriced: true, input: 0, output: 0, cacheRead: 0, cacheCreate: 0 })];
  const t = sumRecords(recs);
  assert.equal(t.costUsd, 0.25);
  assert.ok(Math.abs(t.est - 0.1) < 1e-9);
  assert.equal(t.unestimated, 2);
  assert.equal(spendCell(t), "$0.2500 + ~$0.1000 est.");
  assert.equal(spendCell({ costUsd: 0.25, est: 0 }), "$0.2500");
  assert.equal(spendCell({ costUsd: undefined, est: 0.1 }), "~$0.1000 est.");
  assert.equal(spendCell({ costUsd: undefined, est: 0 }), "—");
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

test("runCost / sumRecords / energyTotalLine: measured energy sits beside the dollar figures, never in them", () => {
  const measured = rec({ costUsd: 0.01, energyKwh: 0.0019, energyUsd: 0.00029, energySource: "hwmon" });
  assert.equal(runCost(measured), "$0.0100 · energy $0.00029 (1.9 Wh)");
  assert.equal(runCost(rec({ costUsd: 0.01 })), "$0.0100", "an unmeasured run shows no energy");
  const t = sumRecords([measured, rec({ costUsd: 0.02 }), rec({ energyKwh: 0.001, energyUsd: 0.00015 })]);
  assert.equal(t.energyRuns, 2);
  assert.ok(Math.abs(t.energyKwh - 0.0029) < 1e-12);
  assert.ok(Math.abs(/** @type {number} */ (t.costUsd) - 0.04) < 1e-12, "energy dollars are not added to costUsd");
  assert.equal(energyTotalLine(t), "energy total: $0.00044 (2.9 Wh) over 2 measured runs");
  assert.equal(energyTotalLine(sumRecords([rec()])), "", "no measured run → no line");
});
