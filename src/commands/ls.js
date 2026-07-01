// `agenthook ls` — table of every profile under ~/.agenthook and its live status.
// Reads each profile's heartbeat + pidfile; never touches the running process.
import { listProfiles } from "../heartbeat.js";
import { createStore } from "../store.js";

/** Humanize an ISO timestamp as a relative age. @param {string|null} iso */
export function ago(iso) {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0 || Number.isNaN(ms)) return "?";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** @param {string} s @param {number} n */
const pad = (s, n) => String(s).padEnd(n);

/** Format token count as short string. @param {number} n */
function fmtTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

export async function ls() {
  const profiles = listProfiles();
  if (!profiles.length) {
    console.log("no profiles yet. Run `agenthook init` in a project dir to create one.");
    return;
  }
  const rows = profiles.map((p) => {
    const hb = p.heartbeat || {};
    let tokens = "";
    let cost = "";
    try {
      const records = createStore(p.dir).readUsage();
      if (records.length) {
        let totalTokens = 0;
        let totalCost = 0;
        let hasCost = false;
        for (const r of records) {
          totalTokens += (r.input || 0) + (r.output || 0);
          if (r.costUsd != null) { totalCost += r.costUsd; hasCost = true; }
        }
        tokens = fmtTokens(totalTokens);
        cost = hasCost ? `$${totalCost.toFixed(2)}` : "";
      }
    } catch {
      /* usage.jsonl absent or unreadable — leave blank */
    }
    return {
      name: p.name,
      up: p.up ? "*" : " ",
      port: hb.port || "?",
      tracker: hb.tracker || "?",
      ingress: hb.ingress || "?",
      agents: hb.queue ? hb.queue.active : 0,
      queue: hb.queue ? hb.queue.queued : 0,
      tokens,
      cost,
      last: ago(hb.lastEvent?.at),
    };
  });
  console.log(
    `${pad("NAME", 16)}${pad("UP", 4)}${pad("PORT", 7)}${pad("TRACKER", 9)}${pad("INGRESS", 9)}` +
      `${pad("AGENTS", 8)}${pad("QUEUE", 7)}${pad("TOKENS", 9)}${pad("COST", 9)}LAST EVENT`,
  );
  for (const r of rows) {
    console.log(
      `${pad(r.name, 16)}${pad(r.up, 4)}${pad(r.port, 7)}${pad(r.tracker, 9)}${pad(r.ingress, 9)}` +
        `${pad(r.agents, 8)}${pad(r.queue, 7)}${pad(r.tokens, 9)}${pad(r.cost, 9)}${r.last}`,
    );
  }
}
