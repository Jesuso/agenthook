import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// forge.autoMerge (src/auto-merge.js): which finished runs auto-merge (tier/outcome/step/head
// gating), config validation, runAutoMerge's never-throw contract, the bounce disable (tri-state,
// too-late, in-flight serialization) and the pr_push guard — all over a stubbed forge.
import test from "node:test";
import assert from "node:assert/strict";
import {
  autoMergeDecision,
  autoMergeErrors,
  autoMergeStepId,
  createPrPushGuard,
  currentPrHead,
  disableAutoMergeOnBounce,
  holdAutoMergeSlot,
  needsReviewedHead,
  reportAutoMergeSkipped,
  runAutoMerge,
} from "../src/auto-merge.js";

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
const go = (/** @type {string} */ tier, method = "squash", from = "review") => ({ tier, method, sha: "abc", from });

test("autoMergeDecision: only the approving step's advance with an allowed tier, pinned to the run's head", () => {
  const cases = /** @type {Array<[string, string, any, any]>} */ ([
    // [why, stepId, verdict, expected]
    ["low tier", "review", verdict("advance", { tier: "low" }), go("low")],
    ["medium tier", "review", verdict("advance", { tier: "medium" }), go("medium")],
    ["tier case/space-insensitive", "review", verdict("advance", { tier: " Low " }), go("low")],
    ["high tier is outside the list → skipped", "review", verdict("advance", { tier: "high" }), { skipped: 'tier "high" is not in [low, medium]', tier: "high" }],
    ["hold", "review", verdict("hold", { tier: "low" }), null],
    ["changes", "review", verdict("changes", { tier: "low" }), null],
    ["fail", "review", verdict("fail", { tier: "low" }), null],
    ["no summary → skipped", "review", verdict("advance"), { skipped: 'no summary.tier in the "review" verdict' }],
    ["summary without a tier → skipped", "review", verdict("advance", { plain: "ok" }), { skipped: 'no summary.tier in the "review" verdict' }],
    ["non-string tier → skipped", "review", verdict("advance", { tier: 1 }), { skipped: 'no summary.tier in the "review" verdict' }],
    ["not the approving step", "code", verdict("advance", { tier: "low" }), null],
  ]);
  for (const [why, stepId, v, want] of cases) assert.deepEqual(autoMergeDecision(cfg(), stepId, v, undefined, "abc"), want, why);
  // No head recorded at the run's start (no PR yet, lookup failed) → fail closed.
  assert.deepEqual(autoMergeDecision(cfg(), "review", verdict("advance", { tier: "low" }), undefined, null), {
    skipped: 'no PR head recorded for the "review" run (no PR when it started?)',
    tier: "low",
  });
});

test("autoMergeDecision: absent block → never; method and step overrides apply", () => {
  const v = verdict("advance", { tier: "low" });
  assert.equal(autoMergeDecision(/** @type {any} */ ({ pipeline, forge: { type: "github" } }), "review", v, undefined, "abc"), null);
  assert.equal(autoMergeDecision(/** @type {any} */ ({ pipeline }), "review", v, undefined, "abc"), null);
  assert.deepEqual(autoMergeDecision(cfg({ tiers: ["low"], method: "rebase" }), "review", v, undefined, "abc"), go("low", "rebase"));
  assert.deepEqual(autoMergeDecision(cfg({ tiers: ["low"], step: "code" }), "code", v, undefined, "abc"), go("low", "squash", "code"));
  assert.equal(autoMergeDecision(cfg({ tiers: ["low"], step: "code" }), "review", v, undefined, "abc"), null);
});

test("autoMergeDecision: tierFrom reads another step's stored approving summary and its recorded head", () => {
  const qa = [...pipeline.slice(0, 3), { id: "qa", kind: "qa" }, { id: "done", manual: true }];
  const c = /** @type {any} */ ({ pipeline: qa, forge: { type: "github", autoMerge: { tiers: ["low"], step: "qa", tierFrom: "review" } } });
  const stored = (/** @type {string} */ outcome, /** @type {any} */ summary, headSha = "rev") => ({ review: { summary, outcome, run: "r", at: "t", ...(headSha ? { headSha } : {}) } });
  // QA's own verdict has no tier; review's stored one decides, pinned to the head review saw (not QA's).
  assert.deepEqual(autoMergeDecision(c, "qa", verdict("advance"), stored("advance", { tier: "Low" }), "qa-head"), { tier: "low", method: "squash", sha: "rev", from: "review" });
  assert.deepEqual(autoMergeDecision(c, "qa", verdict("advance", { tier: "low" }), stored("advance", { tier: "high" })), { skipped: 'tier "high" is not in [low]', tier: "high" });
  assert.deepEqual(autoMergeDecision(c, "qa", verdict("advance"), stored("changes", { tier: "low" })), { skipped: 'step "review" (tierFrom) has no approving verdict stored' });
  assert.deepEqual(autoMergeDecision(c, "qa", verdict("advance"), undefined), { skipped: 'step "review" (tierFrom) has no approving verdict stored' });
  assert.equal(/** @type {any} */ (autoMergeDecision(c, "qa", verdict("advance"), stored("advance", { tier: "low" }, ""), "qa-head"))?.skipped, 'no PR head recorded for the "review" run (no PR when it started?)');
  // The review itself is not the trigger any more, but it is the step whose head is recorded.
  assert.equal(autoMergeDecision(c, "review", verdict("advance", { tier: "low" }), stored("advance", { tier: "low" }), "x"), null);
  assert.equal(needsReviewedHead(c, "review"), true);
  assert.equal(needsReviewedHead(c, "qa"), false);
  assert.equal(needsReviewedHead(cfg(), "review"), true);
  assert.equal(needsReviewedHead(/** @type {any} */ ({ pipeline }), "review"), false);
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
  const withQa = [...pipeline.slice(0, 3), { id: "qa", kind: "qa" }, { id: "done", manual: true }];
  assert.deepEqual(autoMergeErrors(forge({ tiers: ["low"], step: "qa", tierFrom: "review" }), withQa), [], "tierFrom before step is fine");
  assert.deepEqual(autoMergeErrors(forge({ tiers: ["low"], tierFrom: "review" }), pipeline), [], "tierFrom = the approving step is fine");
  assert.deepEqual(autoMergeErrors(forge({ tiers: ["low"] }), pipeline, [{ id: "a" }]), [], "one repo is fine");
  assert.deepEqual(autoMergeErrors(forge({ tiers: ["low"], step: "triage" }), [{ id: "triage" }, { id: "code" }]), [], "no createsWorktree step → no order check");
  const bad = /** @type {Array<[any, RegExp, any?, any?]>} */ ([
    [forge(["low"]), /must be an object/],
    [forge({ tiers: [] }), /tiers must be a non-empty array/],
    [forge({ tiers: "low" }), /tiers must be a non-empty array/],
    [forge({ tiers: ["low", ""] }), /tiers must be a non-empty array/],
    [forge({ tiers: ["low"], method: "fast-forward" }), /method must be one of squash, merge, rebase/],
    [forge({ tiers: ["low"], step: "nope" }), /"nope" is not a pipeline step id/],
    [forge({ tiers: ["low"], step: "done" }), /"done" is a manual step/],
    [forge({ tiers: ["low"] }), /needs a review step/, [{ id: "code" }]],
    [forge({ tiers: ["low"] }, "gitlab"), /only supported on the github forge/],
    [forge({ tiers: ["low"], tierFrom: "" }), /tierFrom must be a pipeline step id/],
    [forge({ tiers: ["low"], tierFrom: "nope" }), /tierFrom "nope" is not a pipeline step id/],
    [forge({ tiers: ["low"], tierFrom: "done", step: "review" }), /tierFrom "done" is a manual step/],
    [forge({ tiers: ["low"], step: "code", tierFrom: "review" }), /tierFrom "review" runs after the approving step "code"/],
    [forge({ tiers: ["low"], step: "code", tierFrom: "triage" }), /takes its tier from "triage", which runs before "code" writes the code/],
    [forge({ tiers: ["low"], step: "code" }), /takes its tier from "code", which writes the code/],
    [forge({ tiers: ["low"], step: "review", tierFrom: "code" }), /takes its tier from "code", which writes the code/],
    [forge({ tiers: ["low"], step: "triage" }), /takes its tier from "triage"/],
    [forge({ tiers: ["low"] }), /does not support multi-repo routing/, undefined, [{ id: "a" }, { id: "b" }]],
  ]);
  for (const [f, re, pl, repos] of bad) {
    const errs = autoMergeErrors(f, pl ?? pipeline, repos);
    assert.ok(errs.some((e) => re.test(e)), `${JSON.stringify(f)} → ${JSON.stringify(errs)}`);
  }
});

// --- runtime helpers over a stubbed forge + in-memory ref meta ---

/** @param {any} [over] @param {any} [meta] */
function harness(over = {}, meta = { pr: 7 }) {
  /** @type {any[]} */
  const events = [];
  /** @type {any[]} */
  const calls = [];
  /** @type {Record<string, any>} */
  const metas = { 42: { ...meta } };
  const forge = /** @type {any} */ ({
    prHead: async (/** @type {any} */ n, /** @type {string} */ ref) => {
      calls.push(["prHead", n, ref]);
      return { number: 7, sha: "abc", open: true };
    },
    enableAutoMerge: async (/** @type {number} */ n, /** @type {any} */ o) => {
      calls.push(["enableAutoMerge", n, o.method, o.expectedSha]);
      return { status: "enabled", readied: false };
    },
    disableAutoMerge: async (/** @type {number} */ n) => {
      calls.push(["disableAutoMerge", n]);
      return { status: "disabled" };
    },
    prState: async (/** @type {number} */ n) => {
      calls.push(["prState", n]);
      return "merged";
    },
    ...over,
  });
  const store = /** @type {any} */ ({
    getRefMeta: (/** @type {string} */ r) => metas[r],
    setRefMeta: (/** @type {string} */ r, /** @type {any} */ patch) => {
      const m = (metas[r] ??= {});
      for (const [k, v] of Object.entries(patch)) if (v === null) delete m[k]; else if (v !== undefined) m[k] = v;
    },
  });
  const emit = (/** @type {string} */ event, /** @type {string} */ ref, /** @type {string} */ step, /** @type {any} */ extra) => events.push({ event, ref, step, ...extra });
  return { deps: { forge, store, emit }, events, calls, metas };
}
const decision = /** @type {const} */ ({ tier: "low", method: "squash", sha: "abc", from: "review" });

/** @template T @param {() => Promise<T>|T} fn @returns {Promise<T>} */
async function quiet(fn) {
  const [log, err] = [console.log, console.error];
  console.log = console.error = () => {};
  try {
    return await fn();
  } finally {
    [console.log, console.error] = [log, err];
  }
}

test("runAutoMerge: looks the PR up by its stored number, enables pinned to the approved sha, records it, emits auto_merge_enabled", async () => {
  const h = harness();
  const res = await quiet(() => runAutoMerge(h.deps, "42", "review", decision));
  assert.deepEqual(res, { status: "enabled", readied: false });
  assert.deepEqual(h.calls, [["prHead", 7, "42"], ["enableAutoMerge", 7, "squash", "abc"]]);
  assert.deepEqual(h.events, [{ event: "auto_merge_enabled", ref: "42", step: "review", pr: 7, tier: "low", method: "squash" }]);
  assert.equal(h.metas[42].autoMerge?.sha, "abc");
});

test("runAutoMerge: a head that moved since the tier step saw it is auto_merge_skipped, nothing recorded", async () => {
  const h = harness({ enableAutoMerge: async () => ({ status: "moved", readied: false, headSha: "def0000" }) });
  await quiet(() => runAutoMerge(h.deps, "42", "review", decision));
  assert.deepEqual(h.events, [{ event: "auto_merge_skipped", ref: "42", step: "review", tier: "low", reason: 'PR head moved since "review" saw it (abc → def0000)' }]);
  assert.equal(h.metas[42].autoMerge, undefined);
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

test("runAutoMerge: a stored PR number that is no longer open falls back to the branch lookup", async () => {
  const h = harness({
    prHead: async (/** @type {any} */ n, /** @type {string} */ ref) => {
      h.calls.push(["prHead", n, ref]);
      return n === 7 ? { number: 7, sha: "old", open: false } : { number: 9, sha: "abc", open: true };
    },
  });
  await quiet(() => runAutoMerge(h.deps, "42", "review", decision));
  assert.deepEqual(h.calls, [["prHead", 7, "42"], ["prHead", null, "42"], ["enableAutoMerge", 9, "squash", "abc"]]);
  assert.equal(h.events[0]?.pr, 9);
});

test("currentPrHead: the open PR's sha, else null; never throws", async () => {
  assert.equal(await currentPrHead(harness().deps.forge, harness().deps.store, "42"), "abc");
  const closed = harness({ prHead: async () => ({ number: 7, sha: "abc", open: false }) });
  assert.equal(await currentPrHead(closed.deps.forge, closed.deps.store, "42"), null);
  const boom = harness({ prHead: async () => { throw new Error("x"); } });
  assert.equal(await quiet(() => currentPrHead(boom.deps.forge, boom.deps.store, "42")), null);
  assert.equal(await currentPrHead(null, undefined, "42"), null);
});

test("reportAutoMergeSkipped: one auto_merge_skipped event with the reason (and the tier when there was one)", async () => {
  const h = harness();
  await quiet(() => {
    reportAutoMergeSkipped(h.deps, "42", "review", { skipped: 'tier "high" is not in [low]', tier: "high" });
    reportAutoMergeSkipped(h.deps, "42", "review", { skipped: "no tier" });
  });
  assert.deepEqual(h.events, [
    { event: "auto_merge_skipped", ref: "42", step: "review", tier: "high", reason: 'tier "high" is not in [low]' },
    { event: "auto_merge_skipped", ref: "42", step: "review", reason: "no tier" },
  ]);
});

test("disableAutoMergeOnBounce: turns auto-merge off on the open PR, clears the record, emits auto_merge_disabled", async () => {
  const h = harness({}, { pr: 7, autoMerge: { sha: "abc", pr: 7, step: "review", at: "t" } });
  assert.equal(await quiet(() => disableAutoMergeOnBounce(h.deps, "42", "qa", "changes from qa")), "disabled");
  assert.deepEqual(h.calls, [["prHead", 7, "42"], ["disableAutoMerge", 7]]);
  assert.deepEqual(h.events, [{ event: "auto_merge_disabled", ref: "42", step: "qa", pr: 7, reason: "changes from qa" }]);
  assert.equal(h.metas[42].autoMerge, undefined);
});

test("disableAutoMergeOnBounce: noop (no event) when it was off, the PR is gone or closed, or the forge can't", async () => {
  for (const [why, over] of /** @type {Array<[string, any]>} */ ([
    ["was off", { disableAutoMerge: async () => ({ status: "off" }) }],
    ["merged", { disableAutoMerge: async () => ({ status: "merged" }) }],
    ["no PR", { prHead: async () => null }],
    ["closed PR, not ours", { prHead: async () => ({ number: 7, sha: "a", open: false }) }],
    ["no forge support", { disableAutoMerge: undefined }],
  ])) {
    const h = harness(over);
    assert.equal(await quiet(() => disableAutoMergeOnBounce(h.deps, "42", "qa", "changes from qa")), "noop", why);
    assert.deepEqual(h.events, [], why);
  }
});

test("disableAutoMergeOnBounce: a refusal or lookup error is 'error' + auto_merge_failed (callers must not rework)", async () => {
  const h = harness({ disableAutoMerge: async () => { throw new Error("Resource not accessible by integration"); } });
  assert.equal(await quiet(() => disableAutoMergeOnBounce(h.deps, "42", "qa", "changes from qa", 7)), "error");
  assert.deepEqual(h.events, [{ event: "auto_merge_failed", ref: "42", step: "qa", pr: 7, reason: "disable failed (changes from qa): Resource not accessible by integration" }]);
  const l = harness({ prHead: async () => { throw new Error("502"); } });
  assert.equal(await quiet(() => disableAutoMergeOnBounce(l.deps, "42", "qa", "fail from qa")), "error");
  assert.equal(l.events[0]?.event, "auto_merge_failed");
});

test("disableAutoMergeOnBounce: our auto-merged PR already merged → auto_merge_disabled {tooLate}", async () => {
  const merged = { prHead: async () => ({ number: 7, sha: "abc", open: false }) };
  const h = harness(merged, { pr: 7, autoMerge: { sha: "abc", pr: 7, step: "review", at: "t" } });
  assert.equal(await quiet(() => disableAutoMergeOnBounce(h.deps, "42", "qa", "changes from qa")), "noop");
  assert.deepEqual(h.events, [{ event: "auto_merge_disabled", ref: "42", step: "qa", pr: 7, reason: "changes from qa", tooLate: true }]);
  // Not one we auto-merged: silent.
  const other = harness(merged);
  await quiet(() => disableAutoMergeOnBounce(other.deps, "42", "qa", "changes from qa"));
  assert.deepEqual(other.events, []);
});

test("disableAutoMergeOnBounce waits for an enable still in flight on the same ref", async () => {
  /** @type {string[]} */
  const order = [];
  let on = false;
  const h = harness({
    disableAutoMerge: async () => {
      order.push(`disable sees ${on ? "on" : "off"}`);
      return { status: on ? "disabled" : "off" };
    },
  });
  /** @type {() => void} */
  let finish = () => {};
  holdAutoMergeSlot("42", new Promise((r) => (finish = () => r(undefined))));
  const pending = quiet(() => disableAutoMergeOnBounce(h.deps, "42", "qa", "changes from qa"));
  await new Promise((r) => setTimeout(r, 10));
  on = true; // the enable lands
  order.push("enabled");
  finish();
  assert.equal(await pending, "disabled");
  assert.deepEqual(order, ["enabled", "disable sees on"]);
});

test("pr_push guard: a new head on a PR we auto-merged at an older sha turns it off; same sha / not ours / feature off are no-ops", async () => {
  const ours = { pr: 7, autoMerge: { sha: "abc", pr: 7, step: "review", at: "t" } };
  const job = (/** @type {string} */ sha) => /** @type {any} */ ({ kind: "pr_push", ref: "42", stepId: "", dedupKey: "k", push: { prNumber: 7, headSha: sha } });
  const on = cfg({ tiers: ["low"] });
  let h = harness({}, ours);
  assert.equal(await quiet(() => createPrPushGuard({ ...h.deps, cfg: on })(job("def0000"))), "disabled");
  assert.deepEqual(h.events, [{ event: "auto_merge_disabled", ref: "42", step: "", pr: 7, reason: "new commit def0000 after approval of abc" }]);
  h = harness({}, ours);
  assert.equal(await createPrPushGuard({ ...h.deps, cfg: on })(job("abc")), "noop", "the approved head itself");
  h = harness();
  assert.equal(await createPrPushGuard({ ...h.deps, cfg: on })(job("def0000")), "noop", "someone else's auto-merge");
  h = harness({}, ours);
  assert.equal(await createPrPushGuard({ ...h.deps, cfg: /** @type {any} */ ({ pipeline }) })(job("def0000")), "noop", "feature off");
  assert.deepEqual(h.calls, []);
});

test("request handler: a pr_push job goes to the push guard, never to intake", async () => {
  const http = await import("node:http");
  const { createRequestHandler } = await import("../src/engine/http.js");
  /** @type {any[]} */ const pushed = [];
  /** @type {any[]} */ const intaken = [];
  const pushJob = { kind: /** @type {const} */ ("pr_push"), ref: "42", stepId: "", dedupKey: "prpush:7:def", push: { prNumber: 7, headSha: "def" } };
  /** @type {() => void} */
  let settled = () => {};
  const handler = createRequestHandler({
    adapter: /** @type {any} */ ({ authenticate: () => ({ type: "accept" }), processEvents: async () => [pushJob] }),
    forge: null,
    intake: (jobs) => {
      intaken.push(...jobs);
      settled();
    },
    ciGreen: () => assert.fail("not a ci_green"),
    epicChanged: () => assert.fail("not an epic_changed"),
    boardDone: () => assert.fail("not a board_done"),
    prPush: async (j) => void pushed.push(j),
  });
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", () => r(undefined)));
  const port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
  try {
    const done = new Promise((r) => (settled = () => r(undefined)));
    assert.equal((await fetch(`http://127.0.0.1:${port}/github/`, { method: "POST", body: "{}" })).status, 200);
    await done;
  } finally {
    server.close();
  }
  assert.deepEqual(pushed, [pushJob]);
  assert.deepEqual(intaken, []);
});
