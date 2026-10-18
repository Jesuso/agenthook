// Map a task ref back to the Claude session(s) an agent ran for it, and enumerate
// recent agent runs from the per-run logs. The receiver launches `claude -p` with
// cwd = the task's WORKTREE (dispatch.js: `cwd = hasWorktree ? worktree : repoPath`),
// and Claude keys a transcript dir by its launch cwd mangle — so a ref's sessions
// live under mangle(worktreePath(cfg, ref)), NOT the repo's mangle. The transcript layout
// comes from each agent adapter the profile runs (`sessions`, src/agents/) — the profile's
// and every step's own `agent`, so a cursor step in a claude profile is found too.
import fs from "node:fs";
import path from "node:path";
import { agentFor } from "./agents/index.js";
import { worktreePath } from "./worktree.js";
import { reposOf, repoById, primaryRepo } from "./repos.js";

/** A path's mtime in ms, or -1 if it doesn't exist. @param {string} p */
const mtime = (p) => {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return -1;
  }
};

/** An agent's session layout; throws a plain error for an agent that keeps no transcripts
 * (one with a top-level `resumeCommand` still resumes, from usage.jsonl — see listSessions).
 * @param {import('./types.js').AgentAdapter} agent */
export function agentSessions(agent) {
  if (!agent.sessions) throw new Error(`${agent.describe().name} runs have no transcripts to follow${agent.resumeCommand ? "" : "/resume"}`);
  return agent.sessions;
}

/** The distinct agents whose transcripts a profile's runs may have left: the profile's agent,
 * then every non-manual step's, keeping only those with `sessions`. Throws (the profile
 * agent's plain error) when none keeps transcripts.
 * @param {Pick<import('./types.js').Config, 'agent'|'pipeline'>} cfg
 * @returns {{name: string, sessions: import('./types.js').AgentSessions}[]} */
export function sessionAgents(cfg) {
  /** @type {Map<string, import('./types.js').AgentSessions>} */
  const seen = new Map();
  for (const agent of [agentFor(cfg), ...(cfg.pipeline ?? []).filter((s) => !s.manual).map((s) => agentFor(cfg, s))]) {
    const name = agent.describe().name;
    if (agent.sessions && !seen.has(name)) seen.set(name, agent.sessions);
  }
  if (!seen.size) agentSessions(agentFor(cfg));
  return [...seen].map(([name, sessions]) => ({ name, sessions }));
}

/**
 * The repo a ref ran in. Multi-repo worktrees nest under `<base>/<repo.id>/<ref>`, so the
 * transcript dir depends on it. The sticky `repo.json` entry wins; a drained ref has none
 * (cleared on terminal states), so fall back to the repo whose worktree transcript dir
 * exists (newest mtime if several), else the default repo. Single-repo: always the one.
 * @param {import('./types.js').Config} cfg @param {string} ref
 * @param {{ getRepo: (ref: string) => string|undefined }} [store]
 * @returns {import('./types.js').RepoConfig} */
export function refRepo(cfg, ref, store) {
  const sticky = repoById(cfg, store?.getRepo(ref));
  if (sticky) return sticky;
  /** @type {{name: string, sessions: import('./types.js').AgentSessions}[]} */
  let agents;
  try {
    agents = sessionAgents(cfg);
  } catch {
    return primaryRepo(cfg);
  }
  let best = null;
  let bestM = -1;
  for (const repo of reposOf(cfg)) {
    const wt = worktreePath(cfg, ref, repo);
    const m = Math.max(...agents.map((a) => mtime(a.sessions.transcriptDir(wt))));
    if (m > bestM) {
      best = repo;
      bestM = m;
    }
  }
  return best ?? primaryRepo(cfg);
}

/** The agent's transcript dir for a task ref's worktree (the profile's agent; throws when it keeps none).
 * @param {import('./types.js').Config} cfg @param {string} ref
 * @param {{ getRepo: (ref: string) => string|undefined }} [store] */
export const sessionDir = (cfg, ref, store) => agentSessions(agentFor(cfg)).transcriptDir(worktreePath(cfg, ref, refRepo(cfg, ref, store)));

/** Every agent's transcript dir for a task ref's worktree (see `sessionAgents`).
 * @param {import('./types.js').Config} cfg @param {string} ref
 * @param {{ getRepo: (ref: string) => string|undefined }} [store]
 * @returns {{name: string, sessions: import('./types.js').AgentSessions, dir: string}[]} */
export function sessionDirs(cfg, ref, store) {
  const wt = worktreePath(cfg, ref, refRepo(cfg, ref, store));
  return sessionAgents(cfg).map((a) => ({ ...a, dir: a.sessions.transcriptDir(wt) }));
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

/** Every agent session recorded for a ref, oldest first, each labelled with the
 * pipeline step it ran (correlated by matching the session's first-message time to
 * the nearest run-log start for that ref) and the agent that wrote it. One agent run
 * per step run = one session. A line's kind is its `type` (Claude) or `role` (Cursor).
 * An agent with no transcripts but a top-level `resumeCommand` (opencode) contributes one
 * session per usage.jsonl record of the ref that names a session id — its step is the
 * record's, no correlation needed. A profile where no agent keeps transcripts lists only those.
 * @param {import('./types.js').Config} cfg @param {string} ref
 * @param {{ getRepo: (ref: string) => string|undefined, readUsage?: () => import('./types.js').UsageRecord[] }} [store]
 * @returns {{ id: string, step: string, at: number, msgs: number, prompt: string, agent: string }[]} */
export function listSessions(cfg, ref, store) {
  /** @type {{name: string, sessions: import('./types.js').AgentSessions, dir: string}[]} */
  let dirs;
  try {
    dirs = sessionDirs(cfg, ref, store);
  } catch {
    dirs = []; // no agent of the profile keeps transcripts
  }
  const files = dirs.flatMap(({ name, sessions, dir }) => sessions.files(dir).map((f) => ({ ...f, agent: name })));
  const runs = runLogs(cfg, ref); // [{step, at}]
  /** @type {{ id: string, step: string, at: number, msgs: number, prompt: string, agent: string }[]} */
  const out = [];
  for (const f of files) {
    let firstTs = NaN;
    let prompt = "";
    let msgs = 0;
    for (const line of fs.readFileSync(f.file, "utf8").split("\n")) {
      if (!line) continue;
      let d;
      try {
        d = JSON.parse(line);
      } catch {
        continue;
      }
      const kind = d.type ?? d.role;
      if (kind !== "user" && kind !== "assistant") continue;
      msgs++;
      if (Number.isNaN(firstTs) && d.timestamp) firstTs = Date.parse(d.timestamp);
      if (!prompt && kind === "user") {
        const c = d.message?.content;
        const text = Array.isArray(c) ? c.map((/** @type {any} */ b) => b.text || "").join(" ") : c || "";
        prompt = String(text).replace(/\s+/g, " ").trim();
      }
    }
    const at = firstTs || f.at || fs.statSync(f.file).mtimeMs;
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
    out.push({ id: f.id, step, at, msgs, prompt, agent: f.agent });
  }
  const seenIds = new Set(out.map((s) => s.id));
  for (const rec of store?.readUsage?.() ?? []) {
    if (rec.ref !== ref || !rec.sessionId || seenIds.has(rec.sessionId)) continue;
    const agent = agentFor(cfg, (cfg.pipeline ?? []).find((s) => s.id === rec.stepId));
    if (agent.sessions || !agent.resumeCommand) continue;
    seenIds.add(rec.sessionId);
    out.push({ id: rec.sessionId, step: rec.stepId, at: Date.parse(rec.startedAt), msgs: 0, prompt: "", agent: agent.describe().name });
  }
  return out.sort((a, b) => a.at - b.at);
}
