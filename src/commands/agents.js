// `agenthook agents` — list running headless `claude -p` agent processes (pid,
// runtime, step, ref). These are plain OS processes the receiver spawns; no claude
// subcommand tracks them. Cross-platform via `ps` (-ww avoids arg truncation).
//
// `ps` greps SYSTEM-WIDE, so co-running profiles' agents would otherwise show up
// here too. We attribute each row to its owning profile by cross-referencing each
// profile's running.json (ref -> {pid,…}, our crash-recovery state) — no /proc, so
// it stays cross-platform. Default: only THIS profile's agents. `--all`: every
// profile's, each row labelled with its owner.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../config.js";
import { listProfiles } from "../heartbeat.js";

/** @typedef {{ pid: string, etime: string, step: string, ref: string, profile: string }} AgentRow */

// The `claude` bin must START the command (path-anchored), not appear mid-line: a
// loose substring counts any process whose argv merely MENTIONS "claude -p" (a shell
// grepping for it, an echo, …). `cfg.claudeBin` defaults to "claude", so the receiver's
// spawn is `[node …/]claude -p <prompt>`.
const CLAUDE_P = /(^|\/)claude\s+-p\b/;

/** Parse `ps -eo pid=,etime=,args=` output into the agent rows (receiver-spawned only).
 * @param {string} stdout @returns {AgentRow[]} */
export function parsePsAgents(stdout) {
  /** @type {AgentRow[]} */
  const rows = [];
  for (const line of stdout.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    const [, pid, etime, cmd] = m;
    if (!CLAUDE_P.test(cmd)) continue;
    const step = cmd.match(/the "([^"]+)" stage/)?.[1] || "?";
    const ref = cmd.match(/ Ref: (\S+)/)?.[1] || "?";
    // The receiver's prompt always carries both a `the "<id>" stage` line and `Ref: <ref>`;
    // a row resolving NEITHER matched the bin but isn't one of ours (e.g. a manual `claude -p`).
    if (step === "?" && ref === "?") continue;
    rows.push({ pid, etime, step, ref, profile: "?" });
  }
  return rows;
}

/** Attribute each agent row to its owning profile (pid is the strong signal, ref the
 * fallback) and select which to show. Pure for offline testing.
 * @param {string} stdout raw `ps` output
 * @param {{ name: string, running: Record<string, any> }[]} profiles each profile's running.json
 * @param {{ all?: boolean, active?: string|null }} [opts] active = the profile to scope to when !all
 * @returns {AgentRow[]} */
export function selectAgents(stdout, profiles, opts = {}) {
  const rows = parsePsAgents(stdout);
  /** @type {Map<string, string>} */
  const byPid = new Map();
  /** @type {Map<string, string>} */
  const byRef = new Map();
  for (const p of profiles) {
    for (const [ref, info] of Object.entries(p.running || {})) {
      if (info && info.pid != null) byPid.set(String(info.pid), p.name);
      byRef.set(String(ref), p.name);
    }
  }
  for (const r of rows) r.profile = byPid.get(r.pid) ?? byRef.get(r.ref) ?? "?";
  return opts.all ? rows : rows.filter((r) => r.profile === opts.active);
}

/** Read a profile's running.json (ref -> {pid,…}); {} if absent/garbage. @param {string} dir */
function readRunning(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "running.json"), "utf8"));
  } catch {
    return {};
  }
}

/** @param {any} [args] */
export async function agents(args = {}) {
  const ps = spawnSync("ps", ["-eo", "pid=,etime=,args=", "-ww"], { encoding: "utf8" });
  if (ps.status !== 0) throw new Error(`ps failed: ${ps.stderr || ps.error?.message || "unknown"}`);

  const all = !!args.all;
  /** @type {{ name: string, running: Record<string, any> }[]} */
  let profiles;
  /** @type {string|null} */
  let active = null;
  let scope;
  if (all) {
    // Global view needs no config: read every profile's state dir directly.
    profiles = listProfiles().map((p) => ({ name: p.name, running: readRunning(p.dir) }));
    scope = "all profiles";
  } else {
    const cfg = loadConfig({ configPath: args.config });
    active = cfg.name;
    profiles = [{ name: cfg.name, running: readRunning(cfg.dataDir) }];
    scope = cfg.name;
  }

  const rows = selectAgents(ps.stdout, profiles, { all, active });
  for (const r of rows) {
    const owner = all ? `profile=${r.profile.padEnd(18)} ` : "";
    console.log(`pid=${r.pid.padEnd(7)} ${r.etime.padEnd(11)} ${owner}step=${r.step.padEnd(10)} ref=${r.ref}`);
  }
  console.log(`── ${rows.length} agent(s) running ── (${scope})`);
}
