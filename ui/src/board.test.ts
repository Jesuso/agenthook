import { describe, expect, it } from "vitest";
import { FINISHED_CAP, QUEUE_CAP, board, localMidnight } from "./board";
import type { TicketRow } from "./contract";

const base: TicketRow = {
  profile: "p",
  ref: "r1",
  displayId: "T-1",
  title: "a",
  summary: null,
  plain: null,
  options: null,
  step: "code",
  status: "running",
  model: null,
  startedAt: null,
  costUsd: 0,
  estUsd: 0,
  trackerUrl: null,
  prUrl: null,
  heldReason: null,
  heldAt: null,
  failReason: null,
  prState: null,
  prNeeds: null,
  finishedAt: null,
  queuePos: null,
  queuedAt: null,
  epic: null,
};

const row = (over: Partial<TicketRow>): TicketRow => ({ ...base, ...over });

const NOW = new Date(2026, 4, 10, 15, 0, 0).getTime();
const at = (minsAgo: number) => new Date(NOW - minsAgo * 60_000).toISOString();
const STEPS = ["triage", "code", "review"];

describe("board", () => {
  it("columns are the pipeline's steps, in order; none while they are unknown", () => {
    expect(board([], STEPS, [], NOW).columns).toEqual(STEPS);
    expect(board([row({})], [], [], NOW).columns).toEqual([]);
  });

  it("a manual step is a column only while it holds a ticket", () => {
    const steps = [...STEPS, "ship"];
    expect(board([], steps, ["ship"], NOW).columns).toEqual(STEPS);
    expect(board([row({ status: "queued", step: "ship" })], steps, ["ship"], NOW).columns).toEqual(steps);
    expect(board([row({ status: "held", step: "ship" })], steps, ["ship"], NOW).columns).toEqual(steps);
  });

  it("rows: running first, longest running first, then the queue in its own order", () => {
    const b = board(
      [
        row({ ref: "q2", status: "queued", queuePos: 2 }),
        row({ ref: "new", status: "running", startedAt: at(1) }),
        row({ ref: "q1", status: "queued", queuePos: 1 }),
        row({ ref: "old", status: "running", startedAt: at(9) }),
      ],
      STEPS,
      [],
      NOW,
    );
    expect(b.rows.map((e) => [e.ticket.ref, e.clock])).toEqual([["old", "running"], ["new", "running"], ["q1", "queued"], ["q2", "queued"]]);
    expect([b.runningCount, b.queuedCount]).toEqual([2, 2]);
  });

  it("interrupted reads as running and stalled as queued (the receiver is down)", () => {
    const b = board([row({ ref: "i", status: "interrupted" }), row({ ref: "s", status: "stalled" })], STEPS, [], NOW);
    expect(b.rows.map((e) => e.clock)).toEqual(["running", "queued"]);
  });

  it("held and failed tickets are not rows, but count toward the step they stopped in", () => {
    const b = board([row({ ref: "h", status: "held", step: "review" }), row({ ref: "f", status: "failed", step: "review" }), row({ ref: "r", status: "running", step: "code" })], STEPS, [], NOW);
    expect(b.rows.map((e) => e.ticket.ref)).toEqual(["r"]);
    expect(b.counts).toEqual({ review: 2, code: 1 });
  });

  it("every running ticket shows; the queue is capped, the rest counted", () => {
    const queued = Array.from({ length: QUEUE_CAP + 3 }, (_, i) => row({ ref: `q${i}`, status: "queued", queuePos: i + 1 }));
    const running = Array.from({ length: 12 }, (_, i) => row({ ref: `r${i}`, status: "running" }));
    const b = board([...queued, ...running], STEPS, [], NOW);
    expect(b.rows).toHaveLength(12 + QUEUE_CAP);
    expect(b.moreQueued).toBe(3);
    expect(b.queuedCount).toBe(QUEUE_CAP + 3);
  });

  it("finished: only since local midnight, newest first, capped, with the full count", () => {
    const today = Array.from({ length: FINISHED_CAP + 2 }, (_, i) => row({ ref: `d${i}`, status: "done", finishedAt: at(i + 1) }));
    const b = board([...today, row({ ref: "old", status: "done", finishedAt: new Date(localMidnight(NOW) - 1).toISOString() })], STEPS, [], NOW);
    expect(b.finished.total).toBe(FINISHED_CAP + 2);
    expect(b.finished.tickets.map((t) => t.ref)).toEqual(today.slice(0, FINISHED_CAP).map((t) => t.ref));
  });

  it("a finished ticket whose PR needs you is Needs you's, not Done today's (forge profiles)", () => {
    const flagged = row({ ref: "pr", status: "done", finishedAt: at(5), prUrl: "https://example.test/pr/1", prNeeds: "awaitingMerge" });
    expect(board([flagged], STEPS, [], NOW, true).finished.total).toBe(0);
    expect(board([flagged], STEPS, [], NOW, false).finished.total).toBe(1);
  });
});

describe("localMidnight", () => {
  it("is the start of the browser-local day", () => {
    const d = new Date(localMidnight(NOW));
    expect([d.getHours(), d.getMinutes(), d.getDate()]).toEqual([0, 0, new Date(NOW).getDate()]);
  });
});
