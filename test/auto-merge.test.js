import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// forge.autoMerge (src/auto-merge.js): which finished runs auto-merge (tier/outcome/step gating),
// config validation, and runAutoMerge's never-throw contract over a stubbed forge.
import test from "node:test";
import assert from "node:assert/strict";
import { autoMergeDecision, autoMergeErrors, autoMergeStepId, runAutoMerge } from "../src/auto-merge.js";

const pipeline = [
  { id: "triage", kind: "triage" },
  { id: "code", kind: "implement", createsWorktree: true },
  { id: "review", kind: "review" },
  { id: "done", manual: true },
];
/** @param {any} [am] */
const cfg = (am = { tiers: ["low", "medium"] }) => /** @type {any} */ ({ pipeline, forge: { type: "github", autoMerge: am } });
/** @param {string} outcome @param {any} [summary] */
const verdict = (outcome, summary) => /** @type {any} */ ({ outcome, ...(summary !== undefined ? { summary } : {}) });

test("autoMergeDecision: only the approving step's advance with an allowed tier", () => {
  const cases = /** @type {Array<[string, string, any, any]>} */ ([
    // [why, stepId, verdict, expected]
    ["low tier", "review", verdict("advance", { tier: "low" }), { tier: "low", method: "squash" }],
    ["medium tier", "review", verdict("advance", { tier: "medium" }), { tier: "medium", method: "squash" }],
    ["tier case/space-insensitive", "review", verdict("advance", { tier: " Low " }), { tier: "low", method: "squash" }],
    ["high tier is outside the list", "review", verdict("advance", { tier: "high" }), null],
    ["hold", "review", verdict("hold", { tier: "low" }), null],
    ["changes", "review", verdict("changes", { tier: "low" }), null],
    ["fail", "review", verdict("fail", { tier: "low" }), null],
    ["no summary", "review", verdict("advance"), null],
    ["summary without a tier", "review", verdict("advance", { plain: "ok" }), null],
    ["non-string tier", "review", verdict("advance", { tier: 1 }), null],
    ["not the approving step", "code", verdict("advance", { tier: "low" }), null],
  ]);
  for (const [why, stepId, v, want] of cases) assert.deepEqual(autoMergeDecision(cfg(), stepId, v), want, why);
});

test("autoMergeDecision: absent block → never; method and step overrides apply", () => {
  assert.equal(autoMergeDecision(/** @type {any} */ ({ pipeline, forge: { type: "github" } }), "review", verdict("advance", { tier: "low" })), null);
  assert.equal(autoMergeDecision(/** @type {any} */ ({ pipeline }), "review", verdict("advance", { tier: "low" })), null);
  assert.deepEqual(autoMergeDecision(cfg({ tiers: ["low"], method: "rebase" }), "review", verdict("advance", { tier: "low" })), { tier: "low", method: "rebase" });
  assert.deepEqual(autoMergeDecision(cfg({ tiers: ["low"], step: "code" }), "code", verdict("advance", { tier: "low" })), { tier: "low", method: "squash" });
  assert.equal(autoMergeDecision(cfg({ tiers: ["low"], step: "code" }), "review", verdict("advance", { tier: "low" })), null);
});

test("autoMergeStepId: the last review-kind step, so an earlier review never merges past a later one", () => {
  const two = [...pipeline.slice(0, 3), { id: "audit", kind: "review" }, { id: "done", manual: true }];
  assert.equal(autoMergeStepId(two, { tiers: ["low"] }), "audit");
  assert.equal(autoMergeStepId(two, { tiers: ["low"], step: "review" }), "review");
  assert.equal(autoMergeStepId([{ id: "code" }], { tiers: ["low"] }), null);
});

test("autoMergeErrors: valid, absent, and each malformed shape", () => {
  const forge = (/** @type {any} */ am, type = "github") => ({ type, autoMerge: am });
  assert.deepEqual(autoMergeErrors(undefined, pipeline), []);
  assert.deepEqual(autoMergeErrors({ type: "github" }, pipeline), []);
  assert.deepEqual(autoMergeErrors(forge({ tiers: ["low"], method: "merge", step: "review" }), pipeline), []);
  const bad = /** @type {Array<[any, RegExp, any?]>} */ ([
    [forge(["low"]), /must be an object/],
    [forge({ tiers: [] }), /tiers must be a non-empty array/],
    [forge({ tiers: "low" }), /tiers must be a non-empty array/],
    [forge({ tiers: ["low", ""] }), /tiers must be a non-empty array/],
    [forge({ tiers: ["low"], method: "fast-forward" }), /method must be one of squash, merge, rebase/],
    [forge({ tiers: ["low"], step: "nope" }), /"nope" is not a pipeline step id/],
    [forge({ tiers: ["low"], step: "done" }), /"done" is a manual step/],
    [forge({ tiers: ["low"] }), /needs a review step/, [{ id: "code" }]],
    [forge({ tiers: ["low"] }, "gitlab"), /only supported on the github forge/],
  ]);
  for (const [f, re, pl] of bad) {
    const errs = autoMergeErrors(f, pl ?? pipeline);
    assert.ok(errs.some((e) => re.test(e)), `${JSON.stringify(f)} → ${JSON.stringify(errs)}`);
  }
});

// --- runAutoMerge over a stubbed forge ---

/** @param {any} [over] */
function harness(over = {}) {
  /** @type {any[]} */
  const events = [];
  /** @type {any[]} */
  const calls = [];
  const forge = /** @type {any} */ ({
    prHead: async (/** @type {any} */ n, /** @type {string} */ ref) => {
      calls.push(["prHead", n, ref]);
      return { number: 7, sha: "abc", open: true };
    },
    enableAutoMerge: async (/** @type {number} */ n, /** @type {any} */ o) => {
      calls.push(["enableAutoMerge", n, o.method]);
      return { status: "enabled", readied: false };
    },
    ...over,
  });
  const store = /** @type {any} */ ({ getRefMeta: () => ({ pr: 7 }) });
  const emit = (/** @type {string} */ event, /** @type {string} */ ref, /** @type {string} */ step, /** @type {any} */ extra) => events.push({ event, ref, step, ...extra });
  return { deps: { forge, store, emit }, events, calls };
}
const decision = /** @type {const} */ ({ tier: "low", method: "squash" });

/** @param {() => Promise<any>} fn */
async function quiet(fn) {
  const [log, err] = [console.log, console.error];
  console.log = console.error = () => {};
  try {
    return await fn();
  } finally {
    [console.log, console.error] = [log, err];
  }
}

test("runAutoMerge: looks the PR up by its stored number, enables, emits auto_merge_enabled", async () => {
  const h = harness();
  const res = await quiet(() => runAutoMerge(h.deps, "42", "review", decision));
  assert.deepEqual(res, { status: "enabled", readied: false });
  assert.deepEqual(h.calls, [["prHead", 7, "42"], ["enableAutoMerge", 7, "squash"]]);
  assert.deepEqual(h.events, [{ event: "auto_merge_enabled", ref: "42", step: "review", pr: 7, tier: "low", method: "squash" }]);
});

test("runAutoMerge: idempotent — an already-enabled or no-longer-open PR emits nothing and does not throw", async () => {
  for (const status of ["already", "merged", "closed"]) {
    const h = harness({ enableAutoMerge: async () => ({ status, readied: false }) });
    const res = await quiet(() => runAutoMerge(h.deps, "42", "review", decision));
    assert.equal(res?.status, status);
    assert.deepEqual(h.events, [], status);
  }
  const closed = harness({ prHead: async () => ({ number: 7, sha: "abc", open: false }) });
  assert.equal(await quiet(() => runAutoMerge(closed.deps, "42", "review", decision)), null);
  assert.deepEqual(closed.events, []);
});

test("runAutoMerge: merged at once is reported as enabled with mergedNow + readied", async () => {
  const h = harness({ enableAutoMerge: async () => ({ status: "merged_now", readied: true }) });
  await quiet(() => runAutoMerge(h.deps, "42", "review", decision));
  assert.deepEqual(h.events, [{ event: "auto_merge_enabled", ref: "42", step: "review", pr: 7, tier: "low", method: "squash", readied: true, mergedNow: true }]);
});

test("runAutoMerge: every failure is non-fatal — one auto_merge_failed event with the reason", async () => {
  const cases = /** @type {Array<[string, any, any]>} */ ([
    ["refused", { enableAutoMerge: async () => { throw new Error("Auto merge is not allowed for this repository"); } }, { pr: 7, reason: "Auto merge is not allowed for this repository" }],
    ["network", { prHead: async () => { throw new Error("fetch failed"); } }, { reason: "PR lookup failed: fetch failed" }],
    ["no PR", { prHead: async () => null }, { reason: "no agent PR for this task" }],
    ["forge without support", { enableAutoMerge: undefined }, { reason: "the forge cannot auto-merge" }],
  ]);
  for (const [why, over, want] of cases) {
    const h = harness(over);
    const res = await quiet(() => runAutoMerge(h.deps, "42", "review", decision));
    assert.equal(res, null, why);
    assert.deepEqual(h.events, [{ event: "auto_merge_failed", ref: "42", step: "review", tier: "low", ...want }], why);
  }
  const noForge = harness();
  assert.equal(await quiet(() => runAutoMerge({ ...noForge.deps, forge: null }, "42", "review", decision)), null);
  assert.equal(noForge.events[0]?.event, "auto_merge_failed");
});
