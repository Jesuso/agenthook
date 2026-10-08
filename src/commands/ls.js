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

/** Total tokens + cost from a profile's usage.jsonl; blanks when absent/unreadable. @param {string} dir */
function usageOf(dir) {
  try {
    const records = createStore(dir).readUsage();
    if (!records.length) return { tokens: "", cost: "" };
    let totalTokens = 0;
    let totalCost = 0;
    let hasCost = false;
    for (const r of records) {
      totalTokens += (r.input || 0) + (r.output || 0);
      if (r.costUsd != null) { totalCost += r.costUsd; hasCost = true; }
    }
    return { tokens: fmtTokens(totalTokens), cost: hasCost ? `$${totalCost.toFixed(2)}` : "" };
  } catch {
    return { tokens: "", cost: "" }; // usage.jsonl absent or unreadable — leave blank
  }
}

/**
 * The `ls` table + duplicate-label warnings as lines. NAME is the label, `Label (stateKey)`
 * when they differ; the column widens to fit (min 16). Pure; exported for tests.
 * @param {{ stateKey: string, name: string, up: boolean, heartbeat: any }[]} profiles listProfiles() entries
 * @param {(p: any) => { tokens: string, cost: string }} [usage]
 * @returns {string[]}
 */
export function formatLs(profiles, usage = () => ({ tokens: "", cost: "" })) {
  const rows = profiles.map((p) => {
    const hb = p.heartbeat || {};
    return {
      name: p.name === p.stateKey ? p.name : `${p.name} (${p.stateKey})`,
      up: p.up ? "*" : " ",
      port: hb.port || "?",
      tracker: hb.tracker || "?",
      ingress: hb.ingress || "?",
      repos: hb.repos?.length ?? 1,
      agents: hb.queue ? hb.queue.active : 0,
      queue: hb.queue ? hb.queue.queued : 0,
      ...usage(p),
      last: ago(hb.lastEvent?.at),
    };
  });
  const w = Math.max(16, ...rows.map((r) => r.name.length + 2));
  const lines = [
    `${pad("NAME", w)}${pad("UP", 4)}${pad("PORT", 7)}${pad("TRACKER", 9)}${pad("INGRESS", 9)}${pad("REPOS", 7)}` +
      `${pad("AGENTS", 8)}${pad("QUEUE", 7)}${pad("TOKENS", 9)}${pad("COST", 9)}LAST EVENT`,
  ];
  for (const r of rows) {
    lines.push(
      `${pad(r.name, w)}${pad(r.up, 4)}${pad(r.port, 7)}${pad(r.tracker, 9)}${pad(r.ingress, 9)}${pad(r.repos, 7)}` +
        `${pad(r.agents, 8)}${pad(r.queue, 7)}${pad(r.tokens, 9)}${pad(r.cost, 9)}${r.last}`,
    );
  }
  /** @type {Map<string, string[]>} */
  const byLabel = new Map();
  for (const p of profiles) byLabel.set(p.name, [...(byLabel.get(p.name) || []), p.stateKey]);
  for (const [label, keys] of byLabel) {
    if (keys.length > 1) lines.push(`warning: label "${label}" is shared by ${keys.join(", ")} — address them by state key`);
  }
  return lines;
}

export async function ls() {
  const profiles = listProfiles();
  if (!profiles.length) {
    console.log("no profiles yet. Run `agenthook init` in a project dir to create one.");
    return;
  }
  for (const line of formatLs(profiles, (p) => usageOf(p.dir))) console.log(line);
}
