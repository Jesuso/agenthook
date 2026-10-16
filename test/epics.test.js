import "./_setup.js";
// Pure stats over an epic + its tickets: bucket precedence, needs-you, velocity, ETA.
import test from "node:test";
import assert from "node:assert/strict";
import { EPIC_REF_RE, epicDetail, epicStats, isNeedsYou, localEpics, ticketBucket } from "../src/epics.js";

const NOW = Date.parse("2026-10-15T18:00:00Z"); // UTC, tzOffset 0 unless noted

/** @param {Partial<import('../src/ui/contract.js').TicketRow>} o */
function row(o) {
  return { profile: "p", ref: "1", displayId: "1", title: null, summary: null, step: null, status: "idle", model: null, startedAt: null, costUsd: 0, trackerUrl: null, prUrl: null, heldReason: null, heldAt: null, failReason: null, prState: null, finishedAt: null, queuePos: null, ...o };
}

/** @param {Partial<import('../src/types.js').EpicTicket>} o */
function ticket(o) {
  return { ref: "1", name: "t", completed: false, stage: "To do", ...o };
}

const epic = { ref: "E1", name: "Epic One", url: "https://x/epic/1", displayId: "E1", status: "In progress", completed: false };

/** @param {string} ts @param {string} event @param {any} x */
const ev = (ts, event, x = {}) => ({ ts, event, ref: "1", step: "s", ...x });

test("isNeedsYou: held/failed always; done+ready+prUrl only with forge; no prUrl -> false", () => {
  assert.equal(isNeedsYou(row({ status: "held" }), false), true);
  assert.equal(isNeedsYou(row({ status: "failed" }), false), true);
  assert.equal(isNeedsYou(row({ status: "done", prState: "ready", prUrl: "https://x/pull/1" }), true), true);
  assert.equal(isNeedsYou(row({ status: "done", prState: "ready", prUrl: "https://x/pull/1" }), false), false);
  assert.equal(isNeedsYou(row({ status: "done", prState: "ready", prUrl: null }), true), false);
  assert.equal(isNeedsYou(row({ status: "done", prState: "merged", prUrl: "https://x/pull/1" }), true), false);
  assert.equal(isNeedsYou(row({ status: "idle" }), true), false);
});

test("epicStats: bucket precedence — merged, needsYou (incl. held+completed), running, finished, backlog, untracked", () => {
  const tickets = [
    ticket({ ref: "merged1" }), // merged row
    ticket({ ref: "held1", completed: true }), // held + completed -> needsYou wins
    ticket({ ref: "run1" }), // running
    ticket({ ref: "queued1" }), // queued -> running bucket
    ticket({ ref: "donehand1" }), // done, no forge PR -> finished
    ticket({ ref: "trackercompleted1", stage: "Done", completed: true }), // tracker says completed, no row -> finished
    ticket({ ref: "backlog1" }), // idle, has stage -> backlog
    ticket({ ref: "untracked1", stage: null }), // idle, no stage -> untracked
  ];
  const rows = [
    row({ ref: "merged1", status: "done", prState: "merged" }),
    row({ ref: "held1", status: "held" }),
    row({ ref: "run1", status: "running" }),
    row({ ref: "queued1", status: "queued" }),
    row({ ref: "donehand1", status: "done", prState: null }),
    row({ ref: "backlog1", status: "idle" }),
  ];
  const s = epicStats(epic, tickets, { rows, events: [], forge: false, now: NOW });
  assert.deepEqual(s.byStage, { backlog: 1, running: 2, needsYou: 1, finished: 2, merged: 1, untracked: 1 });
  assert.equal(s.total, 8);
  assert.deepEqual(s.needsYou, ["held1"]);
});

test("epicStats: history fallback finishes a ticket older than the rows tail; a later run_start voids it", () => {
  const tickets = [ticket({ ref: "old1" }), ticket({ ref: "old2" })];
  const events = [
    ev("2026-09-01T00:00:00Z", "pipeline_done", { ref: "old1" }),
    ev("2026-09-01T00:00:00Z", "pipeline_done", { ref: "old2" }),
    ev("2026-09-02T00:00:00Z", "run_start", { ref: "old2" }), // re-run voids the earlier finish
  ];
  const s = epicStats(epic, tickets, { rows: [], events, forge: false, now: NOW });
  assert.deepEqual(s.byStage, { backlog: 1, running: 0, needsYou: 0, finished: 1, merged: 0, untracked: 0 });
});

test("epicStats: a cancelled row with an earlier pipeline_done stays backlog, not finished", () => {
  const tickets = [ticket({ ref: "c1" })];
  const events = [ev("2026-09-01T00:00:00Z", "pipeline_done", { ref: "c1" })];
  const rows = [row({ ref: "c1", status: "cancelled" })];
  const s = epicStats(epic, tickets, { rows, events, forge: false, now: NOW });
  assert.deepEqual(s.byStage, { backlog: 1, running: 0, needsYou: 0, finished: 0, merged: 0, untracked: 0 });
});

test("epicStats: needsYou via forge done+ready+prUrl on the full join, not just isNeedsYou directly", () => {
  const tickets = [ticket({ ref: "pr1" })];
  const rows = [row({ ref: "pr1", status: "done", prState: "ready", prUrl: "https://x/pull/9" })];
  const withForge = epicStats(epic, tickets, { rows, events: [], forge: true, now: NOW });
  assert.deepEqual(withForge.byStage, { backlog: 0, running: 0, needsYou: 1, finished: 0, merged: 0, untracked: 0 });
  assert.deepEqual(withForge.needsYou, ["pr1"]);

  const noForge = epicStats(epic, tickets, { rows, events: [], forge: false, now: NOW });
  assert.deepEqual(noForge.byStage, { backlog: 0, running: 0, needsYou: 0, finished: 1, merged: 0, untracked: 0 });
});

test("epicStats: a startedAt inside the window shortens spanDays and raises perDay", () => {
  const tickets = Array.from({ length: 10 }, (_, i) => ticket({ ref: `t${i}` }));
  const s = epicStats(epic, tickets, {
    rows: [],
    events: [
      ev("2026-10-13T00:00:00Z", "run_start", { ref: "t0" }), // startedAt, 3 days before now
      ev("2026-10-13T00:00:00Z", "pipeline_done", { ref: "t0" }),
      ev("2026-10-14T00:00:00Z", "pipeline_done", { ref: "t1" }),
      ev("2026-10-15T00:00:00Z", "pipeline_done", { ref: "t2" }),
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
  assert.deepEqual(s.byStage, { backlog: 1, running: 0, needsYou: 0, finished: 0, merged: 0, untracked: 1 });
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
    ev("2026-10-15T01:00:00Z", "pipeline_done", { ref: "a" }),
    ev("2026-10-15T01:00:02Z", "pipeline_done", { ref: "a" }), // dup burst: counts once
    ev("2026-10-15T02:00:00Z", "pipeline_done", { ref: "notamember" }), // ignored
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
      ev("2026-10-13T00:00:00Z", "pipeline_done", { ref: "t0" }),
      ev("2026-10-13T00:00:01Z", "pipeline_done", { ref: "t1" }),
    ],
    forge: false,
    now: NOW,
  });
  assert.equal(few.eta, null, "finished14 < 3");

  const oneDay = epicStats(epic, tickets, {
    rows: [],
    events: [
      ev("2026-10-13T00:00:00Z", "pipeline_done", { ref: "t0" }),
      ev("2026-10-13T00:00:01Z", "pipeline_done", { ref: "t1" }),
      ev("2026-10-13T00:00:02Z", "pipeline_done", { ref: "t2" }),
    ],
    forge: false,
    now: NOW,
  });
  assert.equal(oneDay.eta, null, "activeDays < 3");

  const noRemaining = epicStats({ ...epic }, tickets.slice(0, 3), {
    rows: [],
    events: [
      ev("2026-10-13T00:00:00Z", "pipeline_done", { ref: "t0" }),
      ev("2026-10-14T00:00:00Z", "pipeline_done", { ref: "t1" }),
      ev("2026-10-15T00:00:00Z", "pipeline_done", { ref: "t2" }),
    ],
    forge: false,
    now: NOW,
  });
  assert.equal(noRemaining.eta, null, "remaining === 0");

  const positive = epicStats(epic, tickets, {
    rows: [],
    events: [
      ev("2026-10-13T00:00:00Z", "pipeline_done", { ref: "t0" }),
      ev("2026-10-14T00:00:00Z", "pipeline_done", { ref: "t1" }),
      ev("2026-10-15T00:00:00Z", "pipeline_done", { ref: "t2" }),
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

test("ticketBucket: the per-ticket decision epicStats counts (row > history > tracker stage)", () => {
  assert.equal(ticketBucket(ticket({}), row({ status: "done", prState: "merged" }), undefined, false), "merged");
  assert.equal(ticketBucket(ticket({ completed: true }), row({ status: "held" }), undefined, false), "needsYou");
  assert.equal(ticketBucket(ticket({}), row({ status: "stalled" }), undefined, false), "running");
  assert.equal(ticketBucket(ticket({}), row({ status: "done", prState: "ready" }), undefined, false), "finished");
  assert.equal(ticketBucket(ticket({ completed: true }), null, undefined, false), "finished");
  assert.equal(ticketBucket(ticket({}), null, [ev("2026-10-14T00:00:00Z", "pipeline_done")], false), "finished");
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
    a: { title: "A", displayId: "#a", epic: { ref: "E1", name: "One", url: "u1" } },
    b: { title: "B", epic: { ref: "E1", name: "One" } },
    c: { epic: { ref: "E2", name: "Two" } },
    d: { title: "D", epic: null },
    e: { title: "E" },
    f: { epic: { name: "no ref" } },
  });
  assert.deepEqual(
    groups.map((g) => [g.epic, g.tickets]),
    [
      [{ ref: "E1", name: "One", url: "u1", status: null, completed: false }, [{ ref: "a", displayId: "#a", name: "A", completed: false, stage: null }, { ref: "b", name: "B", completed: false, stage: null }]],
      [{ ref: "E2", name: "Two", url: "", status: null, completed: false }, [{ ref: "c", name: "c", completed: false, stage: null }]],
    ],
  );
});

test("EPIC_REF_RE: tracker ids pass; path/URL metacharacters and overlong refs fail", () => {
  for (const ok of ["1203456789", "CAHUI-7", "a.b_c"]) assert.ok(EPIC_REF_RE.test(ok), ok);
  for (const bad of ["", "../x", "a/b", "a?b", "a b", "x".repeat(65)]) assert.ok(!EPIC_REF_RE.test(bad), bad);
});
