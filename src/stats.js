// Per-harness / per-model / per-step / per-agent run statistics (#646, follow-up to the named-
// harnesses epic #618). Pure, no fs: callers hand it the usage.jsonl records and the raw events
// (`src/commands/stats.js` reads disk; `src/agent-api.js` reads the state dir for the MCP tool;
// `src/ui/server.js` for the dashboard). The run set is every `run_end` event plus any usage row
// it couldn't join to one (a timeout/spawn-error/breaker-trip run writes no usage row — if the
// aggregator only walked usage.jsonl it would silently drop exactly the failures this exists to
// surface). A `run_end` joins to at most one usage row: same ref + step, `|usage.endedAt -
// run_end.ts| <= JOIN_MS`, nearest wins, each usage row consumed once (the same pattern as
// src/ui/stats.js's `joinUsage`, which can't be reused here — it keys off a single ref+step pair
// read lazily, this walks the whole set up front so every usage row is claimed at most once).
import { costOf } from "./pricing.js";

/** How far a run_end's `ts` may sit from its usage record's `endedAt` (both written in the same dispatch tick). */
export const JOIN_MS = 5000;

/** Run outcomes this module reports (a superset of src/ui/stats.js's four — adds `hold`, `timeout`, `requeued`, `unknown`). */
export const OUTCOMES = ["advance", "changes", "hold", "fail", "timeout", "requeued", "unknown"];

/** Group-by dimensions `runStats`/`ah stats`/the MCP tool accept. */
export const STATS_BY = ["harness", "model", "step", "agent"];

/** `--since` windows `ah stats`/the MCP tool accept. */
export const STATS_SINCE = ["24h", "7d", "30d", "all"];
const SINCE_MS = { "24h": 24 * 3600 * 1000, "7d": 7 * 24 * 3600 * 1000, "30d": 30 * 24 * 3600 * 1000, all: null };

/** The `sinceMs` window for a `--since` value, or `undefined` when it's not one of STATS_SINCE. @param {string} v */
export function sinceMsOf(v) {
  return Object.hasOwn(SINCE_MS, v) ? SINCE_MS[/** @type {keyof typeof SINCE_MS} */ (v)] : undefined;
}

/** Linear-interpolated quantile of an ascending-sorted array. @param {number[]} sorted @param {number} q */
export function quantile(sorted, q) {
  if (!sorted.length) return 0;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

/**
 * One group's run statistics.
 * @typedef {object} StatsGroup
 * @property {string} key
 * @property {number} runs
 * @property {Record<string, number>} outcomes   one count per OUTCOMES entry
 * @property {number|null} successRate   advance / (runs - requeued); null when that denominator is 0
 * @property {number|null} wallP50Ms
 * @property {number|null} wallP90Ms
 * @property {number|null} turns          mean, over runs that have it
 * @property {number|null} firstContext    mean, over runs that have it
 * @property {number|null} peakContext     mean, over runs that have it
 * @property {number|null} compactions     mean, over runs that have it (#657)
 * @property {number} input
 * @property {number} output
 * @property {number} cacheRead
 * @property {number|null} outPerMin   Σoutput ÷ Σwall-minutes, over runs that have both; null with no such run
 * @property {number} costUsd    Σ reported cost, excluding unpriced runs
 * @property {number} estUsd     Σ rate-table estimate (stamped, else computed from pricing)
 * @property {number} unpriced   count of runs tagged `unpriced: true`
 */

/**
 * @typedef {object} StatsResult
 * @property {string} by
 * @property {string|null} since   ISO timestamp the window starts at, null for "all"
 * @property {StatsGroup[]} groups  sorted by `runs` desc
 */

/** @param {unknown} v */
const str = (v) => (typeof v === "string" && v ? v : null);
/** @param {unknown} v */
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * A merged run record: fields from the joined usage row take precedence over the run_end's own
 * (which only carries model/tokens/turns when the agent returned a result). `wall` only ever
 * comes from the usage row (a run_end has no start time).
 * @typedef {object} Run
 * @property {string} ref
 * @property {string} step
 * @property {string} outcome
 * @property {string|null} harness
 * @property {string|null} model
 * @property {string|null} agent
 * @property {number} endMs
 * @property {number|null} wallMs
 * @property {number|null} turns
 * @property {number|null} firstContext
 * @property {number|null} peakContext
 * @property {number|null} compactions
 * @property {number} input
 * @property {number} output
 * @property {number} cacheRead
 * @property {number} cacheCreate
 * @property {number} [costUsd]
 * @property {number} [estUsd]
 * @property {boolean} [unpriced]
 */

/** @param {Record<string, any>} u — a usage.jsonl record */
function wallOfUsage(u) {
  if (typeof u.durationMs === "number" && Number.isFinite(u.durationMs)) return u.durationMs;
  const a = Date.parse(u.startedAt);
  const b = Date.parse(u.endedAt);
  return Number.isNaN(a) || Number.isNaN(b) ? null : b - a;
}

/** @param {Record<string, any>} u @param {string} outcome */
function runFromUsage(u, outcome) {
  return {
    ref: String(u.ref),
    step: String(u.stepId),
    outcome,
    harness: str(u.harness),
    model: str(u.model),
    agent: str(u.agent),
    endMs: Date.parse(u.endedAt),
    wallMs: wallOfUsage(u),
    turns: num(u.turns),
    firstContext: num(u.firstContext),
    peakContext: num(u.peakContext),
    compactions: num(u.compactions),
    input: num(u.input) ?? 0,
    output: num(u.output) ?? 0,
    cacheRead: num(u.cacheRead) ?? 0,
    cacheCreate: num(u.cacheCreate) ?? 0,
    ...(typeof u.costUsd === "number" ? { costUsd: u.costUsd } : {}),
    ...(typeof u.estUsd === "number" ? { estUsd: u.estUsd } : {}),
    ...(u.unpriced ? { unpriced: true } : {}),
  };
}

/** @param {Record<string, any>} e — a `run_end` event @param {Record<string, any>|null} u — its joined usage row, if any */
function runFromEvent(e, u) {
  if (u) return runFromUsage(u, e.outcome);
  return {
    ref: String(e.ref),
    step: String(e.step),
    outcome: e.outcome,
    harness: str(e.harness),
    model: str(e.model),
    agent: str(e.agent),
    endMs: Date.parse(e.ts),
    wallMs: null, // a run_end alone has no start time (#646)
    turns: num(e.turns),
    firstContext: num(e.firstContext),
    peakContext: num(e.peakContext),
    compactions: num(e.compactions),
    input: num(e.input) ?? 0,
    output: num(e.output) ?? 0,
    cacheRead: num(e.cacheRead) ?? 0,
    cacheCreate: num(e.cacheCreate) ?? 0,
    ...(typeof e.costUsd === "number" ? { costUsd: e.costUsd } : {}),
    ...(typeof e.estUsd === "number" ? { estUsd: e.estUsd } : {}),
    ...(e.unpriced ? { unpriced: true } : {}),
  };
}

/** `true` when `event` is a `failed` event whose reason reads as a timeout (src/dispatch/verdict.js `timeoutReason`). @param {Record<string, any>} event */
function isTimeoutFailure(event) {
  return event.event === "failed" && typeof event.reason === "string" && event.reason.startsWith("timeout:");
}

/**
 * Build the run set from `run_end`/`failed` events joined to usage.jsonl rows.
 * @param {Record<string, any>[]} usage
 * @param {Record<string, any>[]} events
 * @returns {Run[]}
 */
function buildRuns(usage, events) {
  /** @type {Map<string, { at: number, rec: Record<string, any>, used: boolean }[]>} */
  const byKey = new Map();
  for (const u of usage) {
    const at = Date.parse(u?.endedAt);
    if (Number.isNaN(at) || typeof u?.ref !== "string" || typeof u?.stepId !== "string") continue;
    const k = `${u.ref}\0${u.stepId}`;
    const list = byKey.get(k);
    if (list) list.push({ at, rec: u, used: false });
    else byKey.set(k, [{ at, rec: u, used: false }]);
  }
  /** Failures within JOIN_MS after a run_end, same ref+step, keyed the same way. */
  const failedByKey = new Map();
  for (const e of events) {
    if (!isTimeoutFailure(e) || typeof e?.ref !== "string" || typeof e?.step !== "string") continue;
    const at = Date.parse(e.ts);
    if (Number.isNaN(at)) continue;
    const k = `${e.ref}\0${e.step}`;
    const list = failedByKey.get(k);
    if (list) list.push(at);
    else failedByKey.set(k, [at]);
  }

  /** @type {Run[]} */
  const runs = [];
  for (const e of events) {
    if (e?.event !== "run_end" || typeof e?.ref !== "string" || typeof e?.step !== "string" || typeof e?.outcome !== "string") continue;
    const ts = Date.parse(e.ts);
    if (Number.isNaN(ts)) continue;
    const candidates = byKey.get(`${e.ref}\0${e.step}`) ?? [];
    let best = null;
    for (const c of candidates) {
      if (c.used) continue;
      const gap = Math.abs(c.at - ts);
      if (gap <= JOIN_MS && (!best || gap < best.gap)) best = { gap, entry: c };
    }
    if (best) best.entry.used = true;
    let outcome = e.outcome;
    if (outcome === "fail") {
      const fails = failedByKey.get(`${e.ref}\0${e.step}`) ?? [];
      if (fails.some((/** @type {number} */ at) => at >= ts && at - ts <= JOIN_MS)) outcome = "timeout";
    }
    runs.push(runFromEvent({ ...e, outcome }, best?.entry.rec ?? null));
  }
  for (const list of byKey.values()) {
    for (const c of list) if (!c.used) runs.push(runFromUsage(c.rec, "unknown"));
  }
  return runs;
}

/**
 * @param {Run} r @param {string} by @param {Record<string, string>} stepAgent @param {string} defaultAgent
 */
function groupKey(r, by, stepAgent, defaultAgent) {
  switch (by) {
    case "model":
      return r.model ?? "(unknown)";
    case "step":
      return r.step;
    case "agent":
      return r.agent ?? stepAgent[r.step] ?? defaultAgent ?? "(unknown)";
    default:
      return r.harness ?? "(none)";
  }
}

/** @param {number[]} xs */
function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

/**
 * Per-group run statistics over a joined usage/events history. Pure — no fs, no clock reads
 * besides the passed-in `now`.
 * @param {Record<string, any>[]} usage      usage.jsonl records
 * @param {Record<string, any>[]} events     events.jsonl records (run_end + failed are read; the rest are ignored)
 * @param {{ by?: string, sinceMs?: number|null, now?: number, step?: string, harness?: string, steps?: {id: string, agent?: string}[], defaultAgent?: string, pricing?: Record<string, import('./pricing.js').Rate>|null }} [o]
 * @returns {StatsResult}
 */
export function runStats(usage, events, o = {}) {
  const { by = "harness", sinceMs = null, now = Date.now(), step, harness, steps = [], defaultAgent = "claude", pricing = null } = o;
  /** @type {Record<string, string>} */
  const stepAgent = {};
  for (const s of steps) if (s?.id && typeof s.agent === "string" && s.agent) stepAgent[s.id] = s.agent;

  const cutoff = typeof sinceMs === "number" ? now - sinceMs : null;
  let runs = buildRuns(usage, events);
  if (cutoff !== null) runs = runs.filter((r) => r.endMs >= cutoff);
  if (step) runs = runs.filter((r) => r.step === step);
  if (harness) runs = runs.filter((r) => (r.harness ?? "(none)") === harness);

  /** @type {Map<string, Run[]>} */
  const byGroup = new Map();
  for (const r of runs) {
    const k = groupKey(r, by, stepAgent, defaultAgent);
    const list = byGroup.get(k);
    if (list) list.push(r);
    else byGroup.set(k, [r]);
  }

  /** @type {StatsGroup[]} */
  const groups = [];
  for (const [key, list] of byGroup) {
    /** @type {Record<string, number>} */
    const outcomes = Object.fromEntries(OUTCOMES.map((o2) => [o2, 0]));
    for (const r of list) outcomes[Object.hasOwn(outcomes, r.outcome) ? r.outcome : "unknown"]++;
    const denom = list.length - outcomes.requeued;
    const successRate = denom > 0 ? outcomes.advance / denom : null;
    const walls = list.filter((r) => r.wallMs !== null).map((r) => /** @type {number} */ (r.wallMs)).sort((a, b) => a - b);
    const turns = mean(list.filter((r) => r.turns !== null).map((r) => /** @type {number} */ (r.turns)));
    const firstContext = mean(list.filter((r) => r.firstContext !== null).map((r) => /** @type {number} */ (r.firstContext)));
    const peakContext = mean(list.filter((r) => r.peakContext !== null).map((r) => /** @type {number} */ (r.peakContext)));
    const compactions = mean(list.filter((r) => r.compactions !== null).map((r) => /** @type {number} */ (r.compactions)));
    let input = 0, output = 0, cacheRead = 0;
    let outSum = 0, wallMinSum = 0;
    let costUsd = 0, estUsd = 0, unpriced = 0;
    for (const r of list) {
      input += r.input;
      output += r.output;
      cacheRead += r.cacheRead;
      if (r.wallMs !== null) {
        outSum += r.output;
        wallMinSum += r.wallMs / 60000;
      }
      if (r.unpriced) unpriced++;
      const c = costOf(r, pricing);
      if (c.costUsd !== undefined) costUsd += c.costUsd;
      else if (c.estUsd !== undefined) estUsd += c.estUsd;
    }
    groups.push({
      key,
      runs: list.length,
      outcomes,
      successRate,
      wallP50Ms: walls.length ? quantile(walls, 0.5) : null,
      wallP90Ms: walls.length ? quantile(walls, 0.9) : null,
      turns,
      firstContext,
      peakContext,
      compactions,
      input,
      output,
      cacheRead,
      outPerMin: wallMinSum > 0 ? outSum / wallMinSum : null,
      costUsd,
      estUsd,
      unpriced,
    });
  }
  groups.sort((a, b) => b.runs - a.runs);

  return { by, since: cutoff !== null ? new Date(cutoff).toISOString() : null, groups };
}
