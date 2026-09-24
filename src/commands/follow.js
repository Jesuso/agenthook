// `agenthook follow [session-id]` — tail a LIVE agent read-only by streaming its
// Claude session transcript (JSONL). Never spawns a second process (unlike
// `claude --resume`), so it can't interfere with the running agent. With no id,
// auto-picks the newest dispatched transcript (its first turn carries the engine
// marker "=== TICKET ===", which a hand-run session won't have).
//
// Transcripts live under the agent's launch-cwd mangle: the repo root for steps without
// a worktree, the task's worktree for the rest. So it searches, per repo (or only the one
// `--repo <id>` names), the repo mangle plus every worktree mangle under the repo's base.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../config.js";
import { claudeProjectDir, mangle, worktreeDir } from "../paths.js";
import { reposOf } from "../repos.js";

/** `.jsonl` names in a dir ([] if unreadable). @param {string} dir */
const jsonls = (dir) => {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return [];
  }
};

/** Transcript dirs that exist for the given repos: each repo's root mangle, plus every
 * `~/.claude/projects` entry under its worktree-base mangle (`<base>/<ref>`, or
 * `<base>/<repo.id>/<ref>` multi-repo). Deduped, in search order.
 * @param {import('../types.js').Config} cfg @param {import('../types.js').RepoConfig[]} repos
 * @returns {{ dirs: string[], searched: string[] }} existing dirs + every location looked at */
export function transcriptDirs(cfg, repos) {
  const projects = path.join(os.homedir(), ".claude", "projects");
  /** @type {string[]} */
  let entries = [];
  try {
    entries = fs.readdirSync(projects);
  } catch {
    /* no Claude projects dir yet */
  }
  /** @type {Set<string>} */
  const dirs = new Set();
  /** @type {string[]} */
  const searched = [];
  for (const repo of repos) {
    const root = claudeProjectDir(repo.path);
    searched.push(root);
    if (fs.existsSync(root)) dirs.add(root);
    const base = cfg.multiRepo ? path.join(worktreeDir(cfg, repo), repo.id) : worktreeDir(cfg, repo);
    const prefix = mangle(base) + "-";
    searched.push(path.join(projects, `${prefix}*`));
    for (const e of entries) if (e.startsWith(prefix)) dirs.add(path.join(projects, e));
  }
  return { dirs: [...dirs], searched };
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

/** @param {any} args */
export async function follow(args) {
  const cfg = loadConfig({ configPath: args.config });
  let repos = reposOf(cfg);
  if ("repo" in args) {
    const hit = repos.find((r) => r.id === args.repo);
    if (!hit) throw new Error(`unknown repo "${args.repo}" — valid ids: ${repos.map((r) => r.id).join(", ")}`);
    repos = [hit];
  }
  const { dirs, searched } = transcriptDirs(cfg, repos);

  const id = args._[0];
  let file = "";
  if (id) {
    file = dirs.map((d) => path.join(d, `${id}.jsonl`)).find((f) => fs.existsSync(f)) || "";
  } else {
    const files = dirs
      .flatMap((d) => jsonls(d).map((f) => path.join(d, f)))
      .map((full) => ({ full, m: fs.statSync(full).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    for (const { full } of files) {
      if (fs.readFileSync(full, "utf8").slice(0, 8000).includes("=== TICKET ===")) {
        file = full;
        break;
      }
    }
  }
  if (!file) throw new Error(`session transcript not found: ${id || "<auto>"} (searched ${searched.join(", ")})`);

  console.log(`following: ${path.basename(file)}  (Ctrl+C to stop — agent keeps running)`);
  console.log("────────────────────────────────────────────────────────");

  // Render the tail of what's already there, then stream appended lines.
  const initial = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  for (const l of initial.slice(-15)) render(l);

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
  fs.watch(file, { persistent: true }, drain);
  // Keep the process alive until Ctrl+C.
  await new Promise(() => {});
}
