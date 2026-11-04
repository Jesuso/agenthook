import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// Approve with follow-up checks (src/followup.js): an allowed tier approves and records the
// checks, any other tier holds; `status`/`tick` list them; `followup done` clears them.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseFollowUp, followUpDecision, followUpTiers, pendingFollowUp, markFollowUpDone, MAX_FOLLOWUP_CHECKS, MAX_FOLLOWUP_CHARS } from "../src/followup.js";
import { createDispatcher, parseVerdict } from "../src/dispatch.js";
import { createStore } from "../src/store.js";
import { registryDir } from "../src/config.js";
import { readStatus } from "../src/agent-api.js";
import { readProfile } from "../src/heartbeat.js";
import { followup } from "../src/commands/followup.js";

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "agenthook-followup-"));
const cfgWith = (/** @type {any} */ extra = {}) => /** @type {any} */ ({ pipeline: [{ id: "code", createsWorktree: true }, { id: "review", kind: "review" }, { id: "done", manual: true }], ...extra });
const approve = (/** @type {any} */ v) => /** @type {any} */ ({ outcome: "advance", ...v });

test("parseFollowUp: non-empty strings, whitespace collapsed, capped in count and length; anything else drops", () => {
  assert.deepEqual(parseFollowUp(["  check  the\nlog ", "", 3, "metric up"]), ["check the log", "metric up"]);
  assert.equal(parseFollowUp("check"), undefined);
  assert.equal(parseFollowUp([]), undefined);
  assert.equal(parseFollowUp(["", "  "]), undefined);
  assert.equal(parseFollowUp(Array.from({ length: 15 }, (_, i) => `c${i}`))?.length, MAX_FOLLOWUP_CHECKS);
  const long = /** @type {string[]} */ (parseFollowUp(["x".repeat(1000)]));
  assert.equal(long[0].length, MAX_FOLLOWUP_CHARS);
  assert.ok(long[0].endsWith("…"));
});

test("parseVerdict: followUp only rides an advance", () => {
  assert.deepEqual(parseVerdict(0, JSON.stringify({ outcome: "advance", followUp: ["a"] })).followUp, ["a"]);
  assert.equal("followUp" in parseVerdict(0, JSON.stringify({ outcome: "hold", followUp: ["a"] })), false);
  assert.equal("followUp" in parseVerdict(0, JSON.stringify({ outcome: "advance" })), false, "absent, not undefined: existing verdict shapes are unchanged");
});

test("followUpDecision: low/medium approve and record; high or no tier holds naming the checks", () => {
  const cfg = cfgWith();
  assert.equal(followUpDecision(cfg, "review", approve({}), {}), null);
  assert.equal(followUpDecision(cfg, "review", { outcome: "hold", followUp: ["a"] }, {}), null);
  assert.deepEqual(followUpDecision(cfg, "review", approve({ followUp: ["a"], summary: { tier: " Medium " } })), { record: true, checks: ["a"], tier: "medium" });
  const high = /** @type {any} */ (followUpDecision(cfg, "review", approve({ followUp: ["metric x stays flat", "no new errors"], summary: { tier: "high" } })));
  assert.equal(high.tier, "high");
  assert.equal(high.hold, "follow-up checks on a high-risk change need a human yes before merge: metric x stays flat; no new errors");
  const unrated = /** @type {any} */ (followUpDecision(cfg, "review", approve({ followUp: ["a"] })));
  assert.match(unrated.hold, /risk-unrated/);
});

test("followUpDecision: forge.autoMerge.tiers decides which tiers approve; tierFrom supplies a missing tier", () => {
  const cfg = cfgWith({ forge: { type: "github", autoMerge: { tiers: ["low"], tierFrom: "review", step: "qa" } }, pipeline: [{ id: "code", createsWorktree: true }, { id: "review", kind: "review" }, { id: "qa" }, { id: "done", manual: true }] });
  assert.deepEqual(followUpTiers(cfg), ["low"]);
  assert.ok("hold" in /** @type {any} */ (followUpDecision(cfg, "qa", approve({ followUp: ["a"], summary: { tier: "medium" } }))));
  const summaries = /** @type {any} */ ({ review: { outcome: "advance", summary: { tier: "low" } } });
  assert.deepEqual(followUpDecision(cfg, "qa", approve({ followUp: ["a"] }), summaries), { record: true, checks: ["a"], tier: "low" });
  // One tier per ticket: qa's own `summary.tier` is ignored when review is the tier source, both ways.
  assert.deepEqual(followUpDecision(cfg, "qa", approve({ followUp: ["a"], summary: { tier: "high" } }), summaries), { record: true, checks: ["a"], tier: "low" });
  const highFrom = /** @type {any} */ ({ review: { outcome: "advance", summary: { tier: "high" } } });
  assert.ok("hold" in /** @type {any} */ (followUpDecision(cfg, "qa", approve({ followUp: ["a"], summary: { tier: "low" } }), highFrom)), "a reviewer cannot re-rate a high ticket low");
  const notApproved = /** @type {any} */ ({ review: { outcome: "hold", summary: { tier: "low" } } });
  assert.ok("hold" in /** @type {any} */ (followUpDecision(cfg, "qa", approve({ followUp: ["a"] }), notApproved)));
});

test("pendingFollowUp + markFollowUpDone: oldest first, labelled; done clears it and emits; nothing recorded throws", () => {
  const dir = tmpDir();
  const store = createStore(dir);
  store.setRefMeta("2", { title: "two", displayId: "#2", pr: 7, followUp: { checks: ["b"], tier: "low", step: "review", at: "2026-01-02T00:00:00.000Z" } });
  store.setRefMeta("1", { followUp: { checks: ["a"], tier: "medium", step: "review", at: "2026-01-01T00:00:00.000Z", pr: 3 } });
  store.setRefMeta("3", { title: "none" });
  assert.deepEqual(pendingFollowUp(store.listRefMeta()), [
    { ref: "1", checks: ["a"], tier: "medium", step: "review", pr: 3, since: "2026-01-01T00:00:00.000Z" },
    { ref: "2", checks: ["b"], tier: "low", step: "review", pr: 7, since: "2026-01-02T00:00:00.000Z", title: "two", id: "#2" },
  ]);
  /** @type {any[]} */
  const events = [];
  const emit = (/** @type {string} */ event, /** @type {string} */ ref, /** @type {string} */ step, /** @type {any} */ extra) => events.push({ event, ref, step, ...extra });
  assert.deepEqual(markFollowUpDone(store, emit, "1"), { ref: "1", done: ["a"] });
  assert.equal(store.getRefMeta("1").followUp, undefined);
  assert.deepEqual(events, [{ event: "followup_done", ref: "1", step: "review", n: 1, detail: "a", by: "operator" }]);
  assert.throws(() => markFollowUpDone(store, emit, "3"), /3 has no follow-up checks recorded/);
});

// --- through the dispatcher: a fake agent writes the review verdict ---

/** @param {any} verdict @param {any} [extra] */
function reviewHarness(verdict, extra = {}) {
  const dir = tmpDir();
  const bin = path.join(dir, "fake-claude.sh");
  fs.writeFileSync(bin, `#!/bin/sh\nprintf '%s' '${JSON.stringify(verdict)}' > "$AGENTHOOK_VERDICT_FILE"\n`, { mode: 0o755 });
  const cfg = /** @type {any} */ ({
    pipeline: [{ id: "code" }, { id: "review", kind: "review" }, { id: "done", manual: true }],
    claudeBin: bin,
    repoPath: dir,
    worktreePrefix: path.join(dir, "wt"),
    dataDir: dir,
    logDir: dir,
    instructionsFile: path.join(dir, "none.md"),
    ...extra,
  });
  const store = createStore(dir);
  /** @type {any[]} */
  const advanced = [];
  /** @type {any[]} */
  const events = [];
  const adapter = /** @type {any} */ ({
    describe: () => ({ platform: "GitHub", taskNoun: "issue", trigger: "@agent", commentHowTo: "comment" }),
    fetchTask: async (/** @type {string} */ ref) => ({ ref, name: "t", url: "u", completed: false, assignedToUs: true }),
    advance: async (/** @type {string} */ ref, /** @type {string} */ stepId, /** @type {any} */ v) => advanced.push([ref, stepId, v.outcome]),
  });
  const emit = (/** @type {string} */ event, /** @type {string} */ ref, /** @type {string} */ step, /** @type {any} */ x) => events.push({ event, ref, step, ...x });
  const run = createDispatcher(cfg, adapter, undefined, store, emit);
  const go = async () => {
    const log = console.log;
    console.log = () => {};
    try {
      return await run({ kind: "pipeline", ref: "42", stepId: "review", dedupKey: `k:${Date.now()}:${Math.random()}` });
    } finally {
      console.log = log;
    }
  };
  return { store, advanced, events, go };
}

test("dispatch: a low-tier approval with follow-up checks advances and records them (followup_pending)", async () => {
  const h = reviewHarness({ outcome: "advance", summary: { tier: "low" }, followUp: ["error rate unchanged once live"] });
  h.store.setRefMeta("42", { pr: 5 });
  await h.go();
  assert.deepEqual(h.advanced, [["42", "review", "advance"]]);
  const rec = h.store.getRefMeta("42").followUp;
  assert.deepEqual({ ...rec, at: "x" }, { checks: ["error rate unchanged once live"], tier: "low", step: "review", at: "x", pr: 5 });
  const ev = h.events.find((e) => e.event === "followup_pending");
  assert.deepEqual({ ...ev }, { event: "followup_pending", ref: "42", step: "review", tier: "low", n: 1, detail: "error rate unchanged once live", pr: 5, name: "t", url: "u" });
  assert.equal(h.store.getHeld("42"), undefined);
  // No forge: no merge event will ever come, so the checks are due at approval.
  const due = h.events.find((e) => e.event === "followup_due");
  assert.deepEqual({ ...due }, { event: "followup_due", ref: "42", step: "review", n: 1, detail: "error rate unchanged once live", pr: 5, name: "t", url: "u" });
});

test("dispatch: with a forge, followup_due waits for the merge (only followup_pending at approval)", async () => {
  const h = reviewHarness({ outcome: "advance", summary: { tier: "low" }, followUp: ["a"] }, { forge: { type: "github" } });
  await h.go();
  assert.deepEqual(h.advanced, [["42", "review", "advance"]]);
  assert.ok(h.events.some((e) => e.event === "followup_pending"));
  assert.ok(!h.events.some((e) => e.event === "followup_due"), "due fires on `merged`, not at approval");
});

test("dispatch: a high-tier approval with follow-up checks holds instead, naming them; nothing recorded", async () => {
  const h = reviewHarness({ outcome: "advance", summary: { tier: "high" }, followUp: ["payments settle"] });
  await h.go();
  assert.deepEqual(h.advanced, [["42", "review", "hold"]]);
  assert.match(h.store.getHeld("42").reason, /high-risk change need a human yes before merge: payments settle/);
  assert.ok(h.events.some((e) => e.event === "blocked" && /payments settle/.test(e.reason)));
  assert.equal(h.store.getRefMeta("42")?.followUp, undefined);
});

test("dispatch: a bounce withdraws recorded checks; the same step approving without checks drops them too", async () => {
  const bounce = reviewHarness({ outcome: "changes", target: "code", reason: "fix" });
  bounce.store.setRefMeta("42", { followUp: { checks: ["a"], tier: "low", step: "review", at: "x" } });
  await bounce.go();
  assert.equal(bounce.store.getRefMeta("42").followUp, undefined);
  const plain = reviewHarness({ outcome: "advance", summary: { tier: "low" } });
  plain.store.setRefMeta("42", { followUp: { checks: ["a"], tier: "low", step: "review", at: "x" } });
  await plain.go();
  assert.equal(plain.store.getRefMeta("42").followUp, undefined);
});

// --- read side: status + the CLI (a stopped profile in the isolated registry) ---

test("status lists followUp; `followup` lists and (receiver down) clears on the state dir", async () => {
  const dir = path.join(registryDir, "pd");
  fs.mkdirSync(path.join(dir, "logs"), { recursive: true });
  fs.writeFileSync(path.join(dir, "heartbeat.json"), JSON.stringify({ name: "pd", maxConcurrent: 1, tracker: "github" }));
  fs.writeFileSync(path.join(dir, "events.jsonl"), "");
  createStore(dir).setRefMeta("9", { displayId: "#9", followUp: { checks: ["check the dashboard"], tier: "low", step: "review", at: "2026-01-01T00:00:00.000Z", pr: 4 } });
  const s = /** @type {any} */ (readStatus(readProfile("pd")));
  assert.deepEqual(s.followUp, [{ id: "#9", ref: "9", checks: ["check the dashboard"], tier: "low", pr: 4, since: "2026-01-01T00:00:00.000Z" }]);

  const out = [];
  const log = console.log;
  console.log = (...a) => out.push(a.join(" "));
  try {
    await followup({ _: ["list", "pd"] });
    await followup({ _: ["done", "9", "pd"] });
    await followup({ _: ["pd"], json: true });
  } finally {
    console.log = log;
  }
  assert.equal(process.exitCode ?? 0, 0);
  assert.deepEqual(out, ["#9 PR#4 tier=low since 2026-01-01T00:00:00.000Z", "  - check the dashboard", "9: follow-up checks marked verified (1)", "[]"]);
  assert.match(fs.readFileSync(path.join(dir, "events.jsonl"), "utf8"), /"event":"followup_done","ref":"9"/);
  assert.equal(/** @type {any} */ (readStatus(readProfile("pd"))).followUp, undefined);
});
