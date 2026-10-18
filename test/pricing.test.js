// src/pricing.js — rate matching, the costOf basis rule, sums, formatting and config validation.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DEFAULT_RATES, costOf, estimate, formatSpend, matchRate, pricingErrors, pricingOf, sumCosts } from "../src/pricing.js";

test("pricing.js is import-free (the browser may bundle it)", () => {
  const src = fs.readFileSync(new URL("../src/pricing.js", import.meta.url), "utf8");
  assert.doesNotMatch(src, /^\s*import\s/m);
});

test("matchRate: exact beats glob, longer glob beats shorter, case-insensitive", () => {
  const o = { "qwen*": { input: 1, output: 1 }, "qwen3*": { input: 2, output: 2 }, "qwen3.8": { input: 3, output: 3 } };
  assert.equal(matchRate("qwen3.8", o)?.input, 3);
  assert.equal(matchRate("QWEN3.9", o)?.input, 2);
  assert.equal(matchRate("qwen2", o)?.input, 1);
  assert.equal(matchRate("claude-opus-5-5", null)?.input, 4, "claude-opus-5-5* beats claude-opus-5*");
  assert.equal(matchRate("claude-opus-5", null)?.input, 5);
  assert.equal(matchRate("claude-fable-5-1", null)?.cacheRead, 0.25);
  assert.equal(matchRate("claude-fable-5", null)?.cacheRead, 1);
});

test("matchRate: overrides before defaults; provider/model suffix; unknown or no model → null", () => {
  assert.equal(matchRate("claude-sonnet-5-5", { "claude-sonnet-5-5": { input: 9, output: 9 } })?.input, 9);
  assert.equal(matchRate("anthropic/claude-sonnet-5-5")?.input, 2, "OpenCode provider/model");
  assert.equal(matchRate("ollama/qwen3.8", { "qwen3.8*": { input: 2, output: 10 } })?.output, 10);
  assert.equal(matchRate("ollama/qwen3.8", { "ollama/*": { input: 7, output: 7 } })?.input, 7, "the full string is tried first");
  assert.equal(matchRate("auto"), null);
  assert.equal(matchRate("gpt-9"), null, "no non-Claude defaults");
  assert.equal(matchRate(undefined), null);
  assert.equal(matchRate(""), null);
});

test("DEFAULT_RATES: Claude family only, every rate complete", () => {
  for (const [k, r] of Object.entries(DEFAULT_RATES)) {
    assert.match(k, /^claude-/);
    assert.deepEqual(pricingErrors({ [k]: r }), []);
  }
});

test("estimate: token math, cache defaults; null on no match or zero tokens", () => {
  // sonnet-5-5: 1M input × 2 + 1M output × 10 + 1M cacheRead × 0.2 + 1M cacheCreate × 2.5
  assert.deepEqual(estimate({ model: "claude-sonnet-5-5", input: 1e6, output: 1e6, cacheRead: 1e6, cacheCreate: 1e6 }), { estUsd: 14.7, basis: "rate-table" });
  // An override without cache rates: 0.1× / 1.25× input.
  assert.equal(estimate({ model: "q", input: 0, output: 0, cacheRead: 1e6, cacheCreate: 1e6 }, { q: { input: 10, output: 0 } })?.estUsd, 13.5);
  assert.equal(estimate({ model: "mystery", input: 5, output: 5 }), null);
  assert.equal(estimate({ model: "claude-opus-5-5", input: 0, output: 0, cacheRead: 0, cacheCreate: 0 }), null, "Hermes' zero-token record: no estimate, not $0");
});

test("costOf: the basis rule", () => {
  const tokens = { model: "claude-opus-5-5", input: 1e6, output: 0, cacheRead: 0, cacheCreate: 0 };
  assert.deepEqual(costOf({ ...tokens, costUsd: 1.5 }), { costUsd: 1.5, costBasis: "reported" }, "reported Claude: no estUsd");
  assert.deepEqual(costOf({ ...tokens, costUsd: 99, unpriced: true }), { estUsd: 4, costBasis: "rate-table" }, "unpriced: raw costUsd never reported");
  assert.deepEqual(costOf({ ...tokens, model: "local", costUsd: 99, unpriced: true }), {}, "unpriced + no rate → no estimate");
  assert.deepEqual(costOf({ ...tokens, unpriced: true, estUsd: 0.25 }), { estUsd: 0.25, costBasis: "rate-table" }, "a stored estimate is never re-priced");
  assert.deepEqual(costOf({ ...tokens, unpriced: true }, { "claude-opus-5-5": { input: 1, output: 1 } }), { estUsd: 1, costBasis: "rate-table" });
  assert.deepEqual(costOf({ outcome: "fail" }), {}, "a run_end with no result");
});

test("sumCosts + formatSpend: reported and estimated never blended", () => {
  const s = sumCosts([{ costUsd: 12.4 }, { unpriced: true, estUsd: 3.1 }, { unpriced: true, model: "x", input: 5 }, {}]);
  assert.deepEqual(s, { reported: 12.4, est: 3.1, unestimated: 2 });
  assert.equal(formatSpend(s), "$12.40 + ~$3.10 est.");
  assert.equal(formatSpend({ reported: 0, est: 3.1 }), "~$3.10 est.");
  assert.equal(formatSpend({ reported: 12.4, est: 0 }), "$12.40");
  assert.equal(formatSpend({ reported: 0, est: 0 }), "");
});

test("pricingErrors: shape, required keys, finite ≥ 0, unknown keys", () => {
  assert.deepEqual(pricingErrors(undefined), []);
  assert.deepEqual(pricingErrors({ "qwen*": { input: 0.5, output: 2, cacheRead: 0, cacheWrite: 0.6 } }), []);
  assert.equal(pricingErrors([]).length, 1);
  assert.equal(pricingErrors("x").length, 1);
  assert.match(pricingErrors({ q: 3 }).join(), /must be an object/);
  assert.match(pricingErrors({ q: { input: -1, output: 1 } }).join(), /pricing\["q"\]\.input must be a finite number ≥ 0/);
  assert.match(pricingErrors({ q: { input: NaN, output: 1 } }).join(), /input must be a finite number/);
  assert.match(pricingErrors({ q: { input: "1", output: 1 } }).join(), /input must be a finite number/);
  assert.match(pricingErrors({ q: { output: 1 } }).join(), /input is required/);
  assert.match(pricingErrors({ q: { input: 1 } }).join(), /output is required/);
  assert.match(pricingErrors({ q: { input: 1, output: 1, cacheWrites: 1 } }).join(), /unknown key "cacheWrites"/);
  assert.match(pricingErrors({ " ": { input: 1, output: 1 } }).join(), /non-empty/);
});

test("pricingOf: a heartbeat's well-formed pricing, else null", () => {
  const pricing = { q: { input: 1, output: 1 } };
  assert.deepEqual(pricingOf({ pricing }), pricing);
  assert.equal(pricingOf({ pricing: { q: { input: -1, output: 1 } } }), null);
  assert.equal(pricingOf({ pricing: null }), null);
  assert.equal(pricingOf(null), null);
});
