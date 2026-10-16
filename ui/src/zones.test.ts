import { describe, it, expect } from "vitest";
import { MIN_RUNS_FOR_RATES, needsYouItems, nowItems, progress } from "./zones";
import type { TicketRow } from "./contract";

const t = (ref: string, over: Partial<TicketRow> = {}): TicketRow => ({
  profile: "p", ref, displayId: ref, title: null, step: null, status: "idle", model: null, startedAt: null, costUsd: 0, trackerUrl: null, prUrl: null,
  summary: null, heldReason: null, heldAt: null, failReason: null, prState: null, finishedAt: null, queuePos: null, ...over,
});

// Local time on purpose: "today" is the browser's local day.
const NOW = new Date(2026, 9, 8, 12, 0, 0).getTime();
const local = (h: number, day = 8) => new Date(2026, 9, day, h).toISOString();

describe("needsYouItems", () => {
  it("orders failed → held → PR, newest first within a kind, with each kind's reason", () => {
    const items = needsYouItems(
      [
        t("h-old", { status: "held", heldReason: "which db?", startedAt: local(8) }),
        t("pr", { status: "done", prState: "ready", prUrl: "https://github.com/o/r/pull/1", finishedAt: local(11) }),
        t("f", { status: "failed", failReason: "tests red", startedAt: local(9) }),
        t("h-new", { status: "held", summary: null, heldReason: null, startedAt: local(10) }),
        t("running", { status: "running" }),
      ],
      true,
    );
    expect(items.map((i) => i.ticket.ref)).toEqual(["f", "h-new", "h-old", "pr"]);
    expect(items.map((i) => i.kind)).toEqual(["failed", "held", "held", "pr"]);
    expect(items.map((i) => i.reason)).toEqual(["tests red", null, "which db?", null]);
    expect(items[3].since).toBe(local(11));
  });

  it("ages a held ticket from when it was held, falling back to its last start", () => {
    const [a] = needsYouItems([t("h", { status: "held", heldAt: local(7), startedAt: local(9) })], false);
    expect(a.since).toBe(local(7));
    const [b] = needsYouItems([t("h", { status: "held", heldAt: null, startedAt: local(9) })], false);
    expect(b.since).toBe(local(9));
  });

  it("leaves a ready PR out without a forge, and a merged one always", () => {
    const prUrl = "https://github.com/o/r/pull/1";
    const tickets = [t("a", { status: "done", prState: "ready", prUrl }), t("b", { status: "done", prState: "merged", prUrl }), t("c", { status: "done", prState: "closed", prUrl })];
    expect(needsYouItems(tickets, false)).toEqual([]);
    expect(needsYouItems(tickets, true).map((i) => i.ticket.ref)).toEqual(["a"]);
  });

  it("leaves a finished ticket with no known PR out — it is just Finished", () => {
    expect(needsYouItems([t("a", { status: "done", prState: "ready", prUrl: null })], true)).toEqual([]);
  });
});

describe("nowItems", () => {
  it("lists running by start time and queued by queue position (unknown last)", () => {
    const { running, queued } = nowItems([
      t("r2", { status: "running", startedAt: local(10) }),
      t("r1", { status: "running", startedAt: local(9) }),
      t("q2", { status: "queued", queuePos: 2 }),
      t("qx", { status: "queued", queuePos: null }),
      t("q0", { status: "queued", queuePos: 0 }),
      t("done", { status: "done" }),
    ]);
    expect(running.map((x) => x.ref)).toEqual(["r1", "r2"]);
    expect(queued.map((x) => x.ref)).toEqual(["q0", "q2", "qx"]);
  });
});

describe("progress", () => {
  const profile = (runs: { at: string; outcome: string | null }[] = [], costs: { at: string; costUsd: number }[] = []) => ({ recentRuns: runs, recentCosts: costs });

  it("splits finished tickets and cost into today and yesterday by local midnight", () => {
    const p = progress(
      profile([], [
        { at: local(23, 6), costUsd: 100 }, // before yesterday
        { at: local(23, 7), costUsd: 1.5 },
        { at: local(0, 8), costUsd: 2 },
        { at: local(11, 8), costUsd: 0.25 },
      ]),
      [
        t("a", { status: "done", finishedAt: local(9) }),
        t("b", { status: "done", finishedAt: local(0) }),
        t("c", { status: "done", finishedAt: local(20, 7) }),
        t("d", { status: "done", finishedAt: local(20, 5) }), // too old for either
        t("e", { status: "running", finishedAt: local(9) }), // a re-run: not finished
        t("f", { status: "done", finishedAt: null }),
      ],
      NOW,
    );
    expect(p).toMatchObject({ finishedToday: 2, finishedYesterday: 1, costToday: 2.25, costYesterday: 1.5 });
  });

  it("hides the rework rate below the minimum number of runs, shows it at the minimum", () => {
    const runs = (n: number, rework: number) => Array.from({ length: n }, (_, i) => ({ at: local(9), outcome: i < rework ? "changes" : "advance" }));
    expect(progress(profile(runs(MIN_RUNS_FOR_RATES - 1, 3)), [], NOW)).toMatchObject({ runs: 9, rework: 3, reworkRate: null });
    expect(progress(profile(runs(MIN_RUNS_FOR_RATES, 3)), [], NOW)).toMatchObject({ runs: 10, rework: 3, reworkRate: 0.3 });
  });
});
