import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// Dispatch — forge-facing jobs: merge jobs (no agent spawn), red-CI jobs (re-run once, then
// bounce to code), and forge.autoMerge wiring (the approving step's final advance reaches
// the forge, nothing else does).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDispatcher } from "../src/dispatch/index.js";
import { heldHarness } from "./_dispatch-helpers.js";
import { LOG, SHA, TRUSTED, ciHarness, ciJob } from "./_ci-helpers.js";

// --- merge jobs (forge): no agent spawn; move → complete → emit, fail-closed on assignee ---

/**
 * A dispatcher over a recording stub adapter. `pipeline` defaults to one with a
 * completeOnMerge `done` step; repoPath is a temp dir so a direct drain is a no-op.
 * @param {{assignedToUs?: boolean, fetchThrows?: boolean, pipeline?: any[], enterStage?: boolean, complete?: boolean, completed?: boolean, forge?: any, enterThrows?: boolean, completeThrows?: boolean}} [o]
 */
function mergeHarness(o = {}) {
  /** @type {string[]} */
  const calls = [];
  /** @type {any[]} */
  const events = [];
  const pipeline = o.pipeline ?? [
    { id: "code", sourceSectionGid: "S1" },
    { id: "done", manual: true, completeOnMerge: true, drainWorktree: true, sourceSectionGid: "S9" },
  ];
  const cfg = { pipeline, repoPath: fs.mkdtempSync(path.join(os.tmpdir(), "ah-merge-")), ...(o.forge ? { forge: o.forge } : {}) };
  /** @type {any} */
  const adapter = {
    describe: () => ({ platform: "Stub", taskNoun: "task", trigger: "@agent", commentHowTo: "" }),
    fetchTask: async (ref) => {
      calls.push(`fetch ${ref}`);
      if (o.fetchThrows) throw new Error("boom");
      return { ref, name: `Task ${ref}`, url: `u/${ref}`, completed: !!o.completed, assignedToUs: o.assignedToUs ?? true };
    },
    advance: async () => calls.push("advance"),
  };
  if (o.enterStage !== false)
    adapter.enterStage = async (ref, stepId, opts) => {
      calls.push(`enter ${ref} ${stepId} assign=${opts?.assign}`);
      if (o.enterThrows) throw new Error("move boom");
    };
  if (o.complete !== false)
    adapter.complete = async (ref) => {
      calls.push(`complete ${ref}`);
      if (o.completeThrows) throw new Error("complete boom");
    };
  const store = {
    clearAttempts: (ref) => calls.push(`clearAttempts ${ref}`),
    clearFindings: (ref) => calls.push(`clearFindings ${ref}`),
    clearDifficulty: (ref) => calls.push(`clearDifficulty ${ref}`),
    clearSummaries: (ref) => calls.push(`clearSummaries ${ref}`),
    setRefMeta: (ref, patch) => calls.push(`refmeta ${ref} ${JSON.stringify(patch)}`),
    getRefMeta: (ref) => o.refmeta?.[ref],
  };
  const emit = (event, ref, step, extra) => events.push({ event, ref, step, ...extra });
  const run = createDispatcher(/** @type {any} */ (cfg), adapter, undefined, /** @type {any} */ (store), emit);
  return { run, calls, events };
}

test("merge: follow-up checks recorded on the ref become due on merge (followup_due after merged)", async () => {
  const h = mergeHarness({ refmeta: { G1: { followUp: { checks: ["signup errors stay flat", "no new 5xx"], tier: "low", step: "review", at: "2026-01-01T00:00:00.000Z", pr: 5 } } } });
  await h.run({ kind: "merge", ref: "G1", stepId: "done", dedupKey: "merged:5" });
  assert.deepEqual(
    h.events.map((e) => e.event),
    ["merged", "followup_due"],
  );
  assert.deepEqual(h.events[1], { event: "followup_due", ref: "G1", step: "done", n: 2, detail: "signup errors stay flat; no new 5xx", pr: 5, name: "Task G1", url: "u/G1" });
  const none = mergeHarness();
  await none.run({ kind: "merge", ref: "G1", stepId: "done", dedupKey: "merged:6" });
  assert.deepEqual(none.events.map((e) => e.event), ["merged"], "no record, no due event");
});

test("merge: moves into the completeOnMerge step (assign:false) BEFORE completing, emits merged", async () => {
  const h = mergeHarness();
  const out = await h.run({ kind: "merge", ref: "G1", stepId: "done", dedupKey: "merged:5" });
  assert.deepEqual(h.calls, ["fetch G1", 'refmeta G1 {"prState":"merged"}', "enter G1 done assign=false", "complete G1", "clearSummaries G1", 'refmeta G1 {"prState":"merged"}']);
  assert.deepEqual(h.events, [{ event: "merged", ref: "G1", step: "done", name: "Task G1", url: "u/G1" }]);
  assert.equal(out.code, 0);
  assert.equal(out.name, "Task G1");
});

test("merge: task not assigned to us → no tracker writes, no event; records prState merged locally", async () => {
  const h = mergeHarness({ assignedToUs: false });
  await h.run({ kind: "merge", ref: "G1", stepId: "done", dedupKey: "merged:5" });
  assert.deepEqual(h.calls, ["fetch G1", 'refmeta G1 {"prState":"merged"}']);
  assert.deepEqual(h.events, []);
});

test("merge: fetch error fails closed (skip); records prState merged locally", async () => {
  const h = mergeHarness({ fetchThrows: true });
  await h.run({ kind: "merge", ref: "G1", stepId: "done", dedupKey: "merged:5" });
  assert.deepEqual(h.calls, ["fetch G1", 'refmeta G1 {"prState":"merged"}']);
  assert.deepEqual(h.events, []);
});

test("merge: no completeOnMerge step → complete + direct cleanup (attempts/findings/difficulty)", async () => {
  const h = mergeHarness({ pipeline: [{ id: "code" }] });
  await h.run({ kind: "merge", ref: "G1", stepId: "", dedupKey: "merged:5" });
  assert.deepEqual(h.calls, ["fetch G1", "complete G1", "clearAttempts G1", "clearFindings G1", "clearDifficulty G1", "clearSummaries G1", 'refmeta G1 {"prState":"merged"}']);
  assert.deepEqual(h.events, [{ event: "merged", ref: "G1", step: "", name: "Task G1", url: "u/G1" }]);
});

test("merge: tracker without complete() but the completeOnMerge move worked → no 'leaving it open' log", async () => {
  const h = mergeHarness({ complete: false });
  /** @type {string[]} */
  const lines = [];
  const log = console.log;
  console.log = (/** @type {string} */ l) => lines.push(l);
  try {
    await h.run({ kind: "merge", ref: "G1", stepId: "done", dedupKey: "merged:5" });
  } finally {
    console.log = log;
  }
  assert.deepEqual(h.calls, ["fetch G1", 'refmeta G1 {"prState":"merged"}', "enter G1 done assign=false", "clearSummaries G1", 'refmeta G1 {"prState":"merged"}']);
  assert.deepEqual(h.events, [{ event: "merged", ref: "G1", step: "done", name: "Task G1", url: "u/G1" }]);
  assert.ok(!lines.some((l) => l.includes("leaving it open")), "no stale 'has no complete()' log after a successful move");
});

test("merge: no complete() and nothing moved the task → logs the completeOnMerge remedy", async () => {
  const h = mergeHarness({ complete: false, pipeline: [{ id: "code" }] });
  /** @type {string[]} */
  const lines = [];
  const log = console.log;
  console.log = (/** @type {string} */ l) => lines.push(l);
  try {
    await h.run({ kind: "merge", ref: "G1", stepId: "", dedupKey: "merged:5" });
  } finally {
    console.log = log;
  }
  assert.ok(lines.some((l) => l.includes("has no complete()") && l.includes("completeOnMerge")), "logs the remedy when nothing moved the task");
});

for (const [label, o, job] of /** @type {const} */ ([
  ["job.boardCloses", {}, { boardCloses: true }],
  ["forge.boardClosesOnMerge", { forge: { type: "github", boardClosesOnMerge: true } }, {}],
  ["task already completed", { completed: true }, {}],
])) {
  test(`merge: self-closing board (${label}) → no enterStage/complete; direct cleanup + merged`, async () => {
    const h = mergeHarness(o);
    /** @type {string[]} */
    const lines = [];
    const log = console.log;
    console.log = (/** @type {string} */ l) => lines.push(l);
    try {
      await h.run({ kind: "merge", ref: "G1", stepId: "done", dedupKey: "merged:5", ...job });
    } finally {
      console.log = log;
    }
    assert.deepEqual(h.calls, ["fetch G1", "clearAttempts G1", "clearFindings G1", "clearDifficulty G1", "clearSummaries G1", 'refmeta G1 {"prState":"merged"}']);
    assert.deepEqual(h.events, [{ event: "merged", ref: "G1", step: "done", name: "Task G1", url: "u/G1" }]);
    assert.ok(lines.some((l) => l.includes("board closes its own ticket on merge; not bridging")));
  });
}

test("merge: self-closing still fails closed on the assignee (no tracker writes, no event)", async () => {
  const h = mergeHarness({ assignedToUs: false });
  await h.run({ kind: "merge", ref: "G1", stepId: "done", dedupKey: "merged:5", boardCloses: true });
  assert.deepEqual(h.calls, ["fetch G1", 'refmeta G1 {"prState":"merged"}']);
  assert.deepEqual(h.events, []);
});

test("merge: move failed with no complete(), or complete() threw → still records prState merged", async () => {
  const a = mergeHarness({ enterThrows: true, complete: false });
  await a.run({ kind: "merge", ref: "G1", stepId: "done", dedupKey: "merged:5" });
  assert.ok(a.calls.includes('refmeta G1 {"prState":"merged"}'));
  assert.ok(a.calls.includes("clearAttempts G1"), "the failed move falls back to direct cleanup");
  const b = mergeHarness({ completeThrows: true });
  await b.run({ kind: "merge", ref: "G1", stepId: "done", dedupKey: "merged:5" });
  assert.deepEqual(b.calls, ["fetch G1", 'refmeta G1 {"prState":"merged"}', "enter G1 done assign=false", "complete G1", "clearSummaries G1", 'refmeta G1 {"prState":"merged"}']);
});

// --- ci jobs (forge red CI): re-run once, then comment + bounce to code; fail-closed ---

test("ci attempt 1: re-runs the failed jobs only — no comment, no tracker move", async () => {
  const h = ciHarness();
  await h.run(ciJob(1));
  assert.deepEqual(h.calls, ["fetch 7", "prHead 5 7", "rerun 900"]);
  assert.deepEqual(h.comments, []);
  assert.deepEqual(h.advances, []);
  assert.equal(h.events[0].event, "ci_red");
  assert.equal(h.events[0].action, "rerun");
});

test("ci attempt 2 resting in review: log on the PR, review → changes → code, findings are trusted text only", async () => {
  const h = ciHarness();
  await h.run(ciJob(2));
  assert.equal(h.comments.length, 1);
  assert.equal(h.comments[0].n, 5);
  assert.equal(h.comments[0].log, LOG);
  assert.ok(!h.comments[0].body.includes(LOG));
  assert.deepEqual(h.advances, [{ ref: "7", stepId: "review", outcome: "changes", target: "code", reason: TRUSTED, findings: TRUSTED }]);
  const f = h.store.getFindings("7");
  assert.deepEqual(f, { target: "code", fromStep: "ci", text: TRUSTED });
  assert.ok(!JSON.stringify(f).includes("npm ERR"), "no log text reaches the rework prompt");
  assert.ok(h.events.some((e) => e.event === "ci_red" && e.action === "bounced" && e.target === "code"));
});

test("ci + forge.autoMerge: the bounce turns auto-merge off on the PR before moving the task", async () => {
  const h = ciHarness({ autoMerge: { tiers: ["low"] }, disable: async () => ({ status: "disabled" }) });
  const log = console.log;
  console.log = () => {};
  try {
    await h.run(ciJob(2));
  } finally {
    console.log = log;
  }
  assert.ok(h.calls.includes("disable 5"));
  assert.equal(h.advances.length, 1);
  assert.equal(h.advances[0].outcome, "changes");
  assert.ok(h.events.some((e) => e.event === "auto_merge_disabled" && e.pr === 5));
});

test("ci + forge.autoMerge: a disable that fails holds the task — no rework fires", async () => {
  const h = ciHarness({ autoMerge: { tiers: ["low"] }, disable: async () => { throw new Error("403"); } });
  const [log, err] = [console.log, console.error];
  console.log = console.error = () => {};
  try {
    await h.run(ciJob(2));
  } finally {
    [console.log, console.error] = [log, err];
  }
  assert.deepEqual(h.advances, [], "not bounced");
  assert.equal(h.store.getFindings("7"), undefined);
  assert.match(h.store.getHeld("7")?.reason ?? "", /could not turn off auto-merge/);
  assert.ok(h.events.some((e) => e.event === "auto_merge_failed"));
  assert.ok(h.events.some((e) => e.event === "blocked" && e.step === "review"));
});

test("ci: a re-run that can't start bounces straight away", async () => {
  const h = ciHarness({ rerunThrows: true });
  await h.run(ciJob(1));
  assert.equal(h.comments.length, 1);
  assert.equal(h.advances.length, 1);
  assert.equal(h.advances[0].outcome, "changes");
  assert.ok(h.advances[0].reason.startsWith("CI failed on abc1234"));
});

test("ci: code already at maxAttempts → the bounce becomes fail, `failed` emitted", async () => {
  const h = ciHarness();
  for (let i = 0; i < 3; i++) h.store.bumpAttempt("7", "code");
  await h.run(ciJob(2));
  assert.equal(h.advances.length, 1);
  assert.equal(h.advances[0].stepId, "review");
  assert.equal(h.advances[0].outcome, "fail");
  assert.match(h.advances[0].reason, /cap \(3\) on step "code"/);
  assert.ok(h.events.some((e) => e.event === "failed" && e.step === "review"));
  assert.equal(h.store.getAttempt("7", "code"), 0, "terminal fail clears the loop counters");
});

test("ci: stale sha, closed PR, no PR, PR lookup error, not ours, fetch error → nothing happens", async () => {
  for (const o of [
    { pr: { number: 5, sha: "newer00", open: true } },
    { pr: { number: 5, sha: SHA, open: false } },
    { pr: null },
    { prThrows: true },
    { assignedToUs: false },
    { fetchThrows: true },
  ]) {
    const h = ciHarness(o);
    await h.run(ciJob(2));
    assert.deepEqual(h.advances, [], JSON.stringify(o));
    assert.deepEqual(h.comments, [], JSON.stringify(o));
    assert.ok(!h.calls.some((c) => c.startsWith("rerun")), JSON.stringify(o));
    assert.deepEqual(h.events, [], JSON.stringify(o));
  }
});

test("ci: two red workflows on the same sha bounce once", async () => {
  const h = ciHarness();
  await h.run(ciJob(2));
  await h.run({ ...ciJob(2, { runId: 901 }), dedupKey: "ci:901:2" });
  assert.equal(h.advances.length, 1);
  assert.equal(h.comments.length, 2, "each red run still gets its log posted");
});

test("ci: task not downstream of code (resting in code, manual done, no stage) → comment only", async () => {
  for (const stage of ["agent:code", "agent:done", null]) {
    const h = ciHarness({ stage });
    await h.run(ciJob(2));
    assert.deepEqual(h.advances, [], String(stage));
    assert.equal(h.comments.length, 1);
    assert.ok(h.events.some((e) => e.event === "ci_red" && e.action === "skipped"));
  }
});

test("ci: a review run in flight parks the bounce; review's clean advance becomes changes → code", async () => {
  const h = ciHarness({ verdict: { outcome: "advance", reason: "LGTM" } });
  h.store.setRunning("7", { stepId: "review", startedAt: new Date().toISOString() });
  await h.run(ciJob(2));
  assert.deepEqual(h.advances, [], "no move while review runs");
  assert.ok(h.events.some((e) => e.event === "ci_red" && e.action === "deferred"));
  h.store.clearRunning("7");
  await h.run({ kind: "pipeline", ref: "7", stepId: "review", dedupKey: "step:review:7" });
  assert.equal(h.advances.length, 1);
  assert.equal(h.advances[0].stepId, "review");
  assert.equal(h.advances[0].outcome, "changes");
  assert.equal(h.advances[0].target, "code");
  assert.deepEqual(h.store.getFindings("7"), { target: "code", fromStep: "ci", text: TRUSTED });
  assert.equal(h.store.takeCiRed("7"), undefined, "parked bounce consumed");
});

test("ci: a parked bounce yields to review's own changes/hold/fail verdict", async () => {
  for (const verdict of [{ outcome: "hold", reason: "ask" }, { outcome: "fail", reason: "no" }, { outcome: "changes", reason: "nit", findings: "fix x" }]) {
    const h = ciHarness({ verdict });
    h.store.setRunning("7", { stepId: "review", startedAt: new Date().toISOString() });
    await h.run(ciJob(2));
    h.store.clearRunning("7");
    await h.run({ kind: "pipeline", ref: "7", stepId: "review", dedupKey: "step:review:7" });
    assert.equal(h.advances.length, 1);
    assert.equal(h.advances[0].outcome, verdict.outcome);
    assert.equal(h.advances[0].reason, verdict.reason);
    assert.equal(h.store.takeCiRed("7"), undefined);
  }
});

// --- forge.autoMerge wiring: the approving step's final advance reaches the forge, nothing else does ---

/** A forge stub recording enableAutoMerge calls. @param {any} [over] */
function autoMergeForge(over = {}) {
  /** @type {any[]} */
  const calls = [];
  return {
    calls,
    prHead: async () => ({ number: 7, sha: "abc", open: true }),
    enableAutoMerge: async (/** @type {number} */ pr, /** @type {any} */ o) => {
      calls.push([pr, o.method, o.expectedSha]);
      return { status: "enabled", readied: true };
    },
    ...over,
  };
}

const autoMergeSteps = [{ id: "code", kind: "implement" }, { id: "review", kind: "review" }, { id: "done", manual: true }];
const autoMergeCfg = { forge: { type: "github", autoMerge: { tiers: ["low"] } } };

/** Run steps with console.error muted. @param {() => Promise<void>} fn */
async function quietErrors(fn) {
  const err = console.error;
  console.error = () => {};
  try {
    await fn();
  } finally {
    console.error = err;
  }
}

test("dispatch: a review advance with an allowed tier enables auto-merge after the move; the code step's advance does not", async () => {
  const forge = autoMergeForge();
  const { runStep, events, advanced } = heldHarness({ steps: autoMergeSteps, forge, cfg: autoMergeCfg });
  await quietErrors(async () => {
    await runStep("code", { outcome: "advance", summary: { tier: "low" } }, undefined, { prompt: false });
    assert.deepEqual(forge.calls, [], "only the approving (review) step triggers it");
    await runStep("review", { outcome: "advance", summary: { tier: "low" } }, undefined, { prompt: false });
  });
  assert.deepEqual(forge.calls, [[7, "squash", "abc"]], "pinned to the head the review saw at its start");
  assert.deepEqual(advanced.at(-1), ["42", "review", "advance"], "the board move still happened");
  const e = events.find((x) => x.event === "auto_merge_enabled");
  assert.deepEqual([e?.pr, e?.tier, e?.method, e?.readied], [7, "low", "squash", true]);
});

test("dispatch: an approving advance without an allowed tier emits auto_merge_skipped, nothing else", async () => {
  const forge = autoMergeForge();
  const { runStep, events, advanced } = heldHarness({ steps: autoMergeSteps, forge, cfg: autoMergeCfg });
  await quietErrors(async () => {
    await runStep("review", { outcome: "advance", summary: { tier: "high" } }, undefined, { prompt: false });
  });
  assert.deepEqual(forge.calls, []);
  assert.deepEqual(advanced.at(-1), ["42", "review", "advance"]);
  const e = events.find((x) => x.event === "auto_merge_skipped");
  assert.deepEqual([e?.tier, e?.reason], ["high", 'tier "high" is not in [low]']);
});

test("dispatch: a changes verdict after approval turns auto-merge off BEFORE the move", async () => {
  /** @type {any[]} */
  const order = [];
  /** @type {any[]} */
  let moves = [];
  const forge = autoMergeForge({
    disableAutoMerge: async (/** @type {number} */ n) => {
      order.push(["disable", n, moves.length]);
      return { status: "disabled" };
    },
  });
  const qaSteps = [{ id: "code", kind: "implement" }, { id: "review", kind: "review" }, { id: "qa", kind: "qa" }, { id: "done", manual: true }];
  const { runStep, events, advanced } = heldHarness({ steps: qaSteps, forge, cfg: autoMergeCfg });
  moves = advanced;
  await quietErrors(async () => {
    await runStep("qa", { outcome: "changes", target: "code", reason: "broken" }, undefined, { prompt: false });
  });
  assert.deepEqual(order, [["disable", 7, 0]], "disabled while no move had happened yet");
  assert.deepEqual(advanced, [["42", "qa", "changes"]], "the bounce still moved the task");
  const e = events.find((x) => x.event === "auto_merge_disabled");
  assert.deepEqual([e?.pr, e?.reason], [7, "changes from qa"]);
});

test("dispatch: a disable that fails on a changes bounce holds the task instead of firing the rework", async () => {
  const forge = autoMergeForge({
    disableAutoMerge: async () => {
      throw new Error("Resource not accessible by integration");
    },
  });
  const qaSteps = [{ id: "code", kind: "implement" }, { id: "review", kind: "review" }, { id: "qa", kind: "qa" }, { id: "done", manual: true }];
  const { runStep, events, advanced, store } = heldHarness({ steps: qaSteps, forge, cfg: autoMergeCfg });
  await quietErrors(async () => {
    await runStep("qa", { outcome: "changes", target: "code", reason: "broken" }, undefined, { prompt: false });
  });
  assert.deepEqual(advanced, [["42", "qa", "hold"]], "held, not bounced to code");
  assert.equal(store.getFindings("42"), undefined, "no rework findings left behind");
  assert.match(store.getHeld("42")?.reason ?? "", /could not turn off auto-merge/);
  assert.ok(events.some((e) => e.event === "auto_merge_failed"));
  assert.ok(events.some((e) => e.event === "blocked"));
});

test("dispatch: a fail verdict turns auto-merge off too (the failure lane must not merge)", async () => {
  /** @type {number[]} */
  const off = [];
  const forge = autoMergeForge({ disableAutoMerge: async (/** @type {number} */ n) => (off.push(n), { status: "disabled" }) });
  const { runStep, events, advanced } = heldHarness({ steps: autoMergeSteps, forge, cfg: autoMergeCfg });
  await quietErrors(async () => {
    await runStep("review", { outcome: "fail", reason: "nope" }, undefined, { prompt: false });
  });
  assert.deepEqual(off, [7]);
  assert.deepEqual(advanced, [["42", "review", "fail"]]);
  assert.ok(events.some((e) => e.event === "auto_merge_disabled"));
});

test("dispatch: an auto-merge failure is an event only — the review still advances", async () => {
  const forge = autoMergeForge({
    enableAutoMerge: async () => {
      throw new Error("Auto merge is not allowed for this repository");
    },
  });
  const { runStep, events, advanced } = heldHarness({ steps: autoMergeSteps, forge, cfg: autoMergeCfg });
  await quietErrors(() => runStep("review", { outcome: "advance", summary: { tier: "low" } }, undefined, { prompt: false }).then(() => {}));
  assert.deepEqual(advanced.at(-1), ["42", "review", "advance"]);
  const e = events.find((x) => x.event === "auto_merge_failed");
  assert.deepEqual([e?.pr, e?.tier, e?.reason], [7, "low", "Auto merge is not allowed for this repository"]);
  assert.ok(!events.some((x) => x.event === "auto_merge_enabled"));
});
