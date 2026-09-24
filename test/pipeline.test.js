import { test } from "node:test";
import assert from "node:assert/strict";
import { findStep, prevStep, isPipeline, startsWithTrigger, resumeJob } from "../src/pipeline.js";

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

// --- the adapter-neutral half of the `@agent` comment trigger ---

/** Store stub carrying just what resumeJob reads. @param {any} held @param {number} [ran] */
const heldStore = (held, ran = 0) => /** @type {any} */ ({ getHeld: () => held, getAttempt: () => ran });
/** @type {any} */
const rcfg = { pipeline: [{ id: "triage" }, { id: "code", maxAttempts: 2 }, { id: "done", manual: true }] };

test("startsWithTrigger matches a (leading-whitespace-tolerant) prefix; unset trigger matches nothing", () => {
  assert.equal(startsWithTrigger("@agent", "@agent use postgres"), true);
  assert.equal(startsWithTrigger("@agent", "  \n@agent go"), true);
  assert.equal(startsWithTrigger("@agent", "thanks @agent"), false);
  assert.equal(startsWithTrigger("@agent", undefined), false);
  assert.equal(startsWithTrigger(undefined, "@agent go"), false);
  assert.equal(startsWithTrigger("", "anything"), false);
});

test("resumeJob resumes the held step with a trigger:<id> key and the comment body", () => {
  const job = resumeJob(rcfg, heldStore({ stepId: "triage", heldAt: "x" }), "42", "c1", "@agent yes");
  assert.deepEqual(job, { kind: "pipeline", ref: "42", stepId: "triage", dedupKey: "trigger:c1", comment: "@agent yes" });
});

test("resumeJob is null with no held record, an unknown/manual held step, or at the attempt cap", () => {
  assert.equal(resumeJob(rcfg, heldStore(undefined), "42", "c1", "@agent x"), null);
  assert.equal(resumeJob(rcfg, heldStore({ stepId: "gone", heldAt: "x" }), "42", "c1", "@agent x"), null);
  assert.equal(resumeJob(rcfg, heldStore({ stepId: "done", heldAt: "x" }), "42", "c1", "@agent x"), null);
  assert.equal(resumeJob(rcfg, heldStore({ stepId: "code", heldAt: "x" }, 2), "42", "c1", "@agent x"), null, "per-step maxAttempts");
  assert.equal(resumeJob(rcfg, heldStore({ stepId: "triage", heldAt: "x" }, 3), "42", "c1", "@agent x"), null, "default cap 3");
  assert.ok(resumeJob(rcfg, heldStore({ stepId: "code", heldAt: "x" }, 1), "42", "c1", "@agent x"), "under the cap resumes");
});
