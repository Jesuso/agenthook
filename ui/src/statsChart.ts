import { max } from "d3-array";
import { scaleBand, scaleLinear } from "d3-scale";
import { curveMonotoneX, line } from "d3-shape";
import type { DayStats } from "./contract";
import { shortDate, weekdayLetter } from "./stats";

/** Plot margins in px: room for the left (tickets) and right ($ per ticket) axes and the day labels. */
export const MARGIN = { top: 10, right: 46, bottom: 22, left: 30 } as const;

export type Bar = { date: string; x: number; y: number; w: number; h: number; today: boolean };
export type Tick = { pos: number; label: string };

export type ChartModel = {
  bars: Bar[];
  /** SVG path of cost per finished ticket; null when no day has both a finished ticket and a cost. */
  line: string | null;
  dots: { date: string; x: number; y: number }[];
  /** Left axis (tickets finished), `pos` = y. */
  leftTicks: Tick[];
  /** Right axis (dollars per finished ticket), `pos` = y. */
  rightTicks: Tick[];
  /** Day labels, thinned to fit; `pos` = x. */
  xTicks: Tick[];
  /** The band centre x of each day, for hit-testing a pointer. */
  centers: number[];
  plot: { left: number; right: number; top: number; bottom: number };
};

/** A day's spend per ticket it finished; null when nothing finished or nothing was spent (the line breaks there). */
export function costPerTicket(d: Pick<DayStats, "finished" | "costUsd">): number | null {
  return d.finished > 0 && d.costUsd > 0 ? d.costUsd / d.finished : null;
}

/** "$7.6" / "$12" / "$0.80" — compact dollars for an axis. */
export function axisDollars(n: number): string {
  return n >= 10 ? `$${Math.round(n)}` : n >= 1 ? `$${n.toFixed(1).replace(/\.0$/, "")}` : `$${n.toFixed(2)}`;
}

/**
 * Everything the SVG needs, computed with d3 scales and shapes (no DOM): finished tickets as bars on
 * the left scale, cost per finished ticket as a line on the right one. Day labels follow `lang`. Pure.
 */
export function chartModel(days: DayStats[], width: number, height: number, lang = "en"): ChartModel {
  const left = MARGIN.left;
  const right = Math.max(left + 1, width - MARGIN.right);
  const top = MARGIN.top;
  const bottom = Math.max(top + 1, height - MARGIN.bottom);

  const x = scaleBand<string>().domain(days.map((d) => d.date)).range([left, right]).paddingInner(0.25).paddingOuter(0.1);
  const yBars = scaleLinear().domain([0, Math.max(1, max(days, (d) => d.finished) ?? 1)]).nice(3).range([bottom, top]);
  const cpt = days.map(costPerTicket);
  const yLine = scaleLinear().domain([0, Math.max(0.01, max(cpt, (v) => v ?? 0) ?? 0.01)]).nice(3).range([bottom, top]);

  const w = x.bandwidth();
  const today = days.length ? days[days.length - 1].date : "";
  const bars: Bar[] = days.map((d) => {
    const y = yBars(d.finished);
    return { date: d.date, x: x(d.date) ?? left, y, w, h: Math.max(d.finished > 0 ? 1 : 0, bottom - y), today: d.date === today };
  });
  const centers = bars.map((b) => b.x + w / 2);

  const path = line<number | null>()
    .defined((v) => v !== null)
    .curve(curveMonotoneX)
    .x((_, i) => centers[i])
    .y((v) => yLine(v as number))(cpt);
  const dots = cpt.flatMap((v, i) => (v === null ? [] : [{ date: days[i].date, x: centers[i], y: yLine(v) }]));

  // Thin the day labels so they never touch: ~34 px per label.
  const every = Math.max(1, Math.ceil(days.length / Math.max(1, Math.floor((right - left) / 34))));
  const xTicks = days.flatMap((d, i) => (i % every === (days.length - 1) % every ? [{ pos: centers[i], label: days.length <= 14 ? weekdayLetter(d.date, lang) : shortDate(d.date, lang) }] : []));

  return {
    bars,
    line: path,
    dots,
    leftTicks: yBars.ticks(3).map((t) => ({ pos: yBars(t), label: String(t) })),
    rightTicks: yLine.ticks(3).map((t) => ({ pos: yLine(t), label: axisDollars(t) })),
    xTicks,
    centers,
    plot: { left, right, top, bottom },
  };
}

/** Index of the day whose band centre is nearest to pointer x (in SVG units); -1 outside the plot. */
export function dayAt(model: Pick<ChartModel, "centers" | "plot">, px: number): number {
  if (!model.centers.length || px < model.plot.left || px > model.plot.right) return -1;
  let best = 0;
  for (let i = 1; i < model.centers.length; i++) if (Math.abs(model.centers[i] - px) < Math.abs(model.centers[best] - px)) best = i;
  return best;
}
