import { describe, it, expect } from "vitest";
import { epicSparkline, SPARK_PAD } from "./epicSparkline";
import { day } from "./statsFixtures";

const days = (counts: number[]) => counts.map((finished, i) => day(`2026-10-${String(i + 1).padStart(2, "0")}`, { finished }));

describe("epicSparkline", () => {
  it("one point per day, oldest first, spanning the padded width", () => {
    const m = epicSparkline(days([0, 2, 1, 0, 3, 0, 0, 1, 0, 0, 2, 0, 0, 1]), 140, 30);
    expect(m.points).toHaveLength(14);
    expect(m.points[0].x).toBeCloseTo(SPARK_PAD);
    expect(m.points[13].x).toBeCloseTo(140 - SPARK_PAD);
    expect(m.points.map((p) => p.date)).toEqual([...m.points.map((p) => p.date)].sort());
    expect(m.max).toBe(3);
    expect(m.line).toMatch(/^M/);
    expect(m.area).toMatch(/^M/);
  });

  it("the busiest day is highest, a zero day sits on the baseline", () => {
    const m = epicSparkline(days([0, 3, 1]), 100, 30);
    expect(m.points[1].y).toBeCloseTo(SPARK_PAD);
    expect(m.points[0].y).toBeCloseTo(30 - SPARK_PAD);
    expect(m.points[2].y).toBeGreaterThan(m.points[1].y);
  });

  it("is empty-safe: no days → no points or paths; an all-zero window draws a flat baseline", () => {
    expect(epicSparkline([], 100, 30)).toEqual({ points: [], line: null, area: null, max: 1 });
    const flat = epicSparkline(days([0, 0, 0]), 100, 30);
    expect(flat.points.every((p) => p.y === 30 - SPARK_PAD)).toBe(true);
    expect(flat.max).toBe(1);
  });

  it("centres a single day and survives a degenerate size", () => {
    const one = epicSparkline(days([2]), 100, 30);
    expect(one.points).toHaveLength(1);
    expect(one.points[0].x).toBeCloseTo(50);
    expect(() => epicSparkline(days([1, 2]), 0, 0)).not.toThrow();
  });
});
