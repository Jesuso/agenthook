import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// `ah ui` view model — buildRows' PR/board-done lifecycle: prState, finishedAt, prNeeds,
// what counts as a re-run (isRerunEvent/lastRerunAt), dismiss/cancel, and the queue-derived
// fields (failReason, reasonHarness, queuePos, queuedAt) around them.
import test from "node:test";
import assert from "node:assert/strict";
import { buildRows, isRerunEvent, lastRerunAt } from "../src/ui/rows.js";
import { isNeedsYou, ticketBucket } from "../src/epics.js";
import { state, row } from "./_ui-rows-helpers.js";

test("buildRows: an operator cancel reads cancelled, not failed; dismissed clears failed/cancelled; a re-run supersedes it", () => {
  const rows = buildRows(
    "p",
    state({
      events: [
        { ts: "1", event: "failed", ref: "c", step: "triage", reason: "cancelled by operator" },
        { ts: "2", event: "failed", ref: "f", step: "code", reason: "exit 1" },
        { ts: "3", event: "failed", ref: "fd", step: "code", reason: "exit 1" },
        { ts: "4", event: "dismissed", ref: "fd", step: "", by: "operator" },
        { ts: "5", event: "failed", ref: "cd", step: "code", reason: "cancelled by operator" },
        { ts: "6", event: "dismissed", ref: "cd", step: "", by: "operator" },
        { ts: "7", event: "dismissed", ref: "dn", step: "" },
        { ts: "8", event: "pipeline_done", ref: "dn", step: "done" },
        { ts: "8", event: "board_done", ref: "dn", step: "" },
        { ts: "9", event: "failed", ref: "again", step: "code", reason: "exit 1" },
        { ts: "10", event: "dismissed", ref: "again", step: "" },
        { ts: "11", event: "failed", ref: "again", step: "code", reason: "exit 2" },
      ],
    }),
  );
  assert.equal(row(rows, "c").status, "cancelled");
  assert.equal(row(rows, "f").status, "failed");
  assert.equal(row(rows, "fd").status, "idle");
  assert.equal(row(rows, "cd").status, "idle");
  assert.equal(row(rows, "dn").status, "done", "dismiss never touches a done ticket");
  assert.equal(row(rows, "again").status, "failed", "a failure after a dismiss counts again");
});

test("buildRows: prState is a PR fact whatever the status; finishedAt is the first board-done signal; a re-run clears both", () => {
  const rows = buildRows(
    "p",
    state({
      refmeta: { ready: { pr: 1 }, merged: { pr: 2 }, "merge-only": { pr: 3 }, rerun: { pr: 4 }, running: { pr: 5 } },
      running: { running: { stepId: "code", startedAt: "t" } },
      events: [
        { ts: "2026-10-08T09:00:00.000Z", event: "pipeline_done", ref: "ready", step: "done" },
        { ts: "2026-10-08T09:00:00.000Z", event: "board_done", ref: "ready", step: "" },
        { ts: "2026-10-08T09:00:01.000Z", event: "board_done", ref: "ready", step: "done", via: "flag" },
        { ts: "2026-10-08T07:00:00.000Z", event: "run_start", ref: "merged", step: "code" },
        { ts: "2026-10-08T08:00:00.000Z", event: "board_done", ref: "merged", step: "", via: "flag" },
        { ts: "2026-10-08T10:00:00.000Z", event: "merged", ref: "merged", step: "" },
        { ts: "2026-10-08T07:00:00.000Z", event: "merged", ref: "merge-only", step: "" },
        { ts: "2026-10-08T06:00:00.000Z", event: "pipeline_done", ref: "rerun", step: "done" },
        { ts: "2026-10-08T06:00:00.000Z", event: "board_done", ref: "rerun", step: "" },
        { ts: "2026-10-08T06:30:00.000Z", event: "merged", ref: "rerun", step: "" },
        { ts: "2026-10-08T07:00:00.000Z", event: "run_start", ref: "rerun", step: "code" },
        { ts: "2026-10-08T07:30:00.000Z", event: "failed", ref: "bad", step: "code", reason: "tests red" },
        { ts: "2026-10-08T07:30:00.000Z", event: "pipeline_done", ref: "nopr", step: "done" },
        { ts: "2026-10-08T07:30:00.000Z", event: "board_done", ref: "nopr", step: "" },
      ],
    }),
  );
  /** @param {string} ref */
  const facts = (ref) => [row(rows, ref).status, row(rows, ref).prState, row(rows, ref).finishedAt];
  // the done stays the first signal's ts: a stage + flag pair or a later merge doesn't move it
  assert.deepEqual(facts("ready"), ["done", "ready", "2026-10-08T09:00:00.000Z"]);
  assert.deepEqual(facts("merged"), ["done", "merged", "2026-10-08T08:00:00.000Z"]);
  assert.deepEqual(facts("merge-only"), ["idle", "merged", null], "a merge is a PR fact, not done");
  assert.deepEqual(facts("rerun"), ["idle", "ready", null], "the re-run voids the done and the merge; the PR itself stays");
  assert.deepEqual(facts("running"), ["running", "ready", null], "an open PR shows while running too");
  assert.deepEqual(facts("bad"), ["failed", null, null]);
  assert.deepEqual(facts("nopr"), ["done", null, "2026-10-08T07:30:00.000Z"], "no PR → prState null");
});

test("buildRows: board_done gives done and outranks a held entry and a failed event, never running/queued", () => {
  const done = (/** @type {string} */ ref, via = "flag") => ({ ts: "2026-10-08T09:00:00.000Z", event: "board_done", ref, step: "", via });
  const run = (/** @type {string} */ ref) => ({ ts: "2026-10-08T08:00:00.000Z", event: "run_start", ref, step: "code" });
  const rows = buildRows(
    "p",
    state({
      running: { r: { stepId: "code", startedAt: "t" } },
      queue: [{ kind: "pipeline", ref: "q", stepId: "code", dedupKey: "k" }],
      held: { h: { stepId: "code", reason: "which db?", heldAt: "t" }, r: { stepId: "code" }, q: { stepId: "code" } },
      events: [
        run("h"), done("h"),
        run("f"), { ts: "2026-10-08T08:30:00.000Z", event: "failed", ref: "f", step: "code", reason: "x" }, done("f"),
        run("f2"), done("f2"), { ts: "2026-10-08T09:30:00.000Z", event: "failed", ref: "f2", step: "code", reason: "late" },
        run("r"), done("r"),
        run("q"), done("q"),
      ],
    }),
  );
  assert.equal(row(rows, "h").status, "done");
  assert.equal(row(rows, "h").heldReason, "which db?", "the stale hold is still recorded, it just doesn't win");
  assert.equal(row(rows, "f").status, "done");
  assert.equal(row(rows, "f").failReason, null, "no fail reason on a done row");
  assert.equal(row(rows, "f2").status, "done", "a failed event after the done doesn't undo the board");
  assert.equal(row(rows, "r").status, "running");
  assert.equal(row(rows, "q").status, "queued");
  assert.equal(row(rows, "q").finishedAt, null);
});

test("buildRows: a re-run (run_start, or a pipeline job's enqueued) clears board-done", () => {
  const done = (/** @type {string} */ ref) => ({ ts: "1", event: "board_done", ref, step: "", via: "flag" });
  const rows = buildRows(
    "p",
    state({
      events: [
        { ts: "0", event: "run_start", ref: "a", step: "code" }, done("a"), { ts: "2", event: "run_start", ref: "a", step: "code" },
        { ts: "0", event: "run_start", ref: "b", step: "code" }, done("b"), { ts: "2", event: "enqueued", ref: "b", step: "code", kind: "pipeline" },
        { ts: "0", event: "run_start", ref: "c", step: "code" }, done("c"), { ts: "2", event: "enqueued", ref: "c", step: "", kind: "ci" },
      ],
    }),
  );
  assert.equal(row(rows, "a").status, "idle");
  assert.equal(row(rows, "b").status, "idle");
  assert.equal(row(rows, "c").status, "done", "a CI job is not a re-run");
});

test("buildRows: prNeeds — the PR reasons where code and board disagree, only with a prUrl, on a done or known-open idle row", () => {
  const ran = (/** @type {string} */ ref) => [
    { ts: "1", event: "run_start", ref, step: "code" },
    { ts: "2", event: "run_end", ref, step: "code", outcome: "advance" },
  ];
  const rows = buildRows(
    "p",
    state({
      refmeta: {
        await: { pr: 1 }, mergedOpen: { pr: 2 }, closed: { pr: 3, prState: "closed" }, onDone: { pr: 4 }, mergedDone: { pr: 5, prState: "merged" },
        held: { pr: 6 }, failed: { pr: 7 }, running: { pr: 8 }, old: { pr: 9, prState: "merged" }, oldOpen: { pr: 10 }, nopr: {},
      },
      held: { held: { stepId: "code" } },
      running: { running: { stepId: "code" } },
      events: [
        ...ran("await"),
        ...ran("mergedOpen"), { ts: "3", event: "merged", ref: "mergedOpen", step: "" },
        ...ran("closed"),
        ...ran("onDone"), { ts: "3", event: "board_done", ref: "onDone", step: "done", via: "flag" },
        ...ran("mergedDone"), { ts: "3", event: "board_done", ref: "mergedDone", step: "", via: "flag" },
        ...ran("held"),
        ...ran("failed"), { ts: "3", event: "failed", ref: "failed", step: "code", reason: "x" },
        ...ran("running"),
        { ts: "3", event: "ci_green", ref: "oldOpen" }, // in the tail, but its last run isn't
        ...ran("nopr"),
      ],
    }),
    { repository: "o/r" },
  );
  /** @type {Record<string, string|null>} */
  const want = {
    await: "awaitingMerge", mergedOpen: "mergedOpen", closed: "closedUnmerged", onDone: "openOnDone", mergedDone: null,
    held: null, failed: null, running: null, old: null, oldOpen: null, nopr: null,
  };
  for (const [ref, prNeeds] of Object.entries(want)) assert.equal(row(rows, ref).prNeeds, prNeeds, ref);
  assert.equal(row(rows, "old").status, "idle");
  assert.equal(row(rows, "old").prState, "merged", "an idle row with no tail events keeps its PR fact, but no reason");
  // no repository → no prUrl → no reason, whatever the PR fact says
  assert.equal(buildRows("p", state({ refmeta: { a: { pr: 1 } }, events: ran("a") })).find((r) => r.ref === "a")?.prNeeds, null);
});

test("buildRows: a dismissed since the last re-run nulls prNeeds (both isNeedsYou false); a later run_start / pipeline enqueued brings it back (#598)", () => {
  const ran = (/** @type {string} */ ref) => [
    { ts: "1", event: "run_start", ref, step: "code" },
    { ts: "2", event: "run_end", ref, step: "code", outcome: "advance" },
  ];
  const dismissed = (/** @type {string} */ ref) => ({ ts: "3", event: "dismissed", ref, step: "", by: "operator" });
  const rows = buildRows(
    "p",
    state({
      refmeta: { open: { pr: 1, prState: "merged" }, done: { pr: 2 }, back: { pr: 3 }, enq: { pr: 4 }, merge: { pr: 5 } },
      events: [
        ...ran("open"), dismissed("open"),
        ...ran("done"), { ts: "3", event: "board_done", ref: "done", step: "", via: "flag" }, dismissed("done"),
        ...ran("back"), dismissed("back"), { ts: "4", event: "run_start", ref: "back", step: "code" }, { ts: "5", event: "run_end", ref: "back", step: "code", outcome: "advance" },
        ...ran("enq"), dismissed("enq"), { ts: "4", event: "enqueued", ref: "enq", step: "code", kind: "pipeline" },
        ...ran("merge"), dismissed("merge"), { ts: "4", event: "enqueued", ref: "merge", step: "done", kind: "merge" }, // not a re-run
      ],
    }),
    { repository: "o/r" },
  );
  assert.equal(row(rows, "open").prNeeds, null, "mergedOpen dismissed");
  assert.equal(row(rows, "open").status, "idle");
  assert.equal(row(rows, "done").prNeeds, null, "openOnDone dismissed");
  assert.equal(row(rows, "done").status, "done", "dismiss never touches the board's done");
  assert.equal(isNeedsYou(row(rows, "open"), true), false);
  assert.equal(isNeedsYou(row(rows, "done"), true), false);
  assert.equal(row(rows, "back").prNeeds, "awaitingMerge", "a run_start after the dismiss brings it back");
  assert.equal(row(rows, "enq").prNeeds, "awaitingMerge", "a pipeline enqueued after the dismiss resets it");
  assert.equal(row(rows, "merge").prNeeds, null, "a merge job's enqueued is not a re-run");
});

test("isRerunEvent / lastRerunAt: run_start and a pipeline enqueued are re-runs; a CI/merge enqueued is not", () => {
  const events = [
    { ts: "1", event: "run_start", ref: "a", step: "code" },
    { ts: "2", event: "enqueued", ref: "a", step: "code", kind: "pipeline" },
    { ts: "3", event: "enqueued", ref: "a", step: "done", kind: "merge" },
    { ts: "4", event: "enqueued", ref: "a", step: "" }, // legacy, no kind, empty step → not pipeline
    { ts: "5", event: "run_start", ref: "b", step: "code" },
  ];
  assert.equal(lastRerunAt(events, "a"), "2");
  assert.equal(lastRerunAt(events, "b"), "5");
  assert.equal(lastRerunAt(events, "none"), null);
  assert.equal(isRerunEvent({ event: "enqueued", step: "code" }), true, "legacy pipeline enqueued (no kind, a step)");
});

test("buildRows: refmeta.prState merged/closed overrides an event-derived ready; absent → still ready", () => {
  const done = (/** @type {string} */ ref) => ({ ts: "2026-10-08T09:00:00.000Z", event: "board_done", ref, step: "" });
  const rows = buildRows(
    "p",
    state({
      refmeta: { m: { pr: 1, prState: "merged" }, c: { pr: 2, prState: "closed" }, r: { pr: 3 }, odd: { pr: 4, prState: "weird" }, idle: { pr: 5, prState: "merged" } },
      events: ["m", "c", "r", "odd"].flatMap((ref) => [{ ts: "2026-10-08T08:00:00.000Z", event: "run_start", ref, step: "code" }, done(ref)]),
    }),
  );
  assert.deepEqual(["m", "c", "r", "odd"].map((ref) => row(rows, ref).prState), ["merged", "closed", "ready", "ready"]);
  assert.equal(row(rows, "m").status, "done");
  assert.equal(row(rows, "idle").prState, "merged", "a finish that left the events tail keeps its learned merge");
  assert.equal(row(rows, "idle").status, "idle");
});

test("buildRows: refmeta.prState closed overrides an event-derived merged too — the override is unconditional", () => {
  const rows = buildRows(
    "p",
    state({
      refmeta: { T1: { pr: 1, prState: "closed" } },
      events: [
        { ts: "1", event: "pipeline_done", ref: "T1", step: "done" },
        { ts: "1", event: "board_done", ref: "T1", step: "" },
        { ts: "2", event: "merged", ref: "T1", step: "" },
      ],
    }),
  );
  assert.equal(row(rows, "T1").prState, "closed", "refmeta wins even though the events alone say merged");
});

test("buildRows: a CI job's enqueued (kind ci) does not reset a finished ticket's state; a merged PR wins via refmeta", () => {
  const rows = buildRows(
    "p",
    state({
      refmeta: { T1: { pr: 42, prState: "merged" } },
      events: [
        { ts: "1", event: "pipeline_done", ref: "T1", step: "review" },
        { ts: "1", event: "board_done", ref: "T1", step: "review" },
        { ts: "2", event: "enqueued", ref: "T1", step: "", kind: "ci" },
        { ts: "3", event: "ci_red", ref: "T1", step: "", action: "rerun" },
        { ts: "4", event: "enqueued", ref: "T1", step: "", kind: "ci" },
        { ts: "5", event: "ci_red", ref: "T1", step: "", action: "skipped" },
        { ts: "6", event: "ci_green", ref: "T1" },
      ],
    }),
  );
  const t1 = row(rows, "T1");
  assert.equal(t1.status, "done");
  assert.equal(t1.prState, "merged");
  // a completed ticket with this row lands in the epic's one "done" bucket, not "Awaiting merge"
  assert.equal(t1.prNeeds, null);
  assert.equal(ticketBucket({ ref: "T1", completed: true, stage: null }, t1, [], false), "done");
});

test("buildRows: a pipeline job's enqueued (kind pipeline, or no kind with a non-empty step) still resets terminal state", () => {
  const rows = buildRows(
    "p",
    state({
      events: [
        { ts: "1", event: "pipeline_done", ref: "tagged", step: "review" },
        { ts: "1", event: "board_done", ref: "tagged", step: "review" },
        { ts: "2", event: "enqueued", ref: "tagged", step: "review", kind: "pipeline" },
        { ts: "1", event: "pipeline_done", ref: "legacy", step: "review" },
        { ts: "1", event: "board_done", ref: "legacy", step: "review" },
        { ts: "2", event: "enqueued", ref: "legacy", step: "review" },
      ],
    }),
  );
  assert.equal(row(rows, "tagged").status, "idle");
  assert.equal(row(rows, "legacy").status, "idle");
});

test("buildRows: failReason only while failed/cancelled; queuePos is the place in queue.json", () => {
  const rows = buildRows(
    "p",
    state({
      queue: [
        { kind: "pipeline", ref: "q0", stepId: "code", dedupKey: "a" },
        { kind: "pipeline", ref: "q1", stepId: "code", dedupKey: "b" },
      ],
      events: [
        { ts: "1", event: "failed", ref: "f", step: "code", reason: "tests red" },
        { ts: "2", event: "failed", ref: "c", step: "code", reason: "cancelled by operator" },
        { ts: "3", event: "failed", ref: "d", step: "code", reason: "x" },
        { ts: "4", event: "dismissed", ref: "d", step: "" },
      ],
    }),
  );
  assert.equal(row(rows, "f").failReason, "tests red");
  assert.equal(row(rows, "c").failReason, "cancelled by operator");
  assert.equal(row(rows, "d").failReason, null); // dismissed → idle
  assert.equal(row(buildRows("p", state({ held: { h: { stepId: "triage", reason: "?", heldAt: "2026-10-08T07:00:00Z" } } })), "h").heldAt, "2026-10-08T07:00:00Z");
  assert.deepEqual([row(rows, "q0").queuePos, row(rows, "q1").queuePos, row(rows, "f").queuePos], [0, 1, null]);
});

test("buildRows: reasonHarness from held.json while held, from the last failed event while failed/cancelled, reset on a re-run (#706)", () => {
  const held = state({ held: { h: { stepId: "code", reason: "which db?", harness: "local", heldAt: "t" }, h2: { stepId: "code", reason: "no harness here", heldAt: "t" } } });
  const rows = buildRows("p", held);
  assert.equal(row(rows, "h").reasonHarness, "local");
  assert.equal(row(rows, "h2").reasonHarness, null);

  const failed = state({
    events: [
      { ts: "1", event: "failed", ref: "f", step: "code", reason: "tests red", harness: "cloud" },
      { ts: "2", event: "run_start", ref: "f", step: "code" },
      { ts: "3", event: "failed", ref: "f", step: "code", reason: "red again" },
    ],
  });
  const fRows = buildRows("p", failed);
  assert.equal(row(fRows, "f").reasonHarness, null, "the re-run's failure named no harness, dropping the earlier one");

  const stillFailing = state({
    events: [{ ts: "1", event: "failed", ref: "g", step: "code", reason: "tests red", harness: "cloud" }],
  });
  assert.equal(row(buildRows("p", stillFailing), "g").reasonHarness, "cloud");
});

test("buildRows: queuedAt comes from the queue entry while queued; null otherwise and for a legacy entry with no stamp", () => {
  const rows = buildRows(
    "p",
    state({
      queue: [
        { kind: "pipeline", ref: "q0", stepId: "code", dedupKey: "a", queuedAt: "2026-10-08T07:00:00Z" },
        { kind: "pipeline", ref: "q1", stepId: "code", dedupKey: "b" }, // legacy: no stamp
      ],
      events: [{ ts: "1", event: "failed", ref: "f", step: "code", reason: "x" }],
    }),
  );
  assert.equal(row(rows, "q0").queuedAt, "2026-10-08T07:00:00Z");
  assert.equal(row(rows, "q1").queuedAt, null);
  assert.equal(row(rows, "f").queuedAt, null);
});
