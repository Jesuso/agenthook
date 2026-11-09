// `agenthook stats` — per-harness / per-model / per-step / per-agent run statistics (#646,
// follow-up to the named-harnesses epic #618): which backend lands an advance, how long it
// takes, how much context it uses, and what it costs. Pure aggregation lives in src/stats.js;
// this just reads usage.jsonl + events.jsonl and prints a table (or `--json` the raw object).
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../config.js";
import { createStore } from "../store.js";
import { runStats, sinceMsOf, STATS_BY, STATS_SINCE } from "../stats.js";

/** @param {number} n */
function tok(n) {
  return n.toLocaleString("en-US");
}

/** @param {number|null} ms */
function fmtMs(ms) {
  if (ms === null) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${(s / 60).toFixed(1)}m`;
}

/** @param {number|null} n */
function fmtNum(n) {
  return n === null ? "—" : Math.round(n).toLocaleString("en-US");
}

/** @param {number|null} v */
function fmtPct(v) {
  return v === null ? "—" : `${Math.round(v * 100)}%`;
}

/** @param {number} usd */
function fmtUsd(usd) {
  return usd > 0 ? `$${usd.toFixed(4)}` : "—";
}

/**
 * The whole of `file`'s lines, parsed, torn/invalid lines skipped. Pure reader, no cursor —
 * the CLI is a one-shot snapshot, unlike the UI's incremental `ui/stats.js` reader.
 * @param {string} file
 * @returns {Record<string, any>[]}
 */
function readJsonl(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  /** @type {Record<string, any>[]} */
  const out = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      /* tolerate a torn/partial line */
    }
  }
  return out;
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

/** @param {any} args */
export async function stats(args) {
  const cfg = loadConfig({ configPath: args.config });
  const store = createStore(cfg.dataDir);

  const by = args.by ?? "harness";
  if (!STATS_BY.includes(by)) {
    console.error(`usage: agenthook stats [--by harness|model|step|agent] [--since 24h|7d|30d|all] [--step <id>] [--harness <name>] [--json]`);
    process.exitCode = 1;
    return;
  }
  const since = args.since ?? "7d";
  const sinceMs = sinceMsOf(since);
  if (sinceMs === undefined) {
    console.error(`usage: agenthook stats --since must be one of ${STATS_SINCE.join("|")} (got ${JSON.stringify(since)})`);
    process.exitCode = 1;
    return;
  }

  const usage = store.readUsage();
  const events = readJsonl(path.join(cfg.dataDir, "events.jsonl"));
  const result = runStats(usage, events, {
    by,
    sinceMs,
    step: args.step,
    harness: args.harness,
    steps: cfg.pipeline ?? [],
    defaultAgent: cfg.agent ?? "claude",
    pricing: cfg.pricing ?? null,
  });

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (!result.groups.length) {
    console.log("no runs recorded in this window");
    return;
  }

  const header = [by, "runs", "ok%", "adv/chg/hold/fail/tmo/rq/unk", "p50", "p90", "turns", "ctx0", "ctxPk", "in", "out", "cacheR", "out/min", "$", "est$", "unpriced"];
  const rows = [header];
  for (const g of result.groups) {
    const o = g.outcomes;
    rows.push([
      g.key,
      String(g.runs),
      fmtPct(g.successRate),
      `${o.advance}/${o.changes}/${o.hold}/${o.fail}/${o.timeout}/${o.requeued}/${o.unknown}`,
      fmtMs(g.wallP50Ms),
      fmtMs(g.wallP90Ms),
      fmtNum(g.turns),
      fmtNum(g.firstContext),
      fmtNum(g.peakContext),
      tok(g.input),
      tok(g.output),
      tok(g.cacheRead),
      g.outPerMin === null ? "—" : Math.round(g.outPerMin).toLocaleString("en-US"),
      fmtUsd(g.costUsd),
      fmtUsd(g.estUsd),
      g.unpriced ? String(g.unpriced) : "—",
    ]);
  }
  printTable(rows);
  console.log(`\nsince ${result.since ?? "the beginning"} (--by ${by})`);
}
