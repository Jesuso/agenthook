// Per-day activity stats for `ah ui` (docs/web-ui.md, "Daily stats"). A pure reader: the whole
// of a profile's events.jsonl is a complete append-only history, so day buckets are derived from
// it on demand — no rollup file, no engine write path, history back to the first run. Only the
// fields stats need are kept per event, appended incrementally by byte offset (the file is
// append-only; a shrink restarts the read). Days are cut at the *caller's* midnight
// (`tzOffset` = `Date.getTimezoneOffset()` minutes), so they match the browser's "today".
import fs from "node:fs";

export const STATS_MAX_DAYS = 90;
const READ_CAP_BYTES = 64 * 1024 * 1024; // a bigger history is read from its last 64 MB
const DAY_MS = 24 * 3600 * 1000;
const KEEP = new Set(["pipeline_done", "merged", "run_end", "failed"]);

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
 */

/**
 * @typedef {object} StatsView
 * @property {DayStats[]} days      oldest first, zero-filled, the last one is today
 * @property {string|null} since    ISO ts of the first event in the history (null: none), so the UI can say how far back "all" goes
 */

/** @param {number} ts @param {number} tzOffset */
const dayKey = (ts, tzOffset) => new Date(ts - tzOffset * 60000).toISOString().slice(0, 10);

/**
 * Bucket events into the last `days` local days. Pure.
 * @param {Record<string, any>[]} events
 * @param {{ now?: number, days?: number, tzOffset?: number }} [o]
 * @returns {DayStats[]}
 */
export function dailyStats(events, { now = Date.now(), days = 14, tzOffset = 0 } = {}) {
  const n = Math.min(STATS_MAX_DAYS, Math.max(1, Math.floor(days)));
  /** @type {Map<string, DayStats & { _f: Set<string>, _m: Set<string> }>} */
  const byDay = new Map();
  for (let i = n - 1; i >= 0; i--) {
    const date = dayKey(now - i * DAY_MS, tzOffset);
    byDay.set(date, { date, finished: 0, merged: 0, runs: 0, rework: 0, failedRuns: 0, costUsd: 0, _f: new Set(), _m: new Set() });
  }
  for (const e of events) {
    const ts = Date.parse(e.ts);
    if (Number.isNaN(ts)) continue;
    const d = byDay.get(dayKey(ts, tzOffset));
    if (!d) continue;
    if (e.event === "pipeline_done") d._f.add(String(e.ref));
    else if (e.event === "merged") d._m.add(String(e.ref));
    else if (e.event === "run_end") {
      d.runs++;
      if (e.outcome === "changes") d.rework++;
      else if (e.outcome === "fail") d.failedRuns++;
      if (typeof e.costUsd === "number" && Number.isFinite(e.costUsd)) d.costUsd += e.costUsd;
    }
  }
  return [...byDay.values()].map(({ _f, _m, ...d }) => ({ ...d, finished: _f.size, merged: _m.size, costUsd: Math.round(d.costUsd * 100) / 100 }));
}

/** @type {Map<string, { offset: number, capped: boolean, since: string|null, events: Record<string, any>[] }>} */
const cache = new Map();

/** Drop all cached histories (tests). */
export function resetStatsCache() {
  cache.clear();
}

/**
 * The profile's day stats from `file` (its events.jsonl), reading only what was appended since
 * the last call. A missing file reads as an empty history.
 * @param {string} file @param {{ now?: number, days?: number, tzOffset?: number }} [o]
 * @returns {StatsView}
 */
export function readStats(file, o = {}) {
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    cache.delete(file);
    return { days: dailyStats([], o), since: null };
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
          c.events.push({ ts: e.ts, event: e.event, ref: e.ref, outcome: e.outcome, costUsd: e.costUsd });
        }
      }
    } finally {
      fs.closeSync(fd);
    }
  }
  return { days: dailyStats(c.events, o), since: c.since };
}
