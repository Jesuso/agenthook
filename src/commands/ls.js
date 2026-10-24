// `agenthook ls` — table of every profile under ~/.agenthook and its live status.
// Reads each profile's heartbeat + pidfile; never touches the running process.
import { listProfiles } from "../heartbeat.js";
import { tildify } from "../profile.js";
import { createStore } from "../store.js";
import { formatSpend, pricingOf, sumCosts } from "../pricing.js";
import { claimedPorts } from "../port.js";

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

/** `s` cut to its last `n` chars, led by `…` when cut. Pure. @param {string} s @param {number} n */
export function truncLeft(s, n) {
  return s.length <= n ? s : `…${s.slice(s.length - (n - 1))}`;
}

/** Budget for the CONFIG column, so a typical row stays under ~140 cols. */
export const CONFIG_WIDTH = 40;

/** An ISO timestamp's date part (YYYY-MM-DD), or "?". @param {string|null|undefined} iso */
export const day = (iso) => (iso && !Number.isNaN(Date.parse(iso)) ? new Date(iso).toISOString().slice(0, 10) : "?");

/**
 * The CONFIG cell: the tildified, left-truncated config path (`(missing)` when the file is gone),
 * `— never ran (created <date>)` for a ghost, `?` when unknown (a legacy pre-marker dir). Pure.
 * @param {{ configPath?: string|null, createdAt?: string|null, ghost?: boolean, configMissing?: boolean }} p
 */
export function configCell(p) {
  if (p.ghost) return `— never ran (created ${day(p.createdAt)})`;
  if (!p.configPath) return "?";
  return truncLeft(tildify(p.configPath), CONFIG_WIDTH) + (p.configMissing ? " (missing)" : "");
}

/** @param {string} s @param {number} n */
const pad = (s, n) => String(s).padEnd(n);

/** Format token count as short string. @param {number} n */
function fmtTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

/**
 * Total tokens + spend from a profile's usage.jsonl — reported and rate-table estimated kept
 * apart (src/pricing.js `formatSpend`), priced with the heartbeat's `pricing` overrides; blanks
 * when absent/unreadable.
 * @param {string} dir @param {any} [heartbeat]
 */
function usageOf(dir, heartbeat) {
  try {
    const records = createStore(dir).readUsage();
    if (!records.length) return { tokens: "", cost: "" };
    let totalTokens = 0;
    for (const r of records) totalTokens += (r.input || 0) + (r.output || 0);
    return { tokens: fmtTokens(totalTokens), cost: formatSpend(sumCosts(records, pricingOf(heartbeat))) };
  } catch {
    return { tokens: "", cost: "" }; // usage.jsonl absent or unreadable — leave blank
  }
}

/**
 * The `ls` table + duplicate-label warnings as lines. NAME is the label, `Label (stateKey)`
 * when they differ; the column widens to fit (min 16). CONFIG (last) is configCell. Pure; exported for tests.
 * @param {{ stateKey: string, name: string, up: boolean, heartbeat: any, configPath?: string|null, createdAt?: string|null, ghost?: boolean, configMissing?: boolean, configuredPort?: number|null }[]} profiles listProfiles() entries
 * @param {(p: any) => { tokens: string, cost: string }} [usage]
 * @returns {string[]}
 */
export function formatLs(profiles, usage = () => ({ tokens: "", cost: "" })) {
  const rows = profiles.map((p) => {
    const hb = p.heartbeat || {};
    // A running profile's heartbeat has the live port; a stopped one only has its configured
    // port (claimedPorts, read from its config) — marked with `*` so it reads as configured,
    // not observed.
    const port = hb.port || (p.configuredPort != null ? `${p.configuredPort}*` : "?");
    return {
      name: p.name === p.stateKey ? p.name : `${p.name} (${p.stateKey})`,
      up: p.up ? "*" : " ",
      port,
      tracker: hb.tracker || "?",
      ingress: hb.ingress || "?",
      repos: hb.repos?.length ?? 1,
      agents: hb.queue ? hb.queue.active : 0,
      queue: hb.queue ? hb.queue.queued : 0,
      ...usage(p),
      last: ago(hb.lastEvent?.at),
      config: configCell(p),
    };
  });
  const w = Math.max(16, ...rows.map((r) => r.name.length + 2));
  const cw = Math.max(9, ...rows.map((r) => r.cost.length + 2)); // "$12.40 + ~$3.10 est." widens COST
  const lines = [
    `${pad("NAME", w)}${pad("UP", 4)}${pad("PORT", 7)}${pad("TRACKER", 9)}${pad("INGRESS", 9)}${pad("REPOS", 7)}` +
      `${pad("AGENTS", 8)}${pad("QUEUE", 7)}${pad("TOKENS", 9)}${pad("COST", cw)}${pad("LAST EVENT", 12)}CONFIG`,
  ];
  for (const r of rows) {
    lines.push(
      `${pad(r.name, w)}${pad(r.up, 4)}${pad(r.port, 7)}${pad(r.tracker, 9)}${pad(r.ingress, 9)}${pad(r.repos, 7)}` +
        `${pad(r.agents, 8)}${pad(r.queue, 7)}${pad(r.tokens, 9)}${pad(r.cost, cw)}${pad(r.last, 12)}${r.config}`,
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
  const configuredPort = new Map(claimedPorts().map((c) => [c.stateKey, c.port]));
  const rows = profiles.map((p) => ({ ...p, configuredPort: configuredPort.get(p.stateKey) ?? null }));
  for (const line of formatLs(rows, (p) => usageOf(p.dir, p.heartbeat))) console.log(line);
}
