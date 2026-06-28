import { test } from "node:test";
import assert from "node:assert/strict";
import { findStep, prevStep, isPipeline } from "../src/pipeline.js";

/** @type {any} */
const cfg = { pipeline: [{ id: "triage" }, { id: "code" }, { id: "review" }] };

test("findStep returns the step by id; null on miss or missing input", () => {
  assert.equal(findStep(cfg, "code")?.id, "code");
  assert.equal(findStep(cfg, "nope"), null);
  assert.equal(findStep(cfg, undefined), null);
  assert.equal(findStep(/** @type {any} */ ({}), "code"), null);
});

test("prevStep is the prior step in order; null at the head or unknown", () => {
  assert.equal(prevStep(cfg, "review")?.id, "code");
  assert.equal(prevStep(cfg, "code")?.id, "triage");
  assert.equal(prevStep(cfg, "triage"), null); // first step has no predecessor
  assert.equal(prevStep(cfg, "unknown"), null);
});

test("isPipeline is true only for a non-empty pipeline array", () => {
  assert.equal(isPipeline(cfg), true);
  assert.equal(isPipeline(/** @type {any} */ ({ pipeline: [] })), false);
  assert.equal(isPipeline(/** @type {any} */ ({})), false);
});
