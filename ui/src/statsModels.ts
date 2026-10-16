// Pure geometry for the Stats view's four charts (docs/web-ui.md § Daily stats). d3 scales,
// stacks and arrays do the maths; nothing here touches the DOM, so every chart is unit-tested
// and the React components only draw what these return.
import { max } from "d3-array";
import { scaleBand, scaleLinear, scaleSqrt } from "d3-scale";
import { stack, stackOffsetDiverging } from "d3-shape";
import type { DayStats } from "./contract";
import { shortDate, weekdayLetter } from "./stats";
import { axisDollars } from "./statsChart";

export const M = { top: 10, right: 12, bottom: 22, left: 40 } as const;
export type Tick = { pos: number; label: string };

/** Palette for series (pipeline steps), by rank: the profile identity hues (none of the status colours), ordered so neighbours contrast. */
export const SERIES_COLORS = ["sky", "pink", "stone", "violet", "teal", "indigo", "cyan", "slate"].map((c) => `var(--color-profile-${c})`);
/** Steps beyond the palette are folded into this series. */
export const OTHER_STEPS = "other";

type Frame = { plot: { left: number; right: number; top: number; bottom: number }; centers: number[]; xTicks: Tick[]; bandwidth: number; x: (date: string) => number };

/** Shared x layout: one band per day, thinned day labels (~34 px each). */
function frame(days: DayStats[], width: number, height: number): Frame {
  const left = M.left;
  const right = Math.max(left + 1, width - M.right);
  const top = M.top;
  const bottom = Math.max(top + 1, height - M.bottom);
  const x = scaleBand<string>().domain(days.map((d) => d.date)).range([left, right]).paddingInner(0.25).paddingOuter(0.1);
  const centers = days.map((d) => (x(d.date) ?? left) + x.bandwidth() / 2);
  const every = Math.max(1, Math.ceil(days.length / Math.max(1, Math.floor((right - left) / 34))));
  const xTicks = days.flatMap((d, i) => (i % every === (days.length - 1) % every ? [{ pos: centers[i], label: days.length <= 14 ? weekdayLetter(d.date) : shortDate(d.date) }] : []));
  return { plot: { left, right, top, bottom }, centers, xTicks, bandwidth: x.bandwidth(), x: (date) => x(date) ?? left };
}

/** Index of the day whose centre is nearest `px`, -1 outside the plot. */
export function nearestDay(m: { centers: number[]; plot: { left: number; right: number } }, px: number): number {
  if (!m.centers.length || px < m.plot.left || px > m.plot.right) return -1;
  let best = 0;
  for (let i = 1; i < m.centers.length; i++) if (Math.abs(m.centers[i] - px) < Math.abs(m.centers[best] - px)) best = i;
  return best;
}

// --------------------------------------------------------------------------- 1. spend by step (stacked bars)

export type Segment = { date: string; series: string; x: number; y: number; w: number; h: number; value: number };
export type StackedModel = Frame & { segments: Segment[]; legend: { series: string; color: string; total: number }[]; yTicks: Tick[] };

/** Series (steps) ranked by total spend; beyond the palette the rest become `other`. */
export function rankSteps(days: DayStats[], keep = SERIES_COLORS.length): string[] {
  const total = new Map<string, number>();
  for (const d of days) for (const [k, v] of Object.entries(d.byStep)) total.set(k, (total.get(k) ?? 0) + v.costUsd);
  const ranked = [...total.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k]) => k);
  return ranked.length > keep ? [...ranked.slice(0, keep - 1), OTHER_STEPS] : ranked;
}

/** Spend on `series` that day (the folded `other` series sums every step outside `shown`). */
function spend(d: DayStats, series: string, shown: string[]): number {
  if (series !== OTHER_STEPS) return d.byStep[series]?.costUsd ?? 0;
  return Object.entries(d.byStep).reduce((n, [k, v]) => (shown.includes(k) ? n : n + v.costUsd), 0);
}

export function stackedModel(days: DayStats[], width: number, height: number): StackedModel {
  const f = frame(days, width, height);
  const series = rankSteps(days);
  const shown = series.filter((s) => s !== OTHER_STEPS);
  const rows = days.map((d) => ({ date: d.date, ...Object.fromEntries(series.map((s) => [s, spend(d, s, shown)])) }) as Record<string, number | string>);
  const layers = stack<Record<string, number | string>>().keys(series).value((r, k) => Number(r[k]))(rows);
  const top = max(layers, (l) => max(l, (p) => p[1]) ?? 0) ?? 0;
  const y = scaleLinear().domain([0, Math.max(0.01, top)]).nice(3).range([f.plot.bottom, f.plot.top]);
  const segments: Segment[] = layers.flatMap((layer) =>
    layer.flatMap((p, i) => (p[1] - p[0] > 0 ? [{ date: days[i].date, series: layer.key, x: f.x(days[i].date), y: y(p[1]), w: f.bandwidth, h: y(p[0]) - y(p[1]), value: p[1] - p[0] }] : [])),
  );
  const legend = series.map((s, i) => ({ series: s, color: SERIES_COLORS[i % SERIES_COLORS.length], total: days.reduce((n, d) => n + spend(d, s, shown), 0) }));
  return { ...f, segments, legend, yTicks: y.ticks(3).map((t) => ({ pos: y(t), label: axisDollars(t) })) };
}

// --------------------------------------------------------------------------- 2. outcomes (diverging bars)

/** Run outcomes in drawing order: `advance` goes up, the rest hang below the baseline, nearest first. */
export const UP = ["advance"] as const;
export const DOWN = ["changes", "hold", "fail"] as const;
export type Outcome = (typeof UP)[number] | (typeof DOWN)[number];
export type OutcomeSegment = { date: string; outcome: Outcome; x: number; y: number; w: number; h: number; value: number };
export type DivergingModel = Frame & { segments: OutcomeSegment[]; baseline: number; yTicks: Tick[] };

export function divergingModel(days: DayStats[], width: number, height: number): DivergingModel {
  const f = frame(days, width, height);
  const keys: Outcome[] = [...UP, ...DOWN];
  const rows = days.map((d) => ({ date: d.date, advance: d.outcomes.advance, changes: -d.outcomes.changes, hold: -d.outcomes.hold, fail: -d.outcomes.fail }) as Record<string, number | string>);
  const layers = stack<Record<string, number | string>>().keys(keys).value((r, k) => Number(r[k])).offset(stackOffsetDiverging)(rows);
  const lo = Math.min(0, ...layers.flatMap((l) => l.map((p) => Math.min(p[0], p[1]))));
  const hi = Math.max(1, ...layers.flatMap((l) => l.map((p) => Math.max(p[0], p[1]))));
  const y = scaleLinear().domain([lo, hi]).nice(4).range([f.plot.bottom, f.plot.top]);
  const segments: OutcomeSegment[] = layers.flatMap((layer) =>
    layer.flatMap((p, i) => {
      const v = Math.abs(p[1] - p[0]);
      return v > 0 ? [{ date: days[i].date, outcome: layer.key as Outcome, x: f.x(days[i].date), y: y(Math.max(p[0], p[1])), w: f.bandwidth, h: Math.abs(y(p[0]) - y(p[1])), value: v }] : [];
    }),
  );
  return { ...f, segments, baseline: y(0), yTicks: y.ticks(4).map((t) => ({ pos: y(t), label: String(Math.abs(t)) })) };
}

// --------------------------------------------------------------------------- 3. calendar heatmap

export type Cell = { date: string; x: number; y: number; size: number; finished: number; opacity: number };
export type CalendarModel = { cells: Cell[]; months: Tick[]; weekdays: Tick[]; width: number; height: number; size: number; max: number };

const CAL_LEFT = 26;
const CAL_TOP = 16;
const GAP = 2;

/** GitHub-style grid: a column per week (Sunday first), a row per weekday; cell opacity ~ √(finished). */
export function calendarModel(days: DayStats[], width: number): CalendarModel {
  if (!days.length) return { cells: [], months: [], weekdays: [], width, height: CAL_TOP, size: 0, max: 0 };
  const parts = (date: string) => date.split("-").map(Number) as [number, number, number];
  const dow = (date: string) => {
    const [y, m, d] = parts(date);
    return new Date(y, m - 1, d).getDay();
  };
  const first = days[0].date;
  // Whole weeks between the first day's Sunday and each day (calendar arithmetic in UTC avoids DST drift).
  const sundayOf = (date: string) => {
    const [y, m, d] = parts(date);
    return Date.UTC(y, m - 1, d - dow(date));
  };
  const week0 = sundayOf(first);
  const weeks = Math.round((sundayOf(days[days.length - 1].date) - week0) / (7 * 86400000)) + 1;
  const size = Math.max(7, Math.min(22, Math.floor((width - CAL_LEFT) / weeks) - GAP));
  const peak = max(days, (d) => d.finished) ?? 0;
  const alpha = scaleSqrt().domain([0, Math.max(1, peak)]).range([0.22, 1]);
  const cells: Cell[] = days.map((d) => {
    const col = Math.round((sundayOf(d.date) - week0) / (7 * 86400000));
    return { date: d.date, x: CAL_LEFT + col * (size + GAP), y: CAL_TOP + dow(d.date) * (size + GAP), size, finished: d.finished, opacity: d.finished > 0 ? alpha(d.finished) : 0 };
  });
  const months: Tick[] = [];
  let last = -1;
  for (const c of cells) {
    const [, m, dd] = parts(c.date);
    if (m !== last && dd <= 7) {
      months.push({ pos: c.x, label: new Date(2000, m - 1, 1).toLocaleDateString("en-US", { month: "short" }) });
      last = m;
    }
  }
  const weekdays: Tick[] = [1, 3, 5].map((r) => ({ pos: CAL_TOP + r * (size + GAP) + size / 2, label: ["", "M", "", "W", "", "F", ""][r] }));
  return { cells, months, weekdays, width: CAL_LEFT + weeks * (size + GAP), height: CAL_TOP + 7 * (size + GAP), size, max: peak };
}

// --------------------------------------------------------------------------- 4. what a finished ticket cost (range)

export type RangePoint = { date: string; x: number; yLow: number; yMid: number; yHigh: number; n: number };
export type RangeModel = Frame & { points: RangePoint[]; yTicks: Tick[]; trend: string | null };

/** p10–p90 spread and median of what the tickets finished each day cost; days with none are gaps. */
export function rangeModel(days: DayStats[], width: number, height: number): RangeModel {
  const f = frame(days, width, height);
  const hi = max(days, (d) => d.ticketCost?.p90 ?? 0) ?? 0;
  const y = scaleLinear().domain([0, Math.max(0.01, hi)]).nice(3).range([f.plot.bottom, f.plot.top]);
  const points: RangePoint[] = days.flatMap((d, i) => (d.ticketCost ? [{ date: d.date, x: f.centers[i], yLow: y(d.ticketCost.p10), yMid: y(d.ticketCost.p50), yHigh: y(d.ticketCost.p90), n: d.ticketCost.n }] : []));
  const trend = points.length > 1 ? points.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)},${p.yMid.toFixed(1)}`).join("") : null;
  return { ...f, points, yTicks: y.ticks(3).map((t) => ({ pos: y(t), label: axisDollars(t) })), trend };
}
