import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
import { test } from "node:test";
import assert from "node:assert/strict";
import { harnessTotals } from "../src/harness-usage.js";

test("harnessTotals: sums runs + tokens per harness, skips records without one", () => {
  const recs = [
    { ref: "1", stepId: "code", harness: "qwen", input: 10, output: 5, cacheRead: 100, cacheCreate: 1 },
    { ref: "2", stepId: "code", harness: "qwen", input: 1, output: 2, cacheRead: 3, cacheCreate: 4 },
    { ref: "3", stepId: "review", harness: "opus", input: 7, output: 8, cacheRead: 0, cacheCreate: 0 },
    { ref: "4", stepId: "triage", input: 999, output: 999, cacheRead: 999, cacheCreate: 999 },
    { ref: "5", stepId: "triage", harness: null, input: 1, output: 1, cacheRead: 1, cacheCreate: 1 },
    { ref: "6", stepId: "triage", harness: "", input: 1, output: 1, cacheRead: 1, cacheCreate: 1 },
  ];
  assert.deepEqual(harnessTotals(recs), {
    qwen: { runs: 2, input: 11, output: 7, cacheRead: 103, cacheCreate: 5 },
    opus: { runs: 1, input: 7, output: 8, cacheRead: 0, cacheCreate: 0 },
  });
});

test("harnessTotals: null when no record names a harness; bad token values count as 0", () => {
  assert.equal(harnessTotals([]), null);
  assert.equal(harnessTotals([{ input: 1, output: 1, cacheRead: 0, cacheCreate: 0 }]), null);
  // a run_end without a result carries no tokens at all — it still counts as a run
  assert.deepEqual(harnessTotals([{ harness: "a", input: "x", output: -1, cacheRead: NaN }]), { a: { runs: 1, input: 0, output: 0, cacheRead: 0, cacheCreate: 0 } });
});
