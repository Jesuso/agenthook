import { test } from "node:test";
import assert from "node:assert/strict";
import { findStep, prevStep, isPipeline, stepForStage } from "../src/pipeline.js";

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

test("stepForStage maps a source label (case-insensitive) / section gid / status to its step", () => {
  const cfg = /** @type {any} */ ({
    pipeline: [
      { id: "code", sourceLabel: "agent:code", successLabel: "agent:review" },
      { id: "review", sourceLabel: "agent:review" },
      { id: "a", sourceSectionGid: "S1" },
      { id: "j", sourceStatus: "In Review" },
    ],
  });
  assert.equal(stepForStage(cfg, "Agent:Review")?.id, "review");
  assert.equal(stepForStage(cfg, "S1")?.id, "a");
  assert.equal(stepForStage(cfg, "In Review")?.id, "j");
  assert.equal(stepForStage(cfg, "agent:failed"), null);
  assert.equal(stepForStage(cfg, null), null);
  assert.equal(stepForStage(/** @type {any} */ ({ pipeline: null }), "agent:code"), null);
});
