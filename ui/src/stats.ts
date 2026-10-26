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
  /** Rate-table estimates (src/pricing.js) — beside `costUsd`, never in it. */
  estUsd: number;
  /** Runs with neither a reported cost nor an estimate. */
  unestimatedRuns: number;
  /** Measured energy (src/energy.js) — beside both dollar figures, never in them. */
  energyKwh: number;
  energyUsd: number;
  runs: number;
  rework: number;
  /** null below MIN_RUNS_FOR_RATES: a rate over a handful of runs is noise. */
  reworkRate: number | null;
  bestDay: DayStats | null;
};

export function summarizeStats(days: DayStats[]): StatsSummary {
  let finished = 0;
  let costUsd = 0;
  let estUsd = 0;
  let unestimatedRuns = 0;
  let energyKwh = 0;
  let energyUsd = 0;
  let runs = 0;
  let rework = 0;
  let bestDay: DayStats | null = null;
  for (const d of days) {
    finished += d.finished;
    costUsd += d.costUsd;
    estUsd += d.estUsd ?? 0;
    unestimatedRuns += d.unestimatedRuns ?? 0;
    energyKwh += d.energyKwh ?? 0;
    energyUsd += d.energyUsd ?? 0;
    runs += d.runs;
    rework += d.rework;
    if (d.finished > 0 && (!bestDay || d.finished > bestDay.finished)) bestDay = d;
  }
  return {
    finished,
    avgFinished: days.length ? finished / days.length : 0,
    costUsd: Math.round(costUsd * 100) / 100,
    estUsd: Math.round(estUsd * 100) / 100,
    unestimatedRuns,
    // Not rounded to cents: a local run's electricity is a fraction of one.
    energyKwh: Math.round(energyKwh * 1e9) / 1e9,
    energyUsd: Math.round(energyUsd * 1e6) / 1e6,
    runs,
    rework,
    reworkRate: runs >= MIN_RUNS_FOR_RATES ? rework / runs : null,
    bestDay,
  };
}

const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];

/** "M" / "T" / … for a local YYYY-MM-DD (parsed as a calendar date, so no timezone shift). */
export function weekdayLetter(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return WEEKDAYS[new Date(y, m - 1, d).getDay()] ?? "";
}

/** "Oct 14" for a local YYYY-MM-DD; "14 oct" in es. */
export function shortDate(date: string, lang = "en"): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(lang === "en" ? "en-US" : lang, { month: "short", day: "numeric" });
}

/** The newest live event that changes the numbers (feed is newest first); "" when none — a refetch key, stable while the feed rolls. */
export function latestChange(feed: FeedEntry[]): string {
  const e = feed.find((f) => MEANINGFUL.has(String(f.event.event)));
  return e ? String(e.event.ts ?? "") : "";
}
