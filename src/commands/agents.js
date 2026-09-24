// `agenthook agents` — list running headless `claude -p` agent processes (human id,
// step, PR, runtime, title). These are plain OS processes the receiver spawns; no claude
// subcommand tracks them. Cross-platform via `ps` (-ww avoids arg truncation).
// The id/title/PR come from the profile's refmeta.json (written by dispatch);
// `--verbose` adds the raw pid + ref, `--json` prints machine-readable records.
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

/** Read a profile's usage.jsonl; return last record per ref (keyed by ref string).
 * @param {string} dir @returns {Record<string, {input:number, output:number, cacheRead?:number, cacheCreate?:number, costUsd?:number}>} */
function readLastUsage(dir) {
  /** @type {Record<string, {input:number, output:number, cacheRead?:number, cacheCreate?:number, costUsd?:number}>} */
  const out = {};
  let raw;
  try {
    raw = fs.readFileSync(path.join(dir, "usage.jsonl"), "utf8");
  } catch {
    return out;
  }
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const rec = JSON.parse(t);
      if (rec && rec.ref != null) out[String(rec.ref)] = rec;
    } catch { /* ignore garbage lines */ }
  }
  return out;
}

/** Format token counts + optional cost into the column string.
 * @param {number|undefined} input @param {number|undefined} output @param {number|undefined} costUsd
 * @returns {string} */
export function fmtTok(input, output, costUsd) {
  if (input == null && output == null) return "-";
  const k = (n = 0) => n < 1000 ? `${n}` : `${Math.round(n / 1000)}k`;
  const cost = typeof costUsd === "number" ? ` $${costUsd.toFixed(4)}` : "";
  return `${k(input)}/${k(output)}${cost}`;
}

/** Format the live context size (input + cacheRead + cacheCreate) and output for `ah agents`.
 * Shows the total tokens the model actually saw, so cache-heavy runs read ~1.5M not ~1.
 * @param {number|undefined} input @param {number|undefined} cacheRead @param {number|undefined} cacheCreate
 * @param {number|undefined} output @param {number|undefined} costUsd
 * @returns {string} */
export function fmtCtx(input, cacheRead, cacheCreate, output, costUsd) {
  if (input == null && cacheRead == null && cacheCreate == null && output == null) return "-";
  const total = (input || 0) + (cacheRead || 0) + (cacheCreate || 0);
  const fmt = (n = 0) => {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
    return `${n}`;
  };
  const cost = typeof costUsd === "number" ? ` $${costUsd.toFixed(4)}` : "";
  return `ctx=${fmt(total)} out=${fmt(output)}${cost}`;
}

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

/** Read a JSON state file from a profile dir; {} if absent/garbage.
 * @param {string} dir @param {string} file */
function readState(dir, file) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
  } catch {
    return {};
  }
}

/** @typedef {{ name: string, running: Record<string, any>, lastUsage: Record<string, any>, refmeta: Record<string, import('../types.js').RefMeta> }} ProfileState */

/** Build a profile record with running + lastUsage (token display) + refmeta (id/title/PR).
 * @param {string} name @param {string} dir @returns {ProfileState} */
function readProfile(name, dir) {
  return { name, running: readState(dir, "running.json"), lastUsage: readLastUsage(dir), refmeta: readState(dir, "refmeta.json") };
}

/** Token figures for a row: the live tally if the stream has started producing tokens,
 * else the ref's last completed run. @param {any} runInfo @param {any} last */
function usageFor(runInfo, last) {
  if (runInfo && typeof runInfo.input === "number") {
    const { input, cacheRead, cacheCreate, output } = runInfo;
    return { input, cacheRead, cacheCreate, output, costUsd: undefined };
  }
  return { input: last?.input, cacheRead: last?.cacheRead, cacheCreate: last?.cacheCreate, output: last?.output, costUsd: last?.costUsd };
}

const TITLE_MAX = 50;

/** @param {string} s @param {number} n */
const truncate = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** One human-readable `ah agents` line. Pure; exported for tests.
 *  default: `<displayId ?? ref>  <step>  <#pr | —>  <etime>  <title>  <ctx…>`
 * @param {AgentRow} row @param {import('../types.js').RefMeta|undefined} meta @param {string} tok  the fmtCtx column
 * @param {{ verbose?: boolean, all?: boolean }} [opts]
 * @returns {string} */
export function formatAgentRow(row, meta, tok, opts = {}) {
  const owner = opts.all ? `profile=${row.profile.padEnd(18)} ` : "";
  const id = meta?.displayId ?? row.ref;
  const pr = meta?.pr ? `#${meta.pr}` : "—";
  const title = truncate(meta?.title ?? "", TITLE_MAX);
  const extra = opts.verbose ? `  pid=${row.pid} ref=${row.ref}` : "";
  return `${owner}${id.padEnd(12)} ${row.step.padEnd(10)} ${pr.padEnd(6)} ${row.etime.padEnd(11)} ${title.padEnd(TITLE_MAX)} ${tok}${extra}`;
}

/** One `ah agents --json` record. Pure; exported for tests.
 * @param {AgentRow} row @param {import('../types.js').RefMeta|undefined} meta
 * @param {any} runInfo  running.json[ref] (may be undefined) @param {any} last  last usage.jsonl record for ref */
export function agentRecord(row, meta, runInfo, last) {
  const u = usageFor(runInfo, last);
  const known = u.input != null || u.cacheRead != null || u.cacheCreate != null;
  return {
    profile: row.profile,
    pid: Number(row.pid),
    ref: row.ref,
    displayId: meta?.displayId ?? null,
    title: meta?.title ?? null,
    pr: meta?.pr ?? null,
    step: row.step,
    model: runInfo?.model ?? null,
    startedAt: runInfo?.startedAt ?? null,
    ctx: known ? (u.input || 0) + (u.cacheRead || 0) + (u.cacheCreate || 0) : null,
    out: u.output ?? null,
    etime: row.etime,
  };
}

/** @param {any} [args] */
export async function agents(args = {}) {
  const ps = spawnSync("ps", ["-eo", "pid=,etime=,args=", "-ww"], { encoding: "utf8" });
  if (ps.status !== 0) throw new Error(`ps failed: ${ps.stderr || ps.error?.message || "unknown"}`);

  const all = !!args.all;
  /** @type {ProfileState[]} */
  let profiles;
  /** @type {string|null} */
  let active = null;
  let scope;
  if (all) {
    // Global view needs no config: read every profile's state dir directly.
    profiles = listProfiles().map((p) => readProfile(p.name, p.dir));
    scope = "all profiles";
  } else {
    const cfg = loadConfig({ configPath: args.config });
    active = cfg.name;
    profiles = [readProfile(cfg.name, cfg.dataDir)];
    scope = cfg.name;
  }

  /** @type {Map<string, ProfileState>} */
  const profileMap = new Map(profiles.map((p) => [p.name, p]));

  const rows = selectAgents(ps.stdout, profiles, { all, active });
  if (args.json) {
    const recs = rows.map((r) => {
      const prof = profileMap.get(r.profile);
      return agentRecord(r, prof?.refmeta?.[r.ref], prof?.running?.[r.ref], prof?.lastUsage?.[r.ref]);
    });
    console.log(JSON.stringify(recs, null, 2));
    return;
  }
  for (const r of rows) {
    const prof = profileMap.get(r.profile);
    const u = usageFor(prof?.running?.[r.ref], prof?.lastUsage?.[r.ref]);
    const tok = fmtCtx(u.input, u.cacheRead, u.cacheCreate, u.output, u.costUsd);
    console.log(formatAgentRow(r, prof?.refmeta?.[r.ref], tok, { verbose: !!args.verbose, all }));
  }
  console.log(`── ${rows.length} agent(s) running ── (${scope})`);
}
