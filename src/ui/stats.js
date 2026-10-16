// Per-day activity stats for `ah ui` (docs/web-ui.md, "Daily stats"). A pure reader: the whole
// of a profile's events.jsonl is a complete append-only history, so day buckets are derived from
// it on demand — no rollup file, no engine write path, history back to the first run. Only the
// fields stats need are kept per event, appended incrementally by byte offset (the file is
// append-only; a shrink restarts the read). Days are cut at the *caller's* midnight
// (`tzOffset` = `Date.getTimezoneOffset()` minutes), so they match the browser's "today".
import fs from "node:fs";

export const STATS_MAX_DAYS = 366;
const READ_CAP_BYTES = 64 * 1024 * 1024; // a bigger history is read from its last 64 MB
const DAY_MS = 24 * 3600 * 1000;
const KEEP = new Set(["pipeline_done", "merged", "run_end", "run_start"]);
const OUTCOMES = ["advance", "changes", "hold", "fail"];

/**
 * One calendar day. `finished`/`merged`/`failedTickets` count distinct tickets (a ref can emit
 * `pipeline_done` several times within seconds), `runs`/`rework`/`failedRuns` count `run_end`s.
 * @typedef {object} DayStats
 * @property {string} date          local YYYY-MM-DD
 * @property {number} finished      distinct tickets that reached the terminal step
 * @property {number} merged        distinct tickets whose PR merged (forge profiles only)
 * @property {number} runs          agent runs that ended
 * @property {number} rework        of those, ended `changes`
 * @property {number} failedRuns    of those, ended `fail`
 * @property {number} costUsd       sum of run_end costs
 * @property {Record<string, { runs: number, costUsd: number }>} byStep   run_end count and cost per pipeline step
 * @property {{ advance: number, changes: number, hold: number, fail: number, other: number }} outcomes   run_end outcomes
 * @property {{ n: number, p10: number, p50: number, p90: number }|null} ticketCost   what the tickets that finished this day
 *           cost in total: the agent runs on each since its previous finish. Null when none of them had a costed run
 *           (hand-finished tickets have no agent runs, so they are not in it).
 */

/**
 * @typedef {object} StatsView
 * @property {DayStats[]} days      oldest first, zero-filled, the last one is today
 * @property {string|null} since    ISO ts of the first event in the history (null: none), so the UI can say how far back "all" goes
 */

/** @param {number} ts @param {number} tzOffset */
const dayKey = (ts, tzOffset) => new Date(ts - tzOffset * 60000).toISOString().slice(0, 10);

/** Linear-interpolated quantile of an ascending-sorted array. @param {number[]} sorted @param {number} q */
export function quantile(sorted, q) {
  if (!sorted.length) return 0;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

/**
 * Bucket events (oldest first) into the last `days` local days. Pure.
 * @param {Record<string, any>[]} events
 * @param {{ now?: number, days?: number, tzOffset?: number }} [o]
 * @returns {DayStats[]}
 */
export function dailyStats(events, { now = Date.now(), days = 14, tzOffset = 0 } = {}) {
  const n = Math.min(STATS_MAX_DAYS, Math.max(1, Math.floor(days)));
  /** @typedef {DayStats & { _f: Set<string>, _m: Set<string>, _tc: number[] }} Bucket */
  /** @type {Map<string, Bucket>} */
  const byDay = new Map();
  for (let i = n - 1; i >= 0; i--) {
    const date = dayKey(now - i * DAY_MS, tzOffset);
    byDay.set(date, {
      date, finished: 0, merged: 0, runs: 0, rework: 0, failedRuns: 0, costUsd: 0, byStep: {},
      outcomes: { advance: 0, changes: 0, hold: 0, fail: 0, other: 0 }, ticketCost: null, _f: new Set(), _m: new Set(), _tc: [],
    });
  }
  /** Agent spend on a ticket since it last finished (the cost of getting it finished); runs before the window count too. @type {Map<string, number>} */
  const sinceFinish = new Map();
  for (const e of events) {
    const ts = Date.parse(e.ts);
    if (Number.isNaN(ts)) continue;
    const ref = String(e.ref);
    const cost = typeof e.costUsd === "number" && Number.isFinite(e.costUsd) ? e.costUsd : 0;
    if (e.event === "run_end" && cost) sinceFinish.set(ref, (sinceFinish.get(ref) ?? 0) + cost);
    const d = byDay.get(dayKey(ts, tzOffset));
    if (e.event === "pipeline_done") {
      const spent = sinceFinish.get(ref) ?? 0;
      if (spent > 0) {
        sinceFinish.set(ref, 0); // a burst of duplicate pipeline_done counts the ticket once
        d?._tc.push(spent);
      }
      d?._f.add(ref);
    } else if (!d) {
      continue;
    } else if (e.event === "merged") d._m.add(ref);
    else if (e.event === "run_end") {
      d.runs++;
      d.costUsd += cost;
      if (e.outcome === "changes") d.rework++;
      else if (e.outcome === "fail") d.failedRuns++;
      d.outcomes[/** @type {"advance"|"changes"|"hold"|"fail"|"other"} */ (OUTCOMES.includes(e.outcome) ? e.outcome : "other")]++;
      const step = typeof e.step === "string" && e.step ? e.step : "?";
      const st = (d.byStep[step] ??= { runs: 0, costUsd: 0 });
      st.runs++;
      st.costUsd += cost;
    }
  }
  const r2 = (/** @type {number} */ v) => Math.round(v * 100) / 100;
  return [...byDay.values()].map(({ _f, _m, _tc, ...d }) => {
    const sorted = [..._tc].sort((a, b) => a - b);
    return {
      ...d,
      finished: _f.size,
      merged: _m.size,
      costUsd: r2(d.costUsd),
      byStep: Object.fromEntries(Object.entries(d.byStep).map(([k, v]) => [k, { runs: v.runs, costUsd: r2(v.costUsd) }])),
      ticketCost: sorted.length ? { n: sorted.length, p10: r2(quantile(sorted, 0.1)), p50: r2(quantile(sorted, 0.5)), p90: r2(quantile(sorted, 0.9)) } : null,
    };
  });
}

/** @type {Map<string, { offset: number, capped: boolean, since: string|null, events: Record<string, any>[] }>} */
const cache = new Map();

/** Drop all cached histories (tests). */
export function resetStatsCache() {
  cache.clear();
}

/**
 * The kept events from `file` (its events.jsonl), reading only what was appended since the last
 * call. A missing file reads as an empty history.
 * @param {string} file
 * @returns {{ events: Record<string, any>[], since: string|null }}
 */
export function readHistory(file) {
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    cache.delete(file);
    return { events: [], since: null };
  }
  let c = cache.get(file);
  if (!c || size < c.offset) {
    const offset = Math.max(0, size - READ_CAP_BYTES);
    c = { offset, capped: offset > 0, since: null, events: [] };
    cache.set(file, c);
  }
  if (size > c.offset) {
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(size - c.offset);
      fs.readSync(fd, buf, 0, buf.length, c.offset);
      // Whole lines only: a line still being written is picked up whole next time. A capped
      // first read starts mid-line, so its first fragment is skipped.
      const end = buf.lastIndexOf(10) + 1;
      const start = c.capped ? buf.indexOf(10) + 1 : 0;
      if (end > 0) {
        c.offset += end;
        c.capped = false;
        for (const line of buf.subarray(Math.min(start, end), end).toString("utf8").split("\n")) {
          if (!line) continue;
          let e;
          try {
            e = JSON.parse(line);
          } catch {
            continue;
          }
          if (c.since === null && typeof e?.ts === "string") c.since = e.ts;
          if (!e || !KEEP.has(e.event)) continue;
          c.events.push({ ts: e.ts, event: e.event, ref: e.ref, step: e.step, outcome: e.outcome, costUsd: e.costUsd });
        }
      }
    } finally {
      fs.closeSync(fd);
    }
  }
  return { events: c.events, since: c.since };
}

/**
 * The profile's day stats from `file` (its events.jsonl), reading only what was appended since
 * the last call. A missing file reads as an empty history.
 * @param {string} file @param {{ now?: number, days?: number, tzOffset?: number }} [o]
 * @returns {StatsView}
 */
export function readStats(file, o = {}) {
  const { events, since } = readHistory(file);
  return { days: dailyStats(events, o), since };
}
