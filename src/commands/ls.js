// `agenthook ls` — table of every profile under ~/.agenthook and its live status.
// Reads each profile's heartbeat + pidfile; never touches the running process.
import { listProfiles } from "../heartbeat.js";

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

export async function ls() {
  const profiles = listProfiles();
  if (!profiles.length) {
    console.log("no profiles yet. Run `agenthook init` in a project dir to create one.");
    return;
  }
  const rows = profiles.map((p) => {
    const hb = p.heartbeat || {};
    return {
      name: p.name,
      up: p.up ? "*" : " ",
      port: hb.port || "?",
      tracker: hb.tracker || "?",
      ingress: hb.ingress || "?",
      agents: hb.queue ? hb.queue.active : 0,
      queue: hb.queue ? hb.queue.queued : 0,
      last: ago(hb.lastEvent?.at),
    };
  });
  console.log(
    `${pad("NAME", 16)}${pad("UP", 4)}${pad("PORT", 7)}${pad("TRACKER", 9)}${pad("INGRESS", 9)}` +
      `${pad("AGENTS", 8)}${pad("QUEUE", 7)}LAST EVENT`,
  );
  for (const r of rows) {
    console.log(
      `${pad(r.name, 16)}${pad(r.up, 4)}${pad(r.port, 7)}${pad(r.tracker, 9)}${pad(r.ingress, 9)}` +
        `${pad(r.agents, 8)}${pad(r.queue, 7)}${r.last}`,
    );
  }
}
