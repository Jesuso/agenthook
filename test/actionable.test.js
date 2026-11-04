// `ah watch --actionable`'s classifier and summary (src/actionable.js): which events wake a supervisor.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isActionable, createSummary, summaryLine } from "../src/actionable.js";

test("isActionable: stop-the-line events wake; handled-by-the-receiver events don't", () => {
  const yes = [
    { event: "blocked", ref: "1" },
    { event: "failed", ref: "1" },
    { event: "move_refused", ref: "1" },
    { event: "auto_merge_failed", ref: "1" },
    { event: "auto_merge_skipped", ref: "1" },
    { e: "daemon_down", ref: "" },
    { event: "followup_due", ref: "1" },
    { event: "ci_red", ref: "1", action: "skipped" },
    { event: "ci_red", ref: "1" },
    { event: "auto_merge_disabled", ref: "1", tooLate: true },
    { event: "ci_green", ref: "1" },
  ];
  const no = [
    { event: "pipeline_done", ref: "1" },
    { event: "pipeline_done", ref: "1", awaitingMerge: true },
    { event: "followup_pending", ref: "1" },
    { event: "followup_done", ref: "1" },
    { event: "merged", ref: "1" },
    { event: "hold_cleared", ref: "1" },
    { event: "run_end", ref: "1" },
    { event: "auto_merge_enabled", ref: "1" },
    { event: "auto_merge_disabled", ref: "1" },
    { event: "ci_red", ref: "1", action: "rerun" },
    { event: "ci_red", ref: "1", action: "bounced" },
    { event: "ci_red", ref: "1", action: "deferred" },
  ];
  for (const e of yes) assert.equal(isActionable(e), true, JSON.stringify(e));
  for (const e of no) assert.equal(isActionable(e), false, JSON.stringify(e));
});

test("isActionable: --wake / --quiet override the built-in list by event type", () => {
  const o = { wake: new Set(["merged"]), quiet: new Set(["blocked"]) };
  assert.equal(isActionable({ event: "merged", ref: "1" }, null, o), true);
  assert.equal(isActionable({ event: "blocked", ref: "1" }, null, o), false);
  assert.equal(isActionable({ event: "failed", ref: "1" }, null, o), true);
  // quiet beats wake when both name the same type
  assert.equal(isActionable({ event: "merged", ref: "1" }, null, { wake: new Set(["merged"]), quiet: new Set(["merged"]) }), false);
});

test("isActionable: ci_green needs nobody when auto-merge is already on for that ref", () => {
  const refmeta = { 1: { autoMerge: { pr: 3, sha: "a" } }, 2: { pr: 4 } };
  assert.equal(isActionable({ event: "ci_green", ref: "1" }, refmeta), false);
  assert.equal(isActionable({ event: "ci_green", ref: "2" }, refmeta), true);
});

test("createSummary: counts per type, distinct refs, prefix for multi-profile; take() resets", () => {
  const s = createSummary();
  assert.equal(s.take(), null);
  s.add({ event: "merged", ref: "1" });
  s.add({ event: "pipeline_done", ref: "1" });
  s.add({ event: "pipeline_done", ref: "1" });
  s.add({ event: "pipeline_done", ref: "2" }, "p");
  const out = s.take();
  assert.deepEqual(out, { n: 4, byEvent: { merged: { n: 1, refs: ["1"] }, pipeline_done: { n: 3, refs: ["1", "p:2"] } } });
  assert.equal(summaryLine(/** @type {any} */ (out)), "skipped 4: merged 1 (1), pipeline_done 3 (1, p:2)");
  assert.equal(s.take(), null);
});

test("createSummary: refs cap at 20 per type, the count stays exact", () => {
  const s = createSummary();
  for (let i = 0; i < 25; i++) s.add({ event: "merged", ref: String(i) });
  const out = /** @type {any} */ (s.take());
  assert.equal(out.byEvent.merged.n, 25);
  assert.equal(out.byEvent.merged.refs.length, 20);
  assert.match(summaryLine(out), /, …\)$/);
});
