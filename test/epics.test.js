import "./_setup.js";
// Pure stats over an epic + its tickets: bucket precedence, needs-you, velocity, ETA.
import test from "node:test";
import assert from "node:assert/strict";
import { EPIC_REF_RE, epicDetail, epicStats, isNeedsYou, localEpics, ticketBucket } from "../src/epics.js";
import { buildRows } from "../src/ui/rows.js";

const NOW = Date.parse("2026-10-15T18:00:00Z"); // UTC, tzOffset 0 unless noted

/** @param {Partial<import('../src/ui/contract.js').TicketRow>} o */
function row(o) {
  return { profile: "p", ref: "1", displayId: "1", title: null, summary: null, step: null, status: "idle", model: null, startedAt: null, costUsd: 0, trackerUrl: null, prUrl: null, heldReason: null, heldAt: null, failReason: null, prState: null, prNeeds: null, finishedAt: null, queuePos: null, epic: null, ...o };
}

/** @param {Partial<import('../src/types.js').EpicTicket>} o */
function ticket(o) {
  return { ref: "1", name: "t", completed: false, stage: "To do", ...o };
}

const epic = { ref: "E1", name: "Epic One", url: "https://x/epic/1", displayId: "E1", status: "In progress", completed: false };

/** @param {string} ts @param {string} event @param {any} x */
const ev = (ts, event, x = {}) => ({ ts, event, ref: "1", step: "s", ...x });

test("isNeedsYou: held/failed always; a PR reason (prNeeds) only with forge", () => {
  assert.equal(isNeedsYou(row({ status: "held" }), false), true);
  assert.equal(isNeedsYou(row({ status: "failed" }), false), true);
  assert.equal(isNeedsYou(row({ status: "done", prState: "ready", prUrl: "https://x/pull/1", prNeeds: "openOnDone" }), true), true);
  assert.equal(isNeedsYou(row({ status: "done", prState: "ready", prUrl: "https://x/pull/1", prNeeds: "openOnDone" }), false), false);
  for (const prNeeds of /** @type {const} */ (["awaitingMerge", "mergedOpen", "closedUnmerged"])) assert.equal(isNeedsYou(row({ status: "idle", prNeeds }), true), true, prNeeds);
  assert.equal(isNeedsYou(row({ status: "done", prState: "ready", prUrl: "https://x/pull/1" }), true), false, "no reason → not Needs you");
  assert.equal(isNeedsYou(row({ status: "done", prState: "merged", prUrl: "https://x/pull/1" }), true), false);
  assert.equal(isNeedsYou(row({ status: "idle" }), true), false);
});

// ADR 0008's table, end to end: the events + refmeta a profile would hold → buildRows → epicStats.
// Board open = the agents' last step advanced into a stage with no step (an idle row whose run is
// in the tail); done by flag = the tracker's done flag (+ `completed`); "stage" = the ticket entered
// the pipeline's terminal stage (agenthook's handoff: `pipeline_done`, plus a `via:"stage"` event an
// interim receiver wrote) with the board's flag still open — never done, same as an open board.
test("epicStats: the board × PR grid — bucket, needsYou membership and prNeeds per ADR 0008", () => {
  const PR = { none: {}, open: { pr: 7 }, merged: { pr: 7 }, closed: { pr: 7, prState: "closed" } };
  /** @type {Record<string, Record<string, [string, boolean, string|null]>>} board → PR → [bucket, in needsYou[], prNeeds] */
  const want = {
    open: { none: ["backlog", false, null], open: ["needsYou", true, "awaitingMerge"], merged: ["needsYou", true, "mergedOpen"], closed: ["needsYou", true, "closedUnmerged"] },
    flag: { none: ["done", false, null], open: ["done", true, "openOnDone"], merged: ["done", false, null], closed: ["done", false, null] },
    stage: { none: ["backlog", false, null], open: ["needsYou", true, "awaitingMerge"], merged: ["needsYou", true, "mergedOpen"], closed: ["needsYou", true, "closedUnmerged"] },
  };
  for (const [board, byPr] of Object.entries(want)) {
    for (const [pr, [bucket, listed, prNeeds]] of Object.entries(byPr)) {
      const label = `board ${board} × PR ${pr}`;
      const events = [ev("2026-10-15T10:00:00Z", "run_start"), ev("2026-10-15T10:30:00Z", "run_end", { outcome: "advance" })];
      if (pr === "merged") events.push(ev("2026-10-15T11:00:00Z", "merged"));
      if (board === "flag") events.push(ev("2026-10-15T12:00:00Z", "board_done", { step: "", via: "flag" }));
      if (board === "stage") events.push(ev("2026-10-15T11:59:00Z", "pipeline_done", { step: "done" }), ev("2026-10-15T12:00:00Z", "board_done", { step: "done", via: "stage" }));
      const state = { running: {}, queue: [], held: {}, refmeta: { 1: /** @type {Record<string, any>} */ (PR[/** @type {keyof typeof PR} */ (pr)]) }, events, quota: null };
      const rows = buildRows("p", state, { repository: "o/r" });
      assert.equal(rows[0].prNeeds, prNeeds, `${label}: prNeeds`);
      const t = ticket({ stage: board === "stage" ? "Done" : "Review", completed: board === "flag" });
      const s = epicStats(epic, [t], { rows, events, forge: true, now: NOW, live: true });
      assert.equal(Object.entries(s.byStage).find(([, n]) => n === 1)?.[0], bucket, `${label}: bucket`);
      assert.deepEqual(s.needsYou, listed ? ["1"] : [], `${label}: needsYou`);
      assert.equal(s.readyToClose, bucket === "done" && !listed, `${label}: readyToClose`);
    }
  }
});

test("epicStats: no forge — board_done alone reaches done, and no PR fact ever makes Needs you", () => {
  const events = [ev("2026-10-15T10:00:00Z", "run_start"), ev("2026-10-15T10:30:00Z", "run_end", { outcome: "advance" })];
  const state = { running: {}, queue: [], held: {}, refmeta: {}, events, quota: null };
  const open = buildRows("p", state); // no repository: no prUrl
  assert.equal(open[0].prNeeds, null);
  assert.equal(epicStats(epic, [ticket({})], { rows: open, events, forge: false, now: NOW }).byStage.backlog, 1);
  const doneEvents = [...events, ev("2026-10-15T12:00:00Z", "board_done", { step: "", via: "flag" })];
  const done = buildRows("p", { ...state, events: doneEvents });
  assert.equal(done[0].status, "done");
  const s = epicStats(epic, [ticket({})], { rows: done, events: doneEvents, forge: false, now: NOW, live: true });
  assert.equal(s.byStage.done, 1);
  assert.deepEqual(s.needsYou, []);
  assert.equal(s.readyToClose, true);
  // Even a row that carries a PR reason never needs you without a forge.
  const withPr = row({ status: "done", prState: "ready", prUrl: "https://x/pull/1", prNeeds: "openOnDone" });
  assert.deepEqual(epicStats(epic, [ticket({})], { rows: [withPr], events: [], forge: false, now: NOW }).needsYou, []);
});

test("epicStats: bucket precedence — needsYou (board open), running, done (board), backlog, untracked", () => {
  const tickets = [
    ticket({ ref: "merged1" }), // merged PR, board open, row idle with no reason -> backlog, never done
    ticket({ ref: "held1", completed: true }), // held, but the board is done -> done (a stale hold)
    ticket({ ref: "held2" }), // held, board open -> needsYou
    ticket({ ref: "run1", completed: true }), // live work outranks a done board
    ticket({ ref: "queued1" }), // queued -> running bucket
    ticket({ ref: "donerow1" }), // a row the board made done
    ticket({ ref: "trackercompleted1", stage: "Done", completed: true }), // tracker done flag, no row
    ticket({ ref: "terminal1", stage: "Done" }), // resting in the terminal stage, flag open: a handoff, not done -> backlog
    ticket({ ref: "backlog1" }), // idle, has stage -> backlog
    ticket({ ref: "untracked1", stage: null }), // idle, no stage -> untracked
  ];
  const rows = [
    row({ ref: "merged1", status: "idle", prState: "merged", prUrl: "https://x/pull/1" }),
    row({ ref: "held1", status: "held" }),
    row({ ref: "held2", status: "held" }),
    row({ ref: "run1", status: "running" }),
    row({ ref: "queued1", status: "queued" }),
    row({ ref: "donerow1", status: "done" }),
    row({ ref: "backlog1", status: "idle" }),
  ];
  const s = epicStats(epic, tickets, { rows, events: [], forge: true, now: NOW });
  assert.deepEqual(s.byStage, { backlog: 3, running: 2, needsYou: 1, done: 3, untracked: 1 });
  assert.equal(s.total, 10);
  assert.deepEqual(s.needsYou, ["held2"]);
});

test("epicStats: history fallback — a flag board_done makes a ticket older than the rows tail done; pipeline_done and merged don't; a later run_start voids it", () => {
  const tickets = [ticket({ ref: "old1" }), ticket({ ref: "old2" }), ticket({ ref: "old3" }), ticket({ ref: "old4" })];
  const events = [
    ev("2026-09-01T00:00:00Z", "board_done", { ref: "old1", via: "flag" }),
    ev("2026-09-01T00:00:00Z", "board_done", { ref: "old2", via: "flag" }),
    ev("2026-09-02T00:00:00Z", "run_start", { ref: "old2" }), // re-run voids the earlier done
    ev("2026-09-01T00:00:00Z", "pipeline_done", { ref: "old3" }), // the terminal stage: a handoff, not done
    ev("2026-09-01T00:00:00Z", "merged", { ref: "old4" }),
  ];
  const s = epicStats(epic, tickets, { rows: [], events, forge: false, now: NOW });
  assert.deepEqual(s.byStage, { backlog: 3, running: 0, needsYou: 0, done: 1, untracked: 0 });
});

test("epicStats: an idle row whose history left the events tail — a learned merge is not done, the board decides", () => {
  const tickets = [ticket({ ref: "gone1", stage: "Done", completed: true }), ticket({ ref: "gone2", stage: "Review" })];
  const rows = [row({ ref: "gone1", status: "idle", prState: "merged", prUrl: "https://github.com/o/r/pull/1" }), row({ ref: "gone2", status: "idle", prState: "merged", prUrl: "https://github.com/o/r/pull/2" })];
  const s = epicStats(epic, tickets, { rows, events: [], forge: true, now: NOW });
  assert.deepEqual(s.byStage, { backlog: 1, running: 0, needsYou: 0, done: 1, untracked: 0 });
  assert.deepEqual(s.needsYou, [], "an unknown board gives no PR reason");
});

test("epicStats: a cancelled row with an earlier pipeline_done stays backlog, not done", () => {
  const tickets = [ticket({ ref: "c1" })];
  const events = [ev("2026-09-01T00:00:00Z", "pipeline_done", { ref: "c1" })];
  const rows = [row({ ref: "c1", status: "cancelled" })];
  const s = epicStats(epic, tickets, { rows, events, forge: false, now: NOW });
  assert.deepEqual(s.byStage, { backlog: 1, running: 0, needsYou: 0, done: 0, untracked: 0 });
});

test("epicStats: an open PR on a done ticket counts done and is listed in needsYou (forge only); awaiting merge is the needsYou bucket", () => {
  const tickets = [ticket({ ref: "pr1" }), ticket({ ref: "pr2" })];
  const rows = [
    row({ ref: "pr1", status: "done", prState: "ready", prUrl: "https://x/pull/9", prNeeds: "openOnDone" }),
    row({ ref: "pr2", status: "idle", prState: "ready", prUrl: "https://x/pull/10", prNeeds: "awaitingMerge" }),
  ];
  const withForge = epicStats(epic, tickets, { rows, events: [], forge: true, now: NOW, live: true });
  assert.deepEqual(withForge.byStage, { backlog: 0, running: 0, needsYou: 1, done: 1, untracked: 0 });
  assert.deepEqual(withForge.needsYou, ["pr1", "pr2"]);

  const noForge = epicStats(epic, tickets, { rows, events: [], forge: false, now: NOW });
  assert.deepEqual(noForge.byStage, { backlog: 1, running: 0, needsYou: 0, done: 1, untracked: 0 });
  assert.deepEqual(noForge.needsYou, []);

  // The tracker says done though the local row still reads awaiting merge (a missed flag): done + needs you.
  const flagMissed = epicStats(epic, [ticket({ ref: "pr2", completed: true })], { rows, events: [], forge: true, now: NOW, live: true });
  assert.deepEqual([flagMissed.byStage.done, flagMissed.needsYou, flagMissed.readyToClose], [1, ["pr2"], false]);
});

test("epicStats: a startedAt inside the window shortens spanDays and raises perDay", () => {
  const tickets = Array.from({ length: 10 }, (_, i) => ticket({ ref: `t${i}` }));
  const s = epicStats(epic, tickets, {
    rows: [],
    events: [
      ev("2026-10-13T00:00:00Z", "run_start", { ref: "t0" }), // startedAt, 3 days before now
      ev("2026-10-13T00:00:00Z", "run_end", { ref: "t0" }), ev("2026-10-13T00:00:00Z", "board_done", { ref: "t0" }),
      ev("2026-10-14T00:00:00Z", "run_end", { ref: "t1" }), ev("2026-10-14T00:00:00Z", "board_done", { ref: "t1" }),
      ev("2026-10-15T00:00:00Z", "run_end", { ref: "t2" }), ev("2026-10-15T00:00:00Z", "board_done", { ref: "t2" }),
    ],
    forge: false,
    now: NOW,
  });
  assert.equal(s.startedAt, "2026-10-13T00:00:00Z");
  // spanDays = 2026-10-13..2026-10-15 inclusive = 3 (vs 14 without startedAt) -> perDay = 3/3 = 1
  assert.equal(s.velocity.perDay, 1);
  assert.ok(s.eta);
  assert.equal(s.eta?.days, 7); // remaining 7 / perDay 1
});

test("epicStats: untracked vs backlog by ticket.stage, not row presence", () => {
  const tickets = [ticket({ ref: "a", stage: "Backlog" }), ticket({ ref: "b", stage: null })];
  const s = epicStats(epic, tickets, { rows: [], events: [], forge: false, now: NOW });
  assert.deepEqual(s.byStage, { backlog: 1, running: 0, needsYou: 0, done: 0, untracked: 1 });
});

test("epicStats: startedAt is the earliest member run_start, null when none; non-member events ignored", () => {
  const tickets = [ticket({ ref: "a" }), ticket({ ref: "b" })];
  const events = [
    ev("2026-10-01T00:00:00Z", "run_start", { ref: "a" }),
    ev("2026-09-20T00:00:00Z", "run_start", { ref: "b" }),
    ev("2026-09-01T00:00:00Z", "run_start", { ref: "other" }), // not a member
  ];
  const s = epicStats(epic, tickets, { rows: [], events, forge: false, now: NOW });
  assert.equal(s.startedAt, "2026-09-20T00:00:00Z");
  assert.equal(epicStats(epic, tickets, { rows: [], events: [], forge: false, now: NOW }).startedAt, null);
});

test("epicStats: velocity counts member finishes only, dedups repeated pipeline_done, 14 zero-filled days", () => {
  const tickets = [ticket({ ref: "a" }), ticket({ ref: "b" })];
  const events = [
    ev("2026-10-15T01:00:00Z", "run_end", { ref: "a" }), ev("2026-10-15T01:00:00Z", "board_done", { ref: "a" }),
    ev("2026-10-15T01:00:02Z", "run_end", { ref: "a" }), ev("2026-10-15T01:00:02Z", "board_done", { ref: "a" }), // dup burst: counts once
    ev("2026-10-15T02:00:00Z", "run_end", { ref: "notamember" }), ev("2026-10-15T02:00:00Z", "board_done", { ref: "notamember" }), // ignored
  ];
  const s = epicStats(epic, tickets, { rows: [], events, forge: false, now: NOW });
  assert.equal(s.velocity.days.length, 14);
  assert.equal(s.velocity.days[0].date, "2026-10-02");
  assert.equal(s.velocity.days[13].date, "2026-10-15");
  assert.equal(s.velocity.finished14, 1);
  assert.equal(s.velocity.activeDays, 1);
});

test("epicStats: eta null unless >=3 finished in 14d AND >=3 active days AND remaining > 0; computed in the positive case", () => {
  const tickets = Array.from({ length: 10 }, (_, i) => ticket({ ref: `t${i}` }));
  const few = epicStats(epic, tickets, {
    rows: [],
    events: [
      ev("2026-10-13T00:00:00Z", "run_end", { ref: "t0" }), ev("2026-10-13T00:00:00Z", "board_done", { ref: "t0" }),
      ev("2026-10-13T00:00:01Z", "run_end", { ref: "t1" }), ev("2026-10-13T00:00:01Z", "board_done", { ref: "t1" }),
    ],
    forge: false,
    now: NOW,
  });
  assert.equal(few.eta, null, "finished14 < 3");

  const oneDay = epicStats(epic, tickets, {
    rows: [],
    events: [
      ev("2026-10-13T00:00:00Z", "run_end", { ref: "t0" }), ev("2026-10-13T00:00:00Z", "board_done", { ref: "t0" }),
      ev("2026-10-13T00:00:01Z", "run_end", { ref: "t1" }), ev("2026-10-13T00:00:01Z", "board_done", { ref: "t1" }),
      ev("2026-10-13T00:00:02Z", "run_end", { ref: "t2" }), ev("2026-10-13T00:00:02Z", "board_done", { ref: "t2" }),
    ],
    forge: false,
    now: NOW,
  });
  assert.equal(oneDay.eta, null, "activeDays < 3");

  const noRemaining = epicStats({ ...epic }, tickets.slice(0, 3), {
    rows: [],
    events: [
      ev("2026-10-13T00:00:00Z", "run_end", { ref: "t0" }), ev("2026-10-13T00:00:00Z", "board_done", { ref: "t0" }),
      ev("2026-10-14T00:00:00Z", "run_end", { ref: "t1" }), ev("2026-10-14T00:00:00Z", "board_done", { ref: "t1" }),
      ev("2026-10-15T00:00:00Z", "run_end", { ref: "t2" }), ev("2026-10-15T00:00:00Z", "board_done", { ref: "t2" }),
    ],
    forge: false,
    now: NOW,
  });
  assert.equal(noRemaining.eta, null, "remaining === 0");

  const positive = epicStats(epic, tickets, {
    rows: [],
    events: [
      ev("2026-10-13T00:00:00Z", "run_end", { ref: "t0" }), ev("2026-10-13T00:00:00Z", "board_done", { ref: "t0" }),
      ev("2026-10-14T00:00:00Z", "run_end", { ref: "t1" }), ev("2026-10-14T00:00:00Z", "board_done", { ref: "t1" }),
      ev("2026-10-15T00:00:00Z", "run_end", { ref: "t2" }), ev("2026-10-15T00:00:00Z", "board_done", { ref: "t2" }),
    ],
    forge: false,
    now: NOW,
  });
  assert.ok(positive.eta);
  // finished14=3, spanDays = window (14 days) since no startedAt within it -> perDay = 3/14
  // remaining = 10 - 3 = 7; days = ceil(7 / (3/14)) = ceil(32.67) = 33
  assert.equal(positive.eta?.days, 33);
  assert.equal(positive.eta?.date, "2026-11-17");
});

test("epicStats: epic status/completed/ref/name/url/displayId pass through verbatim", () => {
  const s = epicStats(epic, [], { rows: [], events: [], forge: false, now: NOW });
  assert.equal(s.ref, epic.ref);
  assert.equal(s.name, epic.name);
  assert.equal(s.url, epic.url);
  assert.equal(s.displayId, epic.displayId);
  assert.equal(s.status, epic.status);
  assert.equal(s.completed, epic.completed);
  assert.equal(s.total, 0);
});

test("ticketBucket: the per-ticket decision epicStats counts (needs you on an open board > live work > board done > tracker stage)", () => {
  assert.equal(ticketBucket(ticket({}), row({ status: "idle", prState: "merged" }), undefined, false), "backlog", "a merged PR is never done");
  assert.equal(ticketBucket(ticket({}), row({ status: "held" }), undefined, false), "needsYou");
  assert.equal(ticketBucket(ticket({ completed: true }), row({ status: "held" }), undefined, false), "done", "the board outranks a stale hold");
  assert.equal(ticketBucket(ticket({}), row({ status: "stalled" }), undefined, false), "running");
  assert.equal(ticketBucket(ticket({ completed: true }), row({ status: "running" }), undefined, false), "running", "live work outranks the board");
  assert.equal(ticketBucket(ticket({}), row({ status: "done", prState: "ready" }), undefined, false), "done");
  assert.equal(ticketBucket(ticket({}), row({ status: "done", prState: "ready", prUrl: "https://x/pull/1", prNeeds: "openOnDone" }), undefined, true), "done");
  assert.equal(ticketBucket(ticket({ completed: true }), null, undefined, false), "done");
  assert.equal(ticketBucket(ticket({}), null, [ev("2026-10-14T00:00:00Z", "board_done", { via: "flag" })], false), "done");
  assert.equal(ticketBucket(ticket({}), null, [ev("2026-10-14T00:00:00Z", "pipeline_done")], false), "backlog", "the terminal stage is a handoff, not done (ADR 0008)");
  assert.equal(ticketBucket(ticket({}), null, [ev("2026-10-14T00:00:00Z", "board_done", { via: "stage" })], false), "backlog", "an interim via:stage event is not done either");
  assert.equal(ticketBucket(ticket({}), null, [ev("2026-10-14T00:00:00Z", "merged")], false), "backlog");
  assert.equal(ticketBucket(ticket({}), null, [ev("2026-10-14T00:00:00Z", "pipeline_done"), ev("2026-10-14T01:00:00Z", "run_start")], false), "backlog");
  assert.equal(ticketBucket(ticket({ stage: null }), null, undefined, false), "untracked");
});

test("epicDetail: epicStats plus each ticket's bucket and local status (null when it never ran here)", () => {
  const tickets = [ticket({ ref: "1" }), ticket({ ref: "2", stage: null })];
  const o = { rows: [row({ ref: "1", status: "held" })], events: [], forge: false, now: NOW };
  const d = epicDetail(epic, tickets, o);
  const { tickets: detailTickets, ...stats } = d;
  assert.deepEqual(stats, epicStats(epic, tickets, o));
  assert.deepEqual(detailTickets.map((t) => [t.ref, t.bucket, t.status]), [["1", "needsYou", "held"], ["2", "untracked", null]]);
});

test("localEpics: refmeta grouped by epic.ref; null/absent/garbage epics skipped", () => {
  const groups = localEpics({
    a: { title: "A", displayId: "#a", url: "https://x/a", epic: { ref: "E1", name: "One", url: "u1" } },
    b: { title: "B", epic: { ref: "E1", name: "One" } },
    c: { epic: { ref: "E2", name: "Two" } },
    d: { title: "D", epic: null },
    e: { title: "E" },
    f: { epic: { name: "no ref" } },
  });
  assert.deepEqual(
    groups.map((g) => [g.epic, g.tickets]),
    [
      [
        { ref: "E1", name: "One", url: "u1", status: null, completed: false },
        [{ ref: "a", displayId: "#a", name: "A", completed: false, stage: null, url: "https://x/a" }, { ref: "b", name: "B", completed: false, stage: null, url: null }],
      ],
      [{ ref: "E2", name: "Two", url: "", status: null, completed: false }, [{ ref: "c", name: "c", completed: false, stage: null, url: null }]],
    ],
  );
});

test("epicStats: readyToClose — live + every ticket done + none needs you + epic still open", () => {
  // 0 tickets -> false
  assert.equal(epicStats(epic, [], { rows: [], events: [], forge: false, now: NOW, live: true }).readyToClose, false);

  const allFinished = [ticket({ ref: "a", completed: true }), ticket({ ref: "b", completed: true })];
  const base = { rows: [], events: [], forge: false, now: NOW, live: true };

  assert.equal(epicStats(epic, allFinished, base).readyToClose, true);

  // all finished + one untracked -> false
  const withUntracked = [...allFinished, ticket({ ref: "u", stage: null })];
  assert.equal(epicStats(epic, withUntracked, base).readyToClose, false);

  // all finished + one needs-you -> false
  const withNeedsYou = [...allFinished, ticket({ ref: "h" })];
  const rowsNeedsYou = [row({ ref: "h", status: "held" })];
  assert.equal(epicStats(epic, withNeedsYou, { ...base, rows: rowsNeedsYou }).readyToClose, false);

  // all finished but epic completed:true -> false
  assert.equal(epicStats({ ...epic, completed: true }, allFinished, base).readyToClose, false);

  // tracker completed:true, no row -> counts as finished -> true (already covered by allFinished, stage default "To do")
  const trackerCompletedOnly = [ticket({ ref: "tc", completed: true })];
  assert.equal(epicStats(epic, trackerCompletedOnly, base).readyToClose, true);

  // a board-done row counts -> true; a merged PR on an open board doesn't -> false
  const merged = [ticket({ ref: "m" })];
  assert.equal(epicStats(epic, merged, { ...base, rows: [row({ ref: "m", status: "done", prState: "merged" })] }).readyToClose, true);
  assert.equal(epicStats(epic, merged, { ...base, rows: [row({ ref: "m", status: "idle", prState: "merged" })] }).readyToClose, false);

  // all done but one has an open PR (done + needs you) -> false
  const openPr = [row({ ref: "a", status: "done", prState: "ready", prUrl: "https://x/pull/1", prNeeds: "openOnDone" })];
  assert.equal(epicStats(epic, allFinished, { ...base, forge: true, rows: openPr }).readyToClose, false);

  // forge-less all-finished -> true
  assert.equal(epicStats(epic, allFinished, { ...base, forge: false }).readyToClose, true);

  // same inputs without live:true -> false
  assert.equal(epicStats(epic, allFinished, { ...base, live: undefined }).readyToClose, false);
  assert.equal(epicStats(epic, allFinished, { rows: [], events: [], forge: false, now: NOW }).readyToClose, false);
});

test("EPIC_REF_RE: tracker ids pass; path/URL metacharacters and overlong refs fail", () => {
  for (const ok of ["1203456789", "CAHUI-7", "a.b_c"]) assert.ok(EPIC_REF_RE.test(ok), ok);
  for (const bad of ["", "../x", "a/b", "a?b", "a b", "x".repeat(65)]) assert.ok(!EPIC_REF_RE.test(bad), bad);
});
