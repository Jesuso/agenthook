import { describe, it, expect } from "vitest";
import { calendarModel, divergingModel, nearestDay, rangeModel, rankSteps, stackedModel, OTHER_STEPS, SERIES_COLORS } from "./statsModels";
import { day } from "./statsFixtures";

const steps = (triage: number, code: number, review: number) => ({ triage: { runs: 1, costUsd: triage, estUsd: 0 }, code: { runs: 1, costUsd: code, estUsd: 0 }, review: { runs: 1, costUsd: review, estUsd: 0 } });
const week = [
  day("2026-10-12", { byStep: steps(1, 6, 2), costUsd: 9, estUsd: 0 }),
  day("2026-10-13"),
  day("2026-10-14", { byStep: steps(0.5, 3, 1), costUsd: 4.5, estUsd: 0 }),
];

describe("rankSteps", () => {
  it("orders steps by total spend and folds the tail into 'other' past the palette", () => {
    expect(rankSteps(week)).toEqual(["code", "review", "triage"]);
    const many = day("2026-10-12", { byStep: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`s${i}`, { runs: 1, costUsd: 12 - i, estUsd: 0 }])) });
    const r = rankSteps([many]);
    expect(r).toHaveLength(SERIES_COLORS.length);
    expect(r.at(-1)).toBe(OTHER_STEPS);
    expect(r[0]).toBe("s0");
  });
  it("ignores steps that cost nothing", () => {
    expect(rankSteps([day("2026-10-12", { byStep: { a: { runs: 3, costUsd: 0, estUsd: 0 } } })])).toEqual([]);
  });
});

describe("stackedModel", () => {
  const m = stackedModel(week, 640, 190);
  it("stacks each day's step spend into one column whose height is the day's total", () => {
    const mon = m.segments.filter((s) => s.date === "2026-10-12");
    expect(mon.map((s) => s.series).sort()).toEqual(["code", "review", "triage"]);
    expect(mon.reduce((n, s) => n + s.value, 0)).toBeCloseTo(9);
    const tops = Math.min(...mon.map((s) => s.y));
    const bottoms = Math.max(...mon.map((s) => s.y + s.h));
    expect(bottoms).toBeCloseTo(m.plot.bottom, 3);
    expect(tops).toBeLessThan(bottoms);
    expect(m.segments.some((s) => s.date === "2026-10-13")).toBe(false); // a zero day draws nothing
  });
  it("gives every series a colour and a total for the legend, ordered like the stack", () => {
    expect(m.legend.map((l) => l.series)).toEqual(["code", "review", "triage"]);
    expect(m.legend[0].total).toBeCloseTo(9);
    expect(new Set(m.legend.map((l) => l.color)).size).toBe(3);
  });
  it("folds steps beyond the palette into one 'other' series without losing spend", () => {
    const many = day("2026-10-12", { byStep: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`s${i}`, { runs: 1, costUsd: 1, estUsd: 0 }])) });
    const mm = stackedModel([many], 640, 190);
    expect(mm.legend.at(-1)?.series).toBe(OTHER_STEPS);
    expect(mm.segments.reduce((n, s) => n + s.value, 0)).toBeCloseTo(12);
  });
  it("stacks a step's estimate as its own series right above its reported spend, never summed into it", () => {
    const e = stackedModel([day("2026-10-12", { byStep: { code: { runs: 2, costUsd: 3, estUsd: 1 }, review: { runs: 1, costUsd: 0, estUsd: 2 } }, unestimatedRuns: 4 })], 640, 190);
    expect(e.segments.map((s) => [s.series, s.est, s.value])).toEqual([["code", false, 3], ["code", true, 1], ["review", true, 2]]);
    expect(e.legend).toEqual([expect.objectContaining({ series: "code", total: 3, est: 1 }), expect.objectContaining({ series: "review", total: 0, est: 2 })]);
    expect(e.unestimatedRuns).toBe(4);
  });
  it("is empty and finite with no spend", () => {
    const z = stackedModel([day("2026-10-12")], 640, 190);
    expect(z.segments).toEqual([]);
    expect(z.yTicks.every((t) => Number.isFinite(t.pos))).toBe(true);
  });
});

describe("divergingModel", () => {
  const days = [day("2026-10-12", { outcomes: { advance: 8, changes: 3, hold: 1, fail: 2, other: 0 } }), day("2026-10-13", { outcomes: { advance: 2, changes: 0, hold: 0, fail: 0, other: 0 } })];
  const m = divergingModel(days, 640, 190);
  it("puts advances above the baseline and changes/hold/fail below it", () => {
    for (const s of m.segments) {
      if (s.outcome === "advance") expect(s.y + s.h).toBeLessThanOrEqual(m.baseline + 0.001);
      else expect(s.y).toBeGreaterThanOrEqual(m.baseline - 0.001);
    }
    const mon = m.segments.filter((s) => s.date === "2026-10-12");
    expect(mon.find((s) => s.outcome === "advance")?.value).toBe(8);
    expect(mon.filter((s) => s.outcome !== "advance").reduce((n, s) => n + s.value, 0)).toBe(6);
  });
  it("draws the below-baseline outcomes nearest-first: changes, then hold, then fail", () => {
    const below = m.segments.filter((s) => s.date === "2026-10-12" && s.outcome !== "advance").sort((a, b) => a.y - b.y);
    expect(below.map((s) => s.outcome)).toEqual(["changes", "hold", "fail"]);
  });
  it("labels both axis directions with positive counts", () => {
    expect(m.yTicks.every((t) => /^\d+$/.test(t.label))).toBe(true);
  });
});

describe("calendarModel", () => {
  const span = (n: number, start = new Date(2026, 8, 14)) =>
    Array.from({ length: n }, (_, i) => {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      return day(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`, { finished: i % 7 === 0 ? 0 : i });
    });

  it("lays days out in week columns and weekday rows (Sunday first)", () => {
    const m = calendarModel(span(30), 640); // 2026-09-14 is a Monday
    expect(m.cells[0].y).toBeGreaterThan(m.cells[6].y - 1); // Mon is row 1, the next Sunday row 0
    const sun = m.cells.find((c) => c.date === "2026-09-20")!;
    const mon = m.cells.find((c) => c.date === "2026-09-14")!;
    expect(sun.x).toBeGreaterThan(mon.x); // the Sunday after starts a new column
    expect(sun.y).toBeLessThan(mon.y);
    const cols = new Set(m.cells.map((c) => c.x));
    expect(cols.size).toBe(5);
  });
  it("shades by the square root of finished, zero days are blank, and the busiest day is fully opaque", () => {
    const m = calendarModel(span(30), 640);
    expect(m.cells.filter((c) => c.finished === 0).every((c) => c.opacity === 0)).toBe(true);
    const busiest = m.cells.reduce((a, b) => (b.finished > a.finished ? b : a));
    expect(busiest.opacity).toBe(1);
    expect(m.max).toBe(busiest.finished);
    const small = m.cells.find((c) => c.finished === 1)!;
    expect(small.opacity).toBeGreaterThan(0.22);
    expect(small.opacity).toBeLessThan(busiest.opacity);
  });
  it("labels months where one starts and keeps cells square and inside the width", () => {
    const m = calendarModel(span(60), 640);
    expect(m.months.map((t) => t.label)).toContain("Oct");
    expect(m.width).toBeLessThanOrEqual(640);
    expect(m.size).toBeGreaterThanOrEqual(7);
    expect(m.size).toBeLessThanOrEqual(22);
  });
  it("handles a long history (26 weeks) and empty input", () => {
    const m = calendarModel(span(182, new Date(2026, 3, 16)), 640);
    expect(m.cells).toHaveLength(182);
    expect(m.width).toBeLessThanOrEqual(640);
    expect(calendarModel([], 640).cells).toEqual([]);
  });
});

describe("rangeModel", () => {
  const days = [
    day("2026-10-12", { ticketCost: { n: 5, p10: 2, p50: 6, p90: 14 } }),
    day("2026-10-13"),
    day("2026-10-14", { ticketCost: { n: 3, p10: 1, p50: 2, p90: 3 } }),
  ];
  const m = rangeModel(days, 640, 190);
  it("draws p10–p90 spans around the median, skipping days with no costed tickets", () => {
    expect(m.points.map((p) => p.date)).toEqual(["2026-10-12", "2026-10-14"]);
    for (const p of m.points) {
      expect(p.yHigh).toBeLessThanOrEqual(p.yMid);
      expect(p.yMid).toBeLessThanOrEqual(p.yLow); // SVG y grows downward
    }
    expect(m.points[0].n).toBe(5);
    expect(m.trend).toMatch(/^M[\d.]+,[\d.]+L[\d.]+,[\d.]+$/);
  });
  it("has no trend line for fewer than two points and no points for no data", () => {
    expect(rangeModel([days[0]], 640, 190).trend).toBeNull();
    expect(rangeModel([day("2026-10-12")], 640, 190).points).toEqual([]);
  });
});

describe("nearestDay", () => {
  it("maps x to the closest day, -1 outside the plot", () => {
    const m = stackedModel(week, 640, 190);
    expect(nearestDay(m, m.centers[1] + 2)).toBe(1);
    expect(nearestDay(m, 1)).toBe(-1);
  });
});
