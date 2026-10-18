// `agenthook usage` — display per-run token/cost records from usage.jsonl.
//
//   usage              recent runs table (newest last, up to --limit rows)
//   usage --ref <n>    filter to one task's runs + totals
//   usage --day        group by UTC calendar day
//   usage --week       group by ISO week (--week wins if both given)
import { loadConfig } from "../config.js";
import { createStore } from "../store.js";
import { costOf, sumCosts } from "../pricing.js";

/**
 * Aggregate an array of UsageRecords into summed totals. Tokens sum every record; `costUsd`
 * sums only priced ones (an `unpriced` local-model run's figure is not real spend). `est` /
 * `unestimated` are src/pricing.js `sumCosts` over the rest (the rate-table estimate, and the
 * runs with no rate or no tokens), with the profile's `pricing` overrides.
 * @param {import('../types.js').UsageRecord[]} recs
 * @param {Record<string, import('../pricing.js').Rate>|null} [pricing]
 * @returns {{ input: number, output: number, cacheRead: number, cacheCreate: number, costUsd: number|undefined, est: number, unestimated: number }}
 */
export function sumRecords(recs, pricing) {
  let input = 0, output = 0, cacheRead = 0, cacheCreate = 0, costUsd = /** @type {number|undefined} */ (undefined);
  for (const r of recs) {
    input += r.input;
    output += r.output;
    cacheRead += r.cacheRead;
    cacheCreate += r.cacheCreate;
    if (!r.unpriced && typeof r.costUsd === "number") costUsd = (costUsd ?? 0) + r.costUsd;
  }
  const { est, unestimated } = sumCosts(recs, pricing);
  return { input, output, cacheRead, cacheCreate, costUsd, est, unestimated };
}

/** A group/TOTAL `$` cell: reported and estimated side by side, never summed — `$1.2345 + ~$0.0400 est.`
 * (src/pricing.js `formatSpend`'s shape at this table's precision); `—` when neither. Exported for tests.
 * @param {{ costUsd: number|undefined, est: number }} t */
export function spendCell(t) {
  const est = t.est > 0 ? `~${fmtCost(t.est)} est.` : "";
  if (t.costUsd === undefined) return est || "—";
  return est ? `${fmtCost(t.costUsd)} + ${est}` : fmtCost(t.costUsd);
}

/**
 * Group records by a string key derived from each record.
 * @param {import('../types.js').UsageRecord[]} recs
 * @param {(r: import('../types.js').UsageRecord) => string} keyFn
 * @returns {Map<string, import('../types.js').UsageRecord[]>}
 */
export function groupBy(recs, keyFn) {
  /** @type {Map<string, import('../types.js').UsageRecord[]>} */
  const m = new Map();
  for (const r of recs) {
    const k = keyFn(r);
    if (!m.has(k)) m.set(k, []);
    /** @type {import('../types.js').UsageRecord[]} */ (m.get(k)).push(r);
  }
  return m;
}

/**
 * UTC calendar date string from an ISO timestamp.
 * @param {string} iso
 * @returns {string}  e.g. "2026-07-01"
 */
export function utcDay(iso) {
  return iso.slice(0, 10);
}

/**
 * ISO week key (YYYY-Www) from an ISO timestamp, UTC-based.
 * @param {string} iso
 * @returns {string}  e.g. "2026-W27"
 */
export function isoWeek(iso) {
  const d = new Date(iso);
  // ISO week: Monday-based. Algorithm: find Thursday of the week, then week number.
  const tmp = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayOfWeek = tmp.getUTCDay() || 7; // 1=Mon … 7=Sun
  tmp.setUTCDate(tmp.getUTCDate() + 4 - dayOfWeek); // Thursday of this week
  const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((tmp.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${tmp.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/**
 * Per-model breakdown string from a group of records.
 * @param {import('../types.js').UsageRecord[]} recs
 * @returns {string}
 */
export function modelSplit(recs) {
  /** @type {Map<string, number>} */
  const m = new Map();
  for (const r of recs) {
    const k = r.model ?? "unknown";
    m.set(k, (m.get(k) ?? 0) + (r.input + r.output + r.cacheRead + r.cacheCreate));
  }
  return [...m.entries()].map(([k, n]) => `${k}:${n}`).join(", ");
}

/** @param {number|undefined} usd */
function fmtCost(usd) {
  return typeof usd === "number" ? `$${usd.toFixed(4)}` : "—";
}

/**
 * A per-run cost cell: the reported `$0.1234`, else the rate-table `~$0.0400 est.`, else
 * `unpriced` for a run with no real cost and no estimate (no rate, or no tokens). Exported for tests.
 * @param {import('../types.js').UsageRecord} r @param {Record<string, import('../pricing.js').Rate>|null} [pricing]
 */
export function runCost(r, pricing) {
  const c = costOf(r, pricing);
  if (c.costUsd !== undefined) return fmtCost(c.costUsd);
  if (c.estUsd !== undefined) return `~${fmtCost(c.estUsd)} est.`;
  return r.unpriced ? "unpriced" : fmtCost(r.costUsd);
}

/** @param {number} n */
function tok(n) {
  return n.toLocaleString("en-US");
}

/** @param {any} args */
export async function usage(args) {
  const cfg = loadConfig({ configPath: args.config });
  const store = createStore(cfg.dataDir);
  const pricing = cfg.pricing ?? null;
  let recs = store.readUsage();

  if (!recs.length) {
    console.log("no usage recorded yet");
    return;
  }

  // --ref filter
  if (args.ref != null) {
    const ref = String(args.ref);
    recs = recs.filter((r) => r.ref === ref);
    if (!recs.length) {
      console.log(`no usage recorded for ref ${ref}`);
      return;
    }
  }

  const byDay = args.day && !args.week;
  const byWeek = args.week;

  if (byWeek || byDay) {
    const keyFn = byWeek ? (/** @type {import('../types.js').UsageRecord} */ r) => isoWeek(r.startedAt) : (/** @type {import('../types.js').UsageRecord} */ r) => utcDay(r.startedAt);
    const groups = groupBy(recs, keyFn);
    const header = ["Period", "Runs", "Input", "Output", "CacheRead", "CacheCreate", "$", "No est.", "Models"];
    const rows = [header];
    for (const [period, grp] of groups) {
      const t = sumRecords(grp, pricing);
      rows.push([period, String(grp.length), tok(t.input), tok(t.output), tok(t.cacheRead), tok(t.cacheCreate), spendCell(t), String(t.unestimated), modelSplit(grp)]);
    }
    const tot = sumRecords(recs, pricing);
    rows.push(["TOTAL", String(recs.length), tok(tot.input), tok(tot.output), tok(tot.cacheRead), tok(tot.cacheCreate), spendCell(tot), String(tot.unestimated), ""]);
    printTable(rows);
    return;
  }

  // Default: per-run table
  const limit = args.limit != null ? Number(args.limit) : undefined;
  const slice = limit != null ? recs.slice(-limit) : recs;

  const header = ["Ref", "Step", "Model", "Input", "Output", "CacheRead", "CacheCreate", "$"];
  const rows = [header];
  for (const r of slice) {
    rows.push([r.ref, r.stepId, r.model ?? "—", tok(r.input), tok(r.output), tok(r.cacheRead), tok(r.cacheCreate), runCost(r, pricing)]);
  }
  // Totals always over full filtered set (not just the slice)
  const tot = sumRecords(recs, pricing);
  const noEst = tot.unestimated ? ` (${tot.unestimated} runs no estimate)` : "";
  rows.push(["TOTAL", "", "", tok(tot.input), tok(tot.output), tok(tot.cacheRead), tok(tot.cacheCreate), spendCell(tot) + noEst]);
  printTable(rows);
}

/**
 * Print a 2-D string table with padded columns.
 * @param {string[][]} rows
 */
function printTable(rows) {
  if (!rows.length) return;
  const widths = rows[0].map((_, ci) => Math.max(...rows.map((r) => (r[ci] ?? "").length)));
  for (const row of rows) {
    console.log(row.map((cell, ci) => (cell ?? "").padEnd(widths[ci])).join("  ").trimEnd());
  }
}
