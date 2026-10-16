import { max } from "d3-array";
import { scalePoint, scaleLinear } from "d3-scale";
import { area, curveMonotoneX, line } from "d3-shape";
import type { DayStats } from "./contract";

/** Inset in px so the end dots and the stroke never clip at the SVG edge. */
export const SPARK_PAD = 3;

export type SparkPoint = { date: string; finished: number; x: number; y: number };

export type SparkModel = {
  /** One per day, oldest first (same length as the input). */
  points: SparkPoint[];
  /** SVG path of finished per day; null with no days. */
  line: string | null;
  /** The same series filled down to zero; null with no days. */
  area: string | null;
  /** The y-axis top (≥ 1, so an all-zero window draws a flat baseline). */
  max: number;
};

/**
 * An epic's velocity sparkline (tickets finished per day over the window), computed with d3 scales
 * and shapes like statsChart.ts — no DOM, pure. Empty `days` → no points, no paths.
 */
export function epicSparkline(days: Pick<DayStats, "date" | "finished">[], width: number, height: number): SparkModel {
  const left = SPARK_PAD;
  const right = Math.max(left + 1, width - SPARK_PAD);
  const top = SPARK_PAD;
  const bottom = Math.max(top + 1, height - SPARK_PAD);
  const top1 = Math.max(1, max(days, (d) => d.finished) ?? 0);
  const x = scalePoint<string>().domain(days.map((d) => d.date)).range([left, right]).align(0.5);
  const y = scaleLinear().domain([0, top1]).range([bottom, top]);
  // A one-day window has no span: centre its point.
  const xOf = (date: string) => (days.length === 1 ? (left + right) / 2 : x(date) ?? left);
  const points = days.map((d) => ({ date: d.date, finished: d.finished, x: xOf(d.date), y: y(d.finished) }));
  if (!points.length) return { points, line: null, area: null, max: top1 };
  const lineGen = line<SparkPoint>().curve(curveMonotoneX).x((p) => p.x).y((p) => p.y);
  const areaGen = area<SparkPoint>().curve(curveMonotoneX).x((p) => p.x).y0(bottom).y1((p) => p.y);
  return { points, line: lineGen(points), area: areaGen(points), max: top1 };
}
