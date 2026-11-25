// `agenthook follow [session-id]` — tail a LIVE agent read-only by streaming its
// Claude session transcript (JSONL). Never spawns a second process (unlike
// `claude --resume`), so it can't interfere with the running agent. With no id,
// auto-picks the newest dispatched transcript (its first turn carries the engine
// marker "=== TICKET ===", which a hand-run session won't have).
//
// Transcripts live under the agent's launch-cwd mangle: the repo root for steps without
// a worktree (a sandboxed one: under the state dir), the task's worktree for the rest. So it searches, per repo (or only the one
// `--repo <id>` names), the repo mangle plus every worktree mangle under the repo's base.
// The transcript layout comes from each agent adapter the profile runs (`sessions`,
// src/agents/): the profile's and every step's own `agent`.
//
// A REMOTE run (#830) keeps its transcript on the WORKER, not the hub: the in-flight
// remote runs are running.json entries that carry a `host` still declared in the config,
// and their stream is a read-only `tail -F` over ssh (the executor's probe argv, `-T` no
// pty — never an agent spawn). A remote run of an agent that keeps no transcript
// (opencode) falls back to the hub-side run log, as `top`'s Enter does.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { loadConfig, registryDir } from "../config.js";
import { worktreeDir } from "../paths.js";
import { reposOf } from "../repos.js";
import { sessionAgents } from "../sessions.js";
import { getAgent } from "../agents/index.js";
import { createStore } from "../store.js";
import { remoteProbeArgv, sshClientEnv, shQuote, remoteTranscriptDir } from "../dispatch/executor-ssh.js";
import { readRuns } from "../agent-api.js";
import { profileDir, resolveRunLog } from "../ui/logs.js";

/** Transcript dirs that exist for the given repos, per agent the profile runs: each repo's
 * root transcript dir, plus the transcript dir of every cwd under its worktree base
 * (`<base>/<ref>`, or `<base>/<repo.id>/<ref>` multi-repo — the adapter's `cwdDirs`).
 * Deduped, in search order. Throws when no agent of the profile keeps transcripts.
 * @param {import('../types.js').Config} cfg @param {import('../types.js').RepoConfig[]} repos
 * @returns {{ dirs: string[], searched: string[], files: {id: string, file: string}[] }}
 *   existing dirs + every location looked at + the session transcripts in those dirs */
export function transcriptDirs(cfg, repos) {
  /** @type {Map<string, import('../types.js').AgentSessions>} */
  const dirs = new Map();
  /** @type {string[]} */
  const searched = [];
  for (const { sessions } of sessionAgents(cfg)) {
    for (const repo of repos) {
      const root = sessions.transcriptDir(repo.path);
      searched.push(root);
      if (fs.existsSync(root) && !dirs.has(root)) dirs.set(root, sessions);
      // A sandboxed no-worktree run keeps its transcript in a receiver-owned dir, not `root`.
      if (cfg.sandbox && sessions.sandboxTranscriptDir) {
        const sbx = sessions.sandboxTranscriptDir(cfg.stateDir, repo.path);
        searched.push(sbx);
        if (fs.existsSync(sbx) && !dirs.has(sbx)) dirs.set(sbx, sessions);
      }
      const under = sessions.cwdDirs(cfg.multiRepo ? path.join(worktreeDir(cfg, repo), repo.id) : worktreeDir(cfg, repo));
      searched.push(under.searched);
      for (const d of under.dirs) if (!dirs.has(d)) dirs.set(d, sessions);
    }
  }
  return { dirs: [...dirs.keys()], searched, files: [...dirs].flatMap(([d, sessions]) => sessions.files(d)) };
}

/** The in-flight REMOTE runs a follow can reach (#830): running.json entries that name a
 * worker (`host`) whose harness still declares a `remote` block in the config (a renamed or
 * deleted harness is unreachable by construction). `worktree` is the worker launch cwd — the
 * run's transcript dir is mangled from it, under the worker user's $HOME.
 * @param {import('../types.js').Config} cfg @param {Record<string, unknown>} running
 * @returns {{ref: string, stepId: string, startedAt: string, worktree: string, harness: string, agent: string, host: string, remote: import('../types.js').RemoteHarness}[]} */
export function remoteFollowCandidates(cfg, running) {
  /** @type {{ref: string, stepId: string, startedAt: string, worktree: string, harness: string, agent: string, host: string, remote: import('../types.js').RemoteHarness}[]} */
  const out = [];
  for (const [ref, raw] of Object.entries(running ?? {})) {
    if (!raw || typeof raw !== "object") continue;
    const r = /** @type {{ stepId?: string, startedAt?: string, worktree?: string, harness?: string, agent?: string, host?: string }} */ (raw);
    const harness = typeof r.harness === "string" ? r.harness : undefined;
    const remote = harness ? cfg.harnesses?.[harness]?.remote : undefined;
    if (!remote || !harness || !r.host || !r.worktree) continue;
    out.push({ ref, stepId: r.stepId ?? "", startedAt: r.startedAt ?? "", worktree: r.worktree, harness: harness, agent: r.agent ?? "", host: r.host, remote });
  }
  return out;
}

/** Does the agent named `name` keep transcripts (the layout `follow` streams)? Unknown
 * names (an adapter removed since the run started) keep none.
 * @param {string|undefined} name */
export function keepsTranscripts(name) {
  try {
    return !!getAgent(name).sessions;
  } catch {
    return false;
  }
}

/** The remote script `follow` streams (#830): resolve the transcript dir under the worker
 * user's $HOME, pick `<id>.jsonl` (or, with no id, the newest `*.jsonl`), announce which
 * file it is tailing on an `AHF <file>` header line, then stream it — background
 * `tail -n 15 -F` with a closed-stdin watchdog (`cat >/dev/null`): with no pty (`-T`) sshd
 * sends no SIGHUP, so without the watchdog the tail would linger until it next writes. When
 * the local ssh dies (Ctrl-C), the remote `cat` gets EOF and kills the tail. Exits 3 when
 * there is no transcript yet. Pure.
 * @param {string} cwd the worker launch cwd @param {string|null} id @returns {string} */
function remoteFollowScript(cwd, id) {
  const dir = shQuote(remoteTranscriptDir(cwd));
  const pick = id
    ? `f="$HOME"/${dir}/${shQuote(id)}.jsonl; [ -f "$f" ] || f=""`
    : `f=$(ls -t "$HOME"/${dir}/*.jsonl 2>/dev/null | head -n1)`;
  return [
    `d="$HOME"/${dir}`,
    pick,
    `[ -n "$f" ] && [ -f "$f" ] || { echo "no transcript yet in $d" >&2; exit 3; }`,
    `echo "AHF $f"`,
    `tail -n 15 -F "$f" & t=$!`,
    `cat >/dev/null; kill $t 2>/dev/null; exit 0`,
  ].join("\n");
}

/** Tagged error: the worker is reachable but the run has not written a transcript yet —
 * `follow`'s candidate loop may try the next candidate. */
export class NoTranscriptYet extends Error {}

/** Stream an in-flight remote run's transcript read-only over ssh (#830): the executor's
 * PROBE argv (`-T`, no pty, `BatchMode=yes`, never `-A`) and the executor's own client env —
 * stdin is a pipe that is never written: the script's `cat >/dev/null` holds the link, and
 * when this process dies the remote `cat` gets EOF and kills the tail. Never starts an agent
 * process. Resolves when ssh exits 0;
 * rejects with one line otherwise — exit 3 (no transcript yet, tagged `noTranscript` for
 * `follow`'s candidate loop) or anything else (255 = unreachable worker).
 * @param {import('../types.js').RemoteHarness} remote @param {string} cwd the worker launch cwd
 * @param {string|null} id @param {string} harnessName the harness the run is on (error text)
 * @returns {Promise<void>} */
export async function followRemote(remote, cwd, id, harnessName) {
  // The executor's own ssh shape (executor-ssh.js's runRemote): stdin is a pipe follow never
  // writes — the script's closed-stdin watchdog (`cat >/dev/null; kill $t`) ties the remote
  // tail's lifetime to this connection, so it can't linger after Ctrl-C or a finished run.
  const child = spawn("ssh", remoteProbeArgv(remote, remoteFollowScript(cwd, id)), {
    stdio: ["pipe", "pipe", "pipe"],
    env: sshClientEnv({ tty: false }),
  });
  /** @type {string} */
  let errBuf = "";
  /** @type {string} */
  let buf = "";
  child.stderr.on("data", (c) => (errBuf += c));
  child.stdout.on("data", (c) => {
    buf += c.toString("utf8");
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.startsWith("AHF ")) {
        console.log(`following: ${remote.host}:${line.slice(4)}  (Ctrl+C to stop — agent keeps running)`);
        console.log("────────────────────────────────────────────────────────");
      } else if (line) render(line);
    }
  });
  return new Promise((resolve, reject) => {
    child.on("error", (e) => reject(e));
    child.on("close", (code) => {
      const first = errBuf.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
      if (code === 0) return resolve();
      reject(
        code === 3
          ? new NoTranscriptYet(
              `no transcript yet on ${remote.host} for ${id ?? "<newest>"} — the run has not written one (agent keeps running)`,
            )
          : new Error(`worker ${remote.host} (harness "${harnessName}") unreachable: ${first || `ssh exited ${code}`}`),
      );
    });
  });
}

/** A remote run of an agent that keeps no transcript (#830, opencode): there is nothing on
 * the worker to stream, so tail the HUB-side run log of the in-flight run — `top`'s
 * Enter-follow lookup (`readRuns` + `resolveRunLog`), raw renderer. New for remote runs only;
 * local `follow` for a no-transcript profile still errors as before. Resolves when `signal`
 * aborts (the command's never-aborting default blocks until Ctrl-C).
 * @param {import('../types.js').Config} cfg @param {{ref: string, agent: string, host: string}} cand
 * @param {AbortSignal} [signal] @returns {Promise<void>} */
export async function followRemoteRunLog(cfg, cand, signal = new AbortController().signal) {
  const dir = profileDir(registryDir, cfg.stateKey);
  const runs = dir ? readRuns(cfg.stateKey, cand.ref, dir) : [];
  const run = runs.find((r) => r.running);
  const file = run ? resolveRunLog(registryDir, cfg.stateKey, run.run) : null;
  if (!file) throw new Error(`agent ${cand.agent} keeps no transcript on ${cand.host} and no hub run log is readable for ${cand.ref}`);
  console.log(`agent ${cand.agent} keeps no transcript on ${cand.host} — following its hub run log (Ctrl+C to stop)`);
  console.log("────────────────────────────────────────────────────────");
  await tailFile(file, { signal, write: (s) => console.log(s) });
}

/** @param {string} s @param {number} [n] */
const clip = (s, n = 200) => {
  s = (s || "").replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n) + "…" : s;
};

/** Render one JSONL transcript line as a readable status line. @param {string} line */
function render(line) {
  let j;
  try {
    j = JSON.parse(line);
  } catch {
    return; // skip partial/non-JSON lines
  }
  const content = j.message?.content;
  const blocks = Array.isArray(content)
    ? content
    : typeof content === "string"
      ? [{ type: "text", text: content }]
      : [];
  for (const b of blocks) {
    if (b.type === "text" && b.text?.trim()) console.log("🤖 " + clip(b.text, 500));
    else if (b.type === "tool_use") console.log("🔧 " + b.name + "  " + clip(JSON.stringify(b.input), 140));
    else if (b.type === "tool_result") {
      const t = Array.isArray(b.content) ? b.content.map((/** @type {any} */ x) => x.text || "").join(" ") : b.content;
      console.log("   ↳ " + clip(t, 140));
    }
  }
}

/** Tail one local transcript file with the transcript renderer. @param {string} file @returns {Promise<void>} */
async function tailLocal(file) {
  console.log(`following: ${path.basename(file)}  (Ctrl+C to stop — agent keeps running)`);
  console.log("────────────────────────────────────────────────────────");
  // The tail loop, shared with `top`'s follow (#797), and a never-aborting signal (this
  // command blocks until Ctrl-C, as before).
  await tailFile(file, { signal: new AbortController().signal, write: (s) => console.log(s), render });
}

/** @param {any} args */
export async function follow(args) {
  const cfg = loadConfig({ configPath: args.config });
  let repos = reposOf(cfg);
  if ("repo" in args) {
    const hit = repos.find((r) => r.id === args.repo);
    if (!hit) throw new Error(`unknown repo "${args.repo}" — valid ids: ${repos.map((r) => r.id).join(", ")}`);
    repos = [hit];
  }
  // Local search only — a remote run's transcript never lands on the hub. Throws for a
  // profile whose agents keep no transcripts (unchanged); remote candidates don't need it.
  /** @type {{id: string, file: string}[]} */
  let files = [];
  /** @type {string[]} */
  let searched = [];
  try {
    const local = transcriptDirs(cfg, repos);
    files = local.files;
    searched = local.searched;
  } catch {
    /* no local transcripts — remote candidates (or the "not found" error) decide */
  }
  const candidates = remoteFollowCandidates(cfg, createStore(cfg.dataDir).listRunning());

  const id = args._[0];
  if (id) {
    const hit = files.find((f) => f.id === id);
    if (hit) return tailLocal(hit.file);
    // Nothing local: try each remote run whose agent keeps transcripts. Validate the id
    // before it can reach a remote script — it is shQuoted, but the whitelist is the
    // transcript layout, not a shell.
    const remoteCands = candidates.filter((c) => keepsTranscripts(c.agent));
    if (remoteCands.length && !/^[A-Za-z0-9-]+$/.test(id)) {
      throw new Error(`invalid session id "${id}" for a remote transcript (allowed: letters, digits, -)`);
    }
    /** @type {NoTranscriptYet|undefined} */
    let last;
    for (const cand of remoteCands) {
      try {
        await followRemote(cand.remote, cand.worktree, id, cand.harness);
        return;
      } catch (e) {
        if (!(e instanceof NoTranscriptYet)) throw e; // unreachable/other: stop with that line
        last = e; // no transcript on this worker yet — try the next candidate
      }
    }
    if (last) throw last;
    throw new Error(`session transcript not found: ${id} (searched ${searched.join(", ")})`);
  }

  // No id: an in-flight remote run wins — its transcript lives on the worker, so stream it
  // there (opencode: the hub-side run log). Otherwise the local auto-pick, unchanged.
  if (candidates.length) {
    const newest = candidates.slice().sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))[0];
    if (keepsTranscripts(newest.agent)) {
      await followRemote(newest.remote, newest.worktree, null, newest.harness);
      return;
    }
    // `args.signal` is optional (the CLI never passes one — the default blocks until Ctrl-C);
    // tests pass one so the run-log tail ends.
    return followRemoteRunLog(cfg, newest, args.signal);
  }

  let file = "";
  {
    const newest = files.map(({ file: full }) => ({ full, m: fs.statSync(full).mtimeMs })).sort((a, b) => b.m - a.m);
    for (const { full } of newest) {
      if (fs.readFileSync(full, "utf8").slice(0, 8000).includes("=== TICKET ===")) {
        file = full;
        break;
      }
    }
  }
  if (!file) throw new Error(`session transcript not found: <auto> (searched ${searched.join(", ")})`);
  return tailLocal(file);
}

/**
 * The shared tail loop: print the last `initialLines` lines of `file` through `render`,
 * then stream appended lines through it as `fs.watch` fires (tolerating a truncated/
 * rotated file). Resolves when `signal` aborts, closing the watcher. `write` is left to the
 * caller's renderer (the command's `render` writes itself) — it is the channel a caller uses
 * when it renders on its own.
 * @param {string} file the file to tail (it must exist)
 * @param {{signal: AbortSignal, write: (s: string) => unknown, initialLines?: number, render?: (line: string) => void}} o
 * @returns {Promise<void>}
 */
export async function tailFile(file, { signal, write, initialLines = 15, render = (l) => write(l + "\n") }) {
  const initial = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  for (const l of initial.slice(-initialLines)) render(l);

  let pos = fs.statSync(file).size;
  let buf = "";
  const drain = () => {
    const size = fs.statSync(file).size;
    if (size < pos) pos = 0; // file truncated/rotated
    if (size === pos) return;
    const fd = fs.openSync(file, "r");
    const b = Buffer.alloc(size - pos);
    fs.readSync(fd, b, 0, b.length, pos);
    fs.closeSync(fd);
    pos = size;
    buf += b.toString("utf8");
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      render(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
  };
  const watcher = fs.watch(file, { persistent: true }, drain);
  try {
    if (!signal.aborted) {
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    }
  } finally {
    watcher.close();
  }
}
