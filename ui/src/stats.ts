import type { DayStats } from "./contract";
import { MEANINGFUL } from "./digest";
import type { FeedEntry } from "./feed";
import { MIN_RUNS_FOR_RATES } from "./zones";

export const RANGES = [7, 14, 30] as const;
export type Range = (typeof RANGES)[number];
export const DEFAULT_RANGE: Range = 14;

/** `GET /api/stats` for the profile; `tz` makes the server cut days at this browser's midnight. */
export function statsUrl(profile: string, days: number, tzOffset: number = new Date().getTimezoneOffset()): string {
  return `/api/stats?profile=${encodeURIComponent(profile)}&days=${days}&tz=${tzOffset}`;
}

export type StatsSummary = {
  finished: number;
  /** finished per day over the days that had passed (today counts as a day). */
  avgFinished: number;
  costUsd: number;
  runs: number;
  rework: number;
  /** null below MIN_RUNS_FOR_RATES: a rate over a handful of runs is noise. */
  reworkRate: number | null;
  bestDay: DayStats | null;
};

export function summarizeStats(days: DayStats[]): StatsSummary {
  let finished = 0;
  let costUsd = 0;
  let runs = 0;
  let rework = 0;
  let bestDay: DayStats | null = null;
  for (const d of days) {
    finished += d.finished;
    costUsd += d.costUsd;
    runs += d.runs;
    rework += d.rework;
    if (d.finished > 0 && (!bestDay || d.finished > bestDay.finished)) bestDay = d;
  }
  return {
    finished,
    avgFinished: days.length ? finished / days.length : 0,
    costUsd: Math.round(costUsd * 100) / 100,
    runs,
    rework,
    reworkRate: runs >= MIN_RUNS_FOR_RATES ? rework / runs : null,
    bestDay,
  };
}

/** Bar heights as percentages of the tallest; a non-zero value is never thinner than `floor`, zero is 0. */
export function barHeights(values: number[], floor = 6): number[] {
  const max = Math.max(0, ...values);
  if (max <= 0) return values.map(() => 0);
  return values.map((v) => (v > 0 ? Math.max(floor, (v / max) * 100) : 0));
}

const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];

/** "M" / "T" / … for a local YYYY-MM-DD (parsed as a calendar date, so no timezone shift). */
export function weekdayLetter(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return WEEKDAYS[new Date(y, m - 1, d).getDay()] ?? "";
}

/** "Oct 14" for a local YYYY-MM-DD. */
export function shortDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** The newest live event that changes the numbers (feed is newest first); "" when none — a refetch key, stable while the feed rolls. */
export function latestChange(feed: FeedEntry[]): string {
  const e = feed.find((f) => MEANINGFUL.has(String(f.event.event)));
  return e ? String(e.event.ts ?? "") : "";
}
