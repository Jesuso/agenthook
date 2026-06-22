// Map a task ref back to the Claude session(s) an agent ran for it, and enumerate
// recent agent runs from the per-run logs. The receiver launches `claude -p` with
// cwd = the task's WORKTREE (dispatch.js: `cwd = hasWorktree ? worktree : repoPath`),
// and Claude keys a transcript dir by its launch cwd mangle — so a ref's sessions
// live under mangle(worktreePath(cfg, ref)), NOT the repo's mangle.
import fs from "node:fs";
import path from "node:path";
import { claudeProjectDir } from "./paths.js";
import { worktreePath } from "./worktree.js";

/** Claude transcript dir for a task ref's worktree.
 * @param {import('./types.js').Config} cfg @param {string} ref */
export const sessionDir = (cfg, ref) => claudeProjectDir(worktreePath(cfg, ref));

/** The session id to resume for a ref: the newest DISPATCHED transcript (its first
 * turn carries the engine's "=== TICKET ===" marker, which a hand-run session won't),
 * falling back to the newest transcript overall. Null if none exist.
 * @param {string} dir  a Claude project transcript dir */
export function findSessionId(dir) {
  let files;
  try {
    files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
  } catch {
    return null;
  }
  if (!files.length) return null;
  for (const { f } of files) {
    const head = fs.readFileSync(path.join(dir, f), "utf8").slice(0, 8000);
    if (head.includes("=== TICKET ===")) return f.replace(/\.jsonl$/, "");
  }
  return files[0].f.replace(/\.jsonl$/, "");
}

/** A run-log stamp (`2026-06-19T14-47-43-889Z`) back to epoch ms. NaN if unparseable.
 * @param {string} stamp */
function stampToMs(stamp) {
  const m = stamp.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/);
  return m ? Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${m[7]}Z`) : NaN;
}

/** Per-run records from cfg.logDir (`${stamp}-step-${stepId}-${safeRef}.log`, written
 * by dispatch for every run), oldest first. Optionally filtered to one ref. Logs
 * persist after a worktree is drained, so this surfaces finished tasks too.
 * @param {import('./types.js').Config} cfg @param {string} [onlyRef]
 * @returns {{ ref: string, step: string, at: number }[]} */
export function runLogs(cfg, onlyRef) {
  const stepIds = (cfg.pipeline || []).map((s) => s.id);
  let entries;
  try {
    entries = fs.readdirSync(cfg.logDir).filter((f) => f.endsWith(".log"));
  } catch {
    return [];
  }
  /** @type {{ ref: string, step: string, at: number }[]} */
  const out = [];
  for (const f of entries) {
    const m = f.match(/^(.*)-step-(.*)\.log$/);
    if (!m) continue;
    const rest = m[2]; // `${stepId}-${safeRef}`
    // Split stepId from ref using the known pipeline ids (either may contain '-').
    const stepId = stepIds.find((id) => rest === id || rest.startsWith(id + "-"));
    if (!stepId) continue;
    const ref = rest.slice(stepId.length + 1);
    if (!ref || (onlyRef && ref !== onlyRef)) continue;
    // The stamp is the run START; fall back to file mtime if it won't parse.
    const at = stampToMs(m[1]) || fs.statSync(path.join(cfg.logDir, f)).mtimeMs;
    out.push({ ref, step: stepId, at });
  }
  return out.sort((a, b) => a.at - b.at);
}

/** Recent agent runs, newest first, one row per ref (its latest run's step + time).
 * @param {import('./types.js').Config} cfg @param {number} [limit]
 * @returns {{ ref: string, step: string, at: number }[]} */
export function recentRuns(cfg, limit = 10) {
  /** @type {Map<string, { ref: string, step: string, at: number }>} */
  const byRef = new Map();
  for (const r of runLogs(cfg)) byRef.set(r.ref, r); // sorted oldest→newest, so last wins
  return [...byRef.values()].sort((a, b) => b.at - a.at).slice(0, limit);
}

/** Every Claude session recorded for a ref, oldest first, each labelled with the
 * pipeline step it ran (correlated by matching the session's first-message time to
 * the nearest run-log start for that ref). One `claude -p` per step run = one session.
 * @param {import('./types.js').Config} cfg @param {string} ref
 * @returns {{ id: string, step: string, at: number, msgs: number, prompt: string }[]} */
export function listSessions(cfg, ref) {
  const dir = sessionDir(cfg, ref);
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return [];
  }
  const runs = runLogs(cfg, ref); // [{step, at}]
  /** @type {{ id: string, step: string, at: number, msgs: number, prompt: string }[]} */
  const out = [];
  for (const f of files) {
    let firstTs = NaN;
    let prompt = "";
    let msgs = 0;
    for (const line of fs.readFileSync(path.join(dir, f), "utf8").split("\n")) {
      if (!line) continue;
      let d;
      try {
        d = JSON.parse(line);
      } catch {
        continue;
      }
      if (d.type !== "user" && d.type !== "assistant") continue;
      msgs++;
      if (Number.isNaN(firstTs) && d.timestamp) firstTs = Date.parse(d.timestamp);
      if (!prompt && d.type === "user") {
        const c = d.message?.content;
        const text = Array.isArray(c) ? c.map((/** @type {any} */ b) => b.text || "").join(" ") : c || "";
        prompt = String(text).replace(/\s+/g, " ").trim();
      }
    }
    const at = firstTs || fs.statSync(path.join(dir, f)).mtimeMs;
    // Nearest run-log start to this session's start = the step it ran.
    let step = "?";
    let best = Infinity;
    for (const r of runs) {
      const d = Math.abs(r.at - at);
      if (d < best) {
        best = d;
        step = r.step;
      }
    }
    out.push({ id: f.replace(/\.jsonl$/, ""), step, at, msgs, prompt });
  }
  return out.sort((a, b) => a.at - b.at);
}
