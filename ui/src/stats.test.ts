import { describe, it, expect } from "vitest";
import { latestChange, shortDate, statsUrl, summarizeStats, weekdayLetter } from "./stats";
import type { DayStats } from "./contract";
import type { FeedEntry } from "./feed";

const day = (date: string, over: Partial<DayStats> = {}): DayStats => ({ date, finished: 0, merged: 0, runs: 0, rework: 0, failedRuns: 0, costUsd: 0, ...over });
const ev = (event: string, ts: string): FeedEntry => ({ type: "event", profile: "p", event: { event, ts, ref: "1" } });

describe("statsUrl", () => {
  it("encodes the profile and carries the days and the browser's tz offset", () => {
    expect(statsUrl("a b", 14, 360)).toBe("/api/stats?profile=a%20b&days=14&tz=360");
  });
});

describe("summarizeStats", () => {
  it("totals, per-day average, best day, and hides the rework rate under 10 runs", () => {
    const s = summarizeStats([day("2026-10-13", { finished: 2, runs: 4, rework: 1, costUsd: 1.1 }), day("2026-10-14", { finished: 6, runs: 3, costUsd: 2.25 }), day("2026-10-15")]);
    expect(s.finished).toBe(8);
    expect(s.avgFinished).toBeCloseTo(8 / 3);
    expect(s.costUsd).toBe(3.35);
    expect(s.runs).toBe(7);
    expect(s.reworkRate).toBeNull();
    expect(s.bestDay?.date).toBe("2026-10-14");
  });
  it("shows the rework rate from 10 runs, and no best day when nothing finished", () => {
    const s = summarizeStats([day("2026-10-14", { runs: 10, rework: 3 })]);
    expect(s.reworkRate).toBeCloseTo(0.3);
    expect(s.bestDay).toBeNull();
    expect(summarizeStats([])).toMatchObject({ finished: 0, avgFinished: 0, bestDay: null });
  });
});

describe("date labels", () => {
  it("reads a YYYY-MM-DD as a calendar date, never shifted by the timezone", () => {
    expect(weekdayLetter("2026-10-15")).toBe("T"); // a Thursday
    expect(weekdayLetter("2026-10-18")).toBe("S"); // a Sunday
    expect(shortDate("2026-10-14")).toBe("Oct 14");
  });
});

describe("latestChange", () => {
  it("is the ts of the newest meaningful event, so it stays stable while other events roll through", () => {
    expect(latestChange([ev("enqueued", "2026-10-15T12:09:00Z"), ev("run_end", "2026-10-15T12:05:00Z"), ev("failed", "2026-10-15T11:00:00Z")])).toBe("2026-10-15T12:05:00Z");
    expect(latestChange([ev("enqueued", "2026-10-15T12:09:00Z")])).toBe("");
    expect(latestChange([])).toBe("");
  });
});
