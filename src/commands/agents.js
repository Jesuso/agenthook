// `agenthook agents` — list running agent runs (human id, step, harness, model, PR, runtime,
// title). Rows come from each profile's running.json — the same state `tick` and the web UI
// read — written for every run whatever the agent or executor. So a sandboxed or remote (ssh)
// run, whose local process is a container runtime or `ssh` client rather than the agent binary,
// still shows up. No `ps`, no process table, no per-agent argv matcher.
// The id/title/PR come from the profile's refmeta.json (written by dispatch);
// `--verbose` adds the raw pid + ref, `--json` prints machine-readable records.
//
// Scope resolution never touches secrets: `agents <name>` resolves a label or state key
// to that profile's state dir directly; bare `agents` peeks the discovered config for its
// state key only
// (peekConfig, no `${VAR}` interpolation), so the listing works from any checkout —
// a worktree without .env used to get "unset environment variable(s)" and no rows.
// Default: only THIS profile's rows. `--all`: every profile's, each labelled with its owner.
import fs from "node:fs";
import path from "node:path";
import { peekConfig, registryDir } from "../config/index.js";
import { listProfiles, readProfile as readHeartbeat, resolveProfile } from "../heartbeat.js";

/** One running run, read from a profile's running.json. `profile` is the owning profile's state
 * key (the stable id). `pid` is null before the agent spawns (worktree/fetch phase); `stale`
 * marks a leftover whose pid no longer resolves (the receiver died; cleaned on next boot).
 * @typedef {{ ref: string, step: string, harness: string|null, agent: string|null, host: string|null, model: string|null, pid: string|null, etime: string, profile: string, stale: boolean }} AgentRow */

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

/** Elapsed time from `startedAt` to `now`, in `ps -o etime`'s `[[dd-]hh:]mm:ss` shape;
 * `?` when `startedAt` is missing or unparseable.
 * @param {string|undefined} startedAt @param {number} now ms since epoch
 * @returns {string} */
export function fmtEtime(startedAt, now = Date.now()) {
  const t = Date.parse(startedAt ?? "");
  if (Number.isNaN(t)) return "?";
  let s = Math.max(0, Math.floor((now - t) / 1000));
  const days = Math.floor(s / 86400);
  s %= 86400;
  const hh = String(Math.floor(s / 3600)).padStart(2, "0");
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return days > 0 ? `${days}-${hh}:${mm}:${ss}` : `${hh}:${mm}:${ss}`;
}

/** `process.kill(pid, 0)` liveness: alive when the pid resolves; EPERM still means "exists".
 * @param {string|number} pid @returns {boolean} */
function pidAlive(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (e) {
    return e?.code === "EPERM";
  }
}

/** One row per running.json entry across the given profiles. Pure for offline tests; `isAlive`
 * is injected so tests don't depend on real pids. A row whose pid `isAlive` says is gone is
 * marked `stale`; a row with no pid yet (worktree/fetch phase) counts as running.
 * @param {{ stateKey: string, running: Record<string, any> }[]} profiles each profile's running.json
 * @param {{ all?: boolean, active?: string|null, now?: number, isAlive?: (pid: string|number) => boolean }} [opts] active = the state key to scope to when !all
 * @returns {AgentRow[]} */
export function runningRows(profiles, opts = {}) {
  const { all = false, active = null, now = Date.now(), isAlive } = opts;
  /** @type {AgentRow[]} */
  const rows = [];
  for (const p of profiles) {
    for (const [ref, info] of Object.entries(p.running || {})) {
      const pid = info && info.pid != null ? String(info.pid) : null;
      /** @type {AgentRow} */
      const row = {
        ref: String(ref),
        step: info?.stepId ?? "?",
        harness: info?.harness ?? null,
        agent: info?.agent ?? null,
        host: info?.host ?? null,
        model: info?.model ?? null,
        pid,
        etime: fmtEtime(info?.startedAt, now),
        profile: p.stateKey,
        stale: false,
      };
      if (pid != null && isAlive && !isAlive(pid)) row.stale = true;
      rows.push(row);
    }
  }
  return all ? rows : rows.filter((r) => r.profile === active);
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

/** `label` is the display name: the profile's label, `Label (stateKey)` when they differ.
 * @typedef {{ stateKey: string, label: string, running: Record<string, any>, lastUsage: Record<string, any>, refmeta: Record<string, import('../types/index.js').RefMeta> }} ProfileState */

/** Build a profile record with running + lastUsage (token display) + refmeta (id/title/PR).
 * @param {{ stateKey: string, name: string, dir: string }} p a heartbeat.js profile entry @returns {ProfileState} */
function readProfile({ stateKey, name, dir }) {
  const label = name === stateKey ? name : `${name} (${stateKey})`;
  return { stateKey, label, running: readState(dir, "running.json"), lastUsage: readLastUsage(dir), refmeta: readState(dir, "refmeta.json") };
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
 *  default: `<displayId ?? ref>  <step>  <#pr | —>  <etime>  <harness@host>  <model>  <title>  <ctx…>`
 * @param {AgentRow} row @param {import('../types/index.js').RefMeta|undefined} meta @param {string} tok  the fmtCtx column
 * @param {{ verbose?: boolean, all?: boolean, label?: string }} [opts] label = the owner's display name (default the state key)
 * @returns {string} */
export function formatAgentRow(row, meta, tok, opts = {}) {
  const owner = opts.all ? `profile=${(opts.label ?? row.profile).padEnd(18)} ` : "";
  const id = meta?.displayId ?? row.ref;
  const pr = meta?.pr ? `#${meta.pr}` : "—";
  const harness = row.harness ? row.harness + (row.host ? `@${row.host}` : "") : "-";
  const model = row.model ?? "-";
  const title = truncate(meta?.title ?? "", TITLE_MAX);
  const stale = row.stale ? " [stale]" : "";
  const extra = opts.verbose ? `  pid=${row.pid ?? "-"} ref=${row.ref}` : "";
  return `${owner}${id.padEnd(12)} ${row.step.padEnd(10)} ${pr.padEnd(6)} ${row.etime.padEnd(11)} ${harness.padEnd(18)} ${model.padEnd(18)} ${title.padEnd(TITLE_MAX)} ${tok}${stale}${extra}`;
}

/** One `ah agents --json` record. Pure; exported for tests.
 * @param {AgentRow} row @param {import('../types/index.js').RefMeta|undefined} meta
 * @param {any} runInfo  running.json[ref] (may be undefined) @param {any} last  last usage.jsonl record for ref
 * @param {string} [label] the owner's display name (default the state key) */
export function agentRecord(row, meta, runInfo, last, label = row.profile) {
  const u = usageFor(runInfo, last);
  const known = u.input != null || u.cacheRead != null || u.cacheCreate != null;
  return {
    profile: row.profile,
    label,
    pid: row.pid != null ? Number(row.pid) : null,
    ref: row.ref,
    displayId: meta?.displayId ?? null,
    title: meta?.title ?? null,
    pr: meta?.pr ?? null,
    step: row.step,
    harness: row.harness,
    agent: row.agent,
    host: row.host,
    model: row.model,
    startedAt: runInfo?.startedAt ?? null,
    ctx: known ? (u.input || 0) + (u.cacheRead || 0) + (u.cacheCreate || 0) : null,
    out: u.output ?? null,
    etime: row.etime,
    stale: row.stale ?? false,
  };
}

/** @param {any} [args] */
export async function agents(args = {}) {
  const all = !!args.all;
  /** @type {ProfileState[]} */
  let profiles;
  /** @type {string|null} */
  let active = null;
  let scope;
  if (all) {
    // Global view needs no config: read every profile's state dir directly.
    profiles = listProfiles().map(readProfile);
    scope = "all profiles";
  } else if (args._?.[0]) {
    // A label or a state key; a label shared by two profiles is an error, not a guess.
    const arg = String(args._[0]);
    let found;
    try {
      found = resolveProfile(arg);
    } catch (e) {
      console.error(e.message);
      process.exitCode = 1;
      return;
    }
    const prof = readProfile(found ?? { stateKey: arg, name: arg, dir: path.join(registryDir, arg) });
    active = prof.stateKey;
    profiles = [prof];
    scope = prof.label;
  } else {
    const prof = readProfile(readHeartbeat(peekConfig({ configPath: args.config }).stateKey));
    active = prof.stateKey;
    profiles = [prof];
    scope = prof.label;
  }

  /** @type {Map<string, ProfileState>} */
  const profileMap = new Map(profiles.map((p) => [p.stateKey, p]));

  const rows = runningRows(profiles, { all, active, now: Date.now(), isAlive: pidAlive });
  if (args.json) {
    const recs = rows.map((r) => {
      const prof = profileMap.get(r.profile);
      return agentRecord(r, prof?.refmeta?.[r.ref], prof?.running?.[r.ref], prof?.lastUsage?.[r.ref], prof?.label);
    });
    console.log(JSON.stringify(recs, null, 2));
    return;
  }
  for (const r of rows) {
    const prof = profileMap.get(r.profile);
    const u = usageFor(prof?.running?.[r.ref], prof?.lastUsage?.[r.ref]);
    const tok = fmtCtx(u.input, u.cacheRead, u.cacheCreate, u.output, u.costUsd);
    console.log(formatAgentRow(r, prof?.refmeta?.[r.ref], tok, { verbose: !!args.verbose, all, label: prof?.label }));
  }
  const running = rows.filter((r) => !r.stale).length;
  console.log(`── ${running} agent(s) running ── (${scope})`);
}
