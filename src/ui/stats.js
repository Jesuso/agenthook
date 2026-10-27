// Per-day activity stats for `ah ui` (docs/web-ui.md, "Daily stats"). A pure reader: the whole
// of a profile's events.jsonl is a complete append-only history, so day buckets are derived from
// it on demand — no rollup file, no engine write path, history back to the first run. Only the
// fields stats need are kept per event, appended incrementally by byte offset (the file is
// append-only; a shrink restarts the read). Days are cut at the *caller's* midnight
// (`tzOffset` = `Date.getTimezoneOffset()` minutes), so they match the browser's "today".
// Reported (`costUsd`) and rate-table estimated (`estUsd`, src/pricing.js) spend are summed apart,
// and measured energy (`energyKwh`/`energyUsd`, src/energy.js) apart from both.
import fs from "node:fs";
import path from "node:path";
import { costOf } from "../pricing.js";

export const STATS_MAX_DAYS = 366;
const READ_CAP_BYTES = 64 * 1024 * 1024; // a bigger history is read from its last 64 MB
const DAY_MS = 24 * 3600 * 1000;
const KEEP = new Set(["pipeline_done", "board_done", "merged", "run_end", "run_start"]);
const OUTCOMES = ["advance", "changes", "hold", "fail"];

/**
 * One calendar day. `finished`/`merged` count distinct tickets, `runs`/`rework`/`failedRuns`
 * count `run_end`s.
 * @typedef {object} DayStats
 * @property {string} date          local YYYY-MM-DD
 * @property {number} finished      distinct tickets the board made done this day (ADR 0008): their first done signal since
 *           their last `run_start` — a `board_done` (the done flag or the terminal stage; a stage + flag pair counts once) or a
 *           legacy `pipeline_done`. A flag `board_done` for a ticket with no earlier run in the history is not counted
 * @property {number} merged        distinct tickets whose PR merged (forge profiles only) — a forge fact, never `finished`
 * @property {number} runs          agent runs that ended
 * @property {number} rework        of those, ended `changes`
 * @property {number} failedRuns    of those, ended `fail`
 * @property {number} costUsd       sum of run_end reported costs
 * @property {number} estUsd        sum of run_end rate-table estimates (runs with no reported cost; never in `costUsd`)
 * @property {number} unestimatedRuns  run_ends with neither a reported cost nor an estimate (no rate, or no tokens)
 * @property {number} energyKwh     sum of run_end measured energy (`energy: true` steps; 1e-9 kWh) — never in costUsd/estUsd
 * @property {number} energyUsd     its dollars at the profile's `energy.usdPerKwh` (rounded to 1e-6, not cents: a local run is a fraction of one)
 * @property {Record<string, { runs: number, costUsd: number, estUsd: number, energyKwh?: number, energyUsd?: number }>} byStep   run_end count, reported cost and estimate per pipeline step, plus energy when a run on it was measured
 * @property {{ advance: number, changes: number, hold: number, fail: number, other: number }} outcomes   run_end outcomes
 * @property {{ n: number, p10: number, p50: number, p90: number }|null} ticketCost   what the tickets that finished this day
 *           cost in total: the agent runs on each since its previous finish. Null when none of them had a costed run
 *           (hand-finished tickets have no agent runs, so they are not in it).
 * @property {{ n: number, p10: number, p50: number, p90: number }|null} ticketEst   the same, over the estimates only
 */

/**
 * @typedef {object} StatsView
 * @property {DayStats[]} days      oldest first, zero-filled, the last one is today
 * @property {string|null} since    ISO ts of the first event in the history (null: none), so the UI can say how far back "all" goes
 */

/** A finite number ≥ 0, else 0. @param {unknown} v */
const finiteNum = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

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
 * Bucket events (oldest first) into the last `days` local days. Pure. `pricing` = the profile's
 * rate overrides (heartbeat `pricing`), for run_ends not already stamped with an estimate.
 * @param {Record<string, any>[]} events
 * @param {{ now?: number, days?: number, tzOffset?: number, pricing?: Record<string, import('../pricing.js').Rate>|null }} [o]
 * @returns {DayStats[]}
 */
export function dailyStats(events, { now = Date.now(), days = 14, tzOffset = 0, pricing = null } = {}) {
  const n = Math.min(STATS_MAX_DAYS, Math.max(1, Math.floor(days)));
  /** @typedef {DayStats & { _f: Set<string>, _m: Set<string>, _tc: number[], _te: number[] }} Bucket */
  /** @type {Map<string, Bucket>} */
  const byDay = new Map();
  for (let i = n - 1; i >= 0; i--) {
    const date = dayKey(now - i * DAY_MS, tzOffset);
    byDay.set(date, {
      date, finished: 0, merged: 0, runs: 0, rework: 0, failedRuns: 0, costUsd: 0, estUsd: 0, unestimatedRuns: 0, energyKwh: 0, energyUsd: 0, byStep: {},
      outcomes: { advance: 0, changes: 0, hold: 0, fail: 0, other: 0 }, ticketCost: null, ticketEst: null,
      _f: new Set(), _m: new Set(), _tc: [], _te: [],
    });
  }
  /** Agent spend on a ticket since it last finished (the cost of getting it finished); runs before the window count too. @type {Map<string, number>} */
  const sinceFinish = new Map();
  /** The same, estimated. @type {Map<string, number>} */
  const estSinceFinish = new Map();
  /** Refs already done since their last `run_start` (a later signal is the same transition). @type {Set<string>} */
  const doneSinceRun = new Set();
  /** Refs with a `run_start`/`run_end` so far: a flag `board_done` alone never counts (src/ui/rows.js). @type {Set<string>} */
  const ran = new Set();
  for (const e of events) {
    const ts = Date.parse(e.ts);
    if (Number.isNaN(ts)) continue;
    const ref = String(e.ref);
    const c = e.event === "run_end" ? costOf(e, pricing) : {};
    const cost = c.costUsd ?? 0;
    const est = c.estUsd ?? 0;
    if (cost) sinceFinish.set(ref, (sinceFinish.get(ref) ?? 0) + cost);
    if (est) estSinceFinish.set(ref, (estSinceFinish.get(ref) ?? 0) + est);
    const d = byDay.get(dayKey(ts, tzOffset));
    if (e.event === "run_start") doneSinceRun.delete(ref);
    if (e.event === "run_start" || e.event === "run_end") ran.add(ref);
    if (e.event === "pipeline_done" || e.event === "board_done") {
      if (doneSinceRun.has(ref)) continue; // a stage + flag pair, or a duplicate burst: one transition
      if (e.event === "board_done" && e.via !== "stage" && !ran.has(ref)) continue;
      doneSinceRun.add(ref);
      const spent = sinceFinish.get(ref) ?? 0;
      if (spent > 0) {
        sinceFinish.set(ref, 0);
        d?._tc.push(spent);
      }
      const estSpent = estSinceFinish.get(ref) ?? 0;
      if (estSpent > 0) {
        estSinceFinish.set(ref, 0);
        d?._te.push(estSpent);
      }
      d?._f.add(ref);
    } else if (!d) {
      continue;
    } else if (e.event === "merged") d._m.add(ref);
    else if (e.event === "run_end") {
      d.runs++;
      d.costUsd += cost;
      d.estUsd += est;
      if (c.costUsd === undefined && c.estUsd === undefined) d.unestimatedRuns++;
      const kwh = finiteNum(e.energyKwh);
      const eUsd = finiteNum(e.energyUsd);
      d.energyKwh += kwh;
      d.energyUsd += eUsd;
      if (e.outcome === "changes") d.rework++;
      else if (e.outcome === "fail") d.failedRuns++;
      d.outcomes[/** @type {"advance"|"changes"|"hold"|"fail"|"other"} */ (OUTCOMES.includes(e.outcome) ? e.outcome : "other")]++;
      const step = typeof e.step === "string" && e.step ? e.step : "?";
      const st = (d.byStep[step] ??= { runs: 0, costUsd: 0, estUsd: 0, energyKwh: 0, energyUsd: 0 });
      st.runs++;
      st.costUsd += cost;
      st.estUsd += est;
      if (kwh) {
        st.energyKwh = (st.energyKwh ?? 0) + kwh;
        st.energyUsd = (st.energyUsd ?? 0) + eUsd;
      }
    }
  }
  const r2 = (/** @type {number} */ v) => Math.round(v * 100) / 100;
  const r6 = (/** @type {number} */ v) => Math.round(v * 1e6) / 1e6;
  const r9 = (/** @type {number} */ v) => Math.round(v * 1e9) / 1e9;
  /** @param {number[]} xs */
  const spread = (xs) => {
    const sorted = [...xs].sort((a, b) => a - b);
    return sorted.length ? { n: sorted.length, p10: r2(quantile(sorted, 0.1)), p50: r2(quantile(sorted, 0.5)), p90: r2(quantile(sorted, 0.9)) } : null;
  };
  return [...byDay.values()].map(({ _f, _m, _tc, _te, ...d }) => ({
    ...d,
    finished: _f.size,
    merged: _m.size,
    costUsd: r2(d.costUsd),
    estUsd: r2(d.estUsd),
    energyKwh: r9(d.energyKwh),
    energyUsd: r6(d.energyUsd),
    byStep: Object.fromEntries(
      Object.entries(d.byStep).map(([k, v]) => [
        k,
        { runs: v.runs, costUsd: r2(v.costUsd), estUsd: r2(v.estUsd), ...(v.energyKwh ? { energyKwh: r9(v.energyKwh), energyUsd: r6(v.energyUsd ?? 0) } : {}) },
      ]),
    ),
    ticketCost: spread(_tc),
    ticketEst: spread(_te),
  }));
}

/** How far a run_end's `ts` may sit from its usage record's `endedAt` (both written in the same dispatch tick). */
const JOIN_MS = 5000;
const TOKEN_FIELDS = ["model", "input", "output", "cacheRead", "cacheCreate", "estUsd", "unpriced"];
const ENERGY_FIELDS = ["energyKwh", "energyUsd"];

/** @type {Map<string, { size: number, byKey: Map<string, { at: number, rec: Record<string, any> }[]> }>} */
const usageCache = new Map();

/** usage.jsonl indexed by `ref\0stepId` (re-read when its size changes); empty when missing. @param {string} file */
function usageIndex(file) {
  let size = -1;
  try {
    size = fs.statSync(file).size;
  } catch {
    /* missing */
  }
  const hit = usageCache.get(file);
  if (hit && hit.size === size) return hit.byKey;
  /** @type {Map<string, { at: number, rec: Record<string, any> }[]>} */
  const byKey = new Map();
  if (size > 0) {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line) continue;
      try {
        const r = JSON.parse(line);
        const at = Date.parse(r?.endedAt);
        if (Number.isNaN(at)) continue;
        const k = `${r.ref}\0${r.stepId}`;
        byKey.set(k, [...(byKey.get(k) ?? []), { at, rec: r }]);
      } catch {
        /* skip a torn line */
      }
    }
  }
  usageCache.set(file, { size, byKey });
  return byKey;
}

/**
 * Old run_ends (before they carried tokens) priced from their usage record: the same ref + step
 * whose `endedAt` is within JOIN_MS of the event. No match leaves the event as-is ("no estimate").
 * Mutates `kept`. @param {Record<string, any>} kept @param {() => Map<string, { at: number, rec: Record<string, any> }[]>} index
 */
function joinUsage(kept, index) {
  const ts = Date.parse(kept.ts);
  if (Number.isNaN(ts)) return;
  let best = null;
  for (const u of index().get(`${kept.ref}\0${kept.step}`) ?? []) {
    const gap = Math.abs(u.at - ts);
    if (gap <= JOIN_MS && (!best || gap < best.gap)) best = { gap, rec: u.rec };
  }
  if (!best) return;
  for (const f of TOKEN_FIELDS) if (best.rec[f] !== undefined) kept[f] = best.rec[f];
}

/** @type {Map<string, { offset: number, capped: boolean, since: string|null, events: Record<string, any>[] }>} */
const cache = new Map();

/** Drop all cached histories (tests). */
export function resetStatsCache() {
  cache.clear();
  usageCache.clear();
}

/**
 * The kept events from `file` (its events.jsonl), reading only what was appended since the last
 * call. A missing file reads as an empty history. A run_end keeps its model, tokens and cost
 * basis; an old one with no tokens (and no reported cost) borrows them from the sibling
 * usage.jsonl record of the same run (`joinUsage`) — read time only, no file is rewritten.
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
    /** @type {ReturnType<typeof usageIndex>|null} */
    let idx = null;
    const usage = () => (idx ??= usageIndex(path.join(path.dirname(file), "usage.jsonl")));
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
          /** @type {Record<string, any>} */
          const kept = { ts: e.ts, event: e.event, ref: e.ref, step: e.step, outcome: e.outcome, costUsd: e.costUsd };
          if (e.event === "board_done" && e.via !== undefined) kept.via = e.via;
          if (e.event === "run_end") {
            for (const f of [...TOKEN_FIELDS, "costBasis", ...ENERGY_FIELDS]) if (e[f] !== undefined) kept[f] = e[f];
            const reported = typeof e.costUsd === "number" && !e.unpriced;
            if (!reported && typeof e.input !== "number" && typeof e.estUsd !== "number") joinUsage(kept, usage);
          }
          c.events.push(kept);
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
 * @param {string} file @param {{ now?: number, days?: number, tzOffset?: number, pricing?: Record<string, import('../pricing.js').Rate>|null }} [o]
 * @returns {StatsView}
 */
export function readStats(file, o = {}) {
  const { events, since } = readHistory(file);
  return { days: dailyStats(events, o), since };
}
