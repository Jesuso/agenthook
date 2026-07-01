// `agenthook status [name]` — detail for one profile. With no name, uses the
// profile discovered from the current dir's agenthook.config.json.
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../config.js";
import { readProfile } from "../heartbeat.js";
import { createStore } from "../store.js";
import { ago } from "./ls.js";

/**
 * Format a token count as a human-readable string (e.g. "1.2M", "340K").
 * @param {number} n
 */
function fmtTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

/** @param {any} args */
export async function status(args) {
  let name = args._[0];
  let logDir = null;
  if (!name) {
    const cfg = loadConfig({ configPath: args.config });
    name = cfg.name;
    logDir = cfg.logDir;
  }

  const p = readProfile(name);
  if (!p.heartbeat && !p.pid) {
    console.log(`no such profile "${name}" (nothing under ~/.agenthook/${name}).`);
    return;
  }
  const hb = p.heartbeat || {};
  logDir = logDir || path.join(p.dir, "logs");

  console.log(`profile : ${name}`);
  console.log(`status  : ${p.up ? `UP (pid ${p.pid})` : "down"}`);
  console.log(`tracker : ${hb.tracker || "?"}`);
  console.log(`ingress : ${hb.ingress || "?"}${hb.url ? `  ${hb.url}` : ""}`);
  console.log(`port    : ${hb.port || "?"}`);
  console.log(`repo    : ${hb.repoPath || "?"}`);
  console.log(`auto    : ${hb.fullAuto ? "fullAuto (--dangerously-skip-permissions)" : "permissioned"}`);
  if (hb.queue) console.log(`queue   : ${hb.queue.active} running, ${hb.queue.queued} queued`);
  if (hb.seen != null) console.log(`seen    : ${hb.seen} item(s)`);
  if (hb.startedAt) console.log(`started : ${ago(hb.startedAt)}`);
  if (hb.lastEvent) {
    const e = hb.lastEvent;
    console.log(`last    : ${e.kind} ${e.ref}${e.text ? ` "${e.text.slice(0, 60)}"` : ""} (${ago(e.at)})`);
  }

  // Usage totals.
  const store = createStore(p.dir);
  const usageRecords = store.readUsage();
  if (usageRecords.length) {
    let totalTokens = 0;
    let totalCost = 0;
    let hasCost = false;
    for (const r of usageRecords) {
      totalTokens += (r.input || 0) + (r.output || 0);
      if (r.costUsd != null) { totalCost += r.costUsd; hasCost = true; }
    }
    const costStr = hasCost ? `, $${totalCost.toFixed(2)}` : "";
    console.log(`usage   : ${fmtTokens(totalTokens)} tokens${costStr} over ${usageRecords.length} run(s)`);
  }

  // Most recent run logs — with per-run token figures where available.
  try {
    const logs = fs
      .readdirSync(logDir)
      .filter((f) => f.endsWith(".log"))
      .sort()
      .slice(-5);
    if (logs.length) {
      console.log(`\nrecent runs (${logDir}):`);
      // Build a lookup: "step-<stepId>-<safeRef>" suffix → usage record.
      // Log filename: <stamp>-step-<stepId>-<safeRef>.log
      /** @type {Map<string, import('../types.js').UsageRecord>} */
      const usageByKey = new Map();
      for (const r of usageRecords) {
        const safeRef = r.ref.replace(/[^a-zA-Z0-9_-]/g, "_");
        usageByKey.set(`step-${r.stepId}-${safeRef}`, r);
      }
      for (const l of logs) {
        const base = l.replace(/\.log$/, "");
        // Strip leading timestamp (everything before first "-step-").
        const idx = base.indexOf("-step-");
        const key = idx >= 0 ? base.slice(idx + 1) : null;
        const rec = key ? usageByKey.get(key) : null;
        const tokStr = rec
          ? ` [${fmtTokens((rec.input || 0) + (rec.output || 0))} tok${rec.costUsd != null ? `, $${rec.costUsd.toFixed(3)}` : ""}]`
          : "";
        console.log(`  ${l}${tokStr}`);
      }
    }
  } catch {
    /* no logs yet */
  }
}
