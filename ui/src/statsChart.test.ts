import { describe, it, expect } from "vitest";
import { axisDollars, chartModel, costPerTicket, dayAt, MARGIN } from "./statsChart";
import { day } from "./statsFixtures";

const week = [
  day("2026-10-12", { finished: 10, costUsd: 50 }),
  day("2026-10-13", { finished: 0 }),
  day("2026-10-14", { finished: 20, costUsd: 40 }),
  day("2026-10-15", { finished: 5, costUsd: 25 }),
];

describe("costPerTicket", () => {
  it("is the day's spend over the tickets it finished, null when either is missing", () => {
    expect(costPerTicket({ finished: 4, costUsd: 10 })).toBe(2.5);
    expect(costPerTicket({ finished: 0, costUsd: 10 })).toBeNull();
    expect(costPerTicket({ finished: 4, costUsd: 0 })).toBeNull();
  });
});

describe("axisDollars", () => {
  it("keeps axis labels short", () => {
    expect(axisDollars(12.4)).toBe("$12");
    expect(axisDollars(7.5)).toBe("$7.5");
    expect(axisDollars(2)).toBe("$2");
    expect(axisDollars(0.8)).toBe("$0.80");
  });
});

describe("chartModel", () => {
  const m = chartModel(week, 640, 190);

  it("draws one bar per day inside the plot, the tallest day tallest, today flagged", () => {
    expect(m.bars).toHaveLength(4);
    for (const b of m.bars) {
      expect(b.x).toBeGreaterThanOrEqual(m.plot.left);
      expect(b.x + b.w).toBeLessThanOrEqual(m.plot.right + 0.001);
      expect(b.y + b.h).toBeLessThanOrEqual(m.plot.bottom + 0.001);
    }
    const [mon, tue, wed, thu] = m.bars;
    expect(wed.h).toBeGreaterThan(mon.h);
    expect(mon.h).toBeGreaterThan(thu.h);
    expect(tue.h).toBe(0); // nothing finished: no bar, not a sliver
    expect(m.bars.map((b) => b.today)).toEqual([false, false, false, true]);
  });

  it("breaks the cost line on a day with no finished ticket and marks the others with dots", () => {
    expect(m.dots.map((d) => d.date)).toEqual(["2026-10-12", "2026-10-14", "2026-10-15"]);
    expect((m.line ?? "").match(/M/g)).toHaveLength(2); // two segments: Mon alone, Wed→Thu
  });

  it("has axes with labels and day labels that stay inside the plot", () => {
    expect(m.leftTicks.length).toBeGreaterThan(1);
    expect(m.leftTicks.at(0)?.label).toBe("0");
    expect(m.rightTicks.every((t) => t.label.startsWith("$"))).toBe(true);
    expect(m.xTicks.map((t) => t.label)).toEqual(["M", "T", "W", "T"]);
    for (const t of m.xTicks) expect(t.pos).toBeGreaterThan(m.plot.left);
  });

  it("thins the day labels on a long range so they cannot overlap", () => {
    const many = Array.from({ length: 30 }, (_, i) => day(`2026-09-${String(i + 1).padStart(2, "0")}`, { finished: i }));
    const long = chartModel(many, 640, 190);
    expect(long.xTicks.length).toBeLessThan(30);
    expect(long.xTicks.length).toBeGreaterThan(3);
    const xs = long.xTicks.map((t) => t.pos);
    for (let i = 1; i < xs.length; i++) expect(xs[i] - xs[i - 1]).toBeGreaterThanOrEqual(30);
  });

  it("survives empty and all-zero input and tiny widths", () => {
    expect(chartModel([], 640, 190).bars).toEqual([]);
    const zero = chartModel([day("2026-10-15")], 640, 190);
    expect(zero.line).toBeNull();
    expect(zero.dots).toEqual([]);
    expect(Number.isFinite(zero.bars[0].x)).toBe(true);
    expect(chartModel(week, 10, 10).plot.right).toBeGreaterThan(MARGIN.left);
  });
});

describe("dayAt", () => {
  it("maps a pointer x to the nearest day and -1 outside the plot", () => {
    const m = chartModel(week, 640, 190);
    expect(dayAt(m, m.centers[2] + 3)).toBe(2);
    expect(dayAt(m, m.centers[0])).toBe(0);
    expect(dayAt(m, 1)).toBe(-1);
    expect(dayAt(m, 639)).toBe(-1);
    expect(dayAt({ centers: [], plot: m.plot }, 100)).toBe(-1);
  });
});
