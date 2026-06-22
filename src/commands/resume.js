// `agenthook resume [ref [session]] [--exec] [--limit N]` — open the headless agent
// session for a task ref interactively. Unlike `follow` (read-only tail), this hands
// you the exact `claude --resume` invocation (or runs it) so you can continue an
// agent in its own worktree. Receiver-spawned (`-p`/sdk-cli) sessions don't show in
// Claude's own `claude -r` picker, and their transcripts live under the worktree
// mangle — so finding the dir + session id by hand means hunting the filesystem.
//
// A ref usually has SEVERAL sessions (one per pipeline step run: code, review, …),
// so `resume <ref>` lists them with their step and you pick which to resume:
//
//   agenthook resume                       last N agent runs (default 10), one per ref
//   agenthook resume <ref>                  list that ref's sessions + their step
//   agenthook resume <ref> <id|prefix|n>    print `cd <worktree> && claude -r <id>`
//   agenthook resume <ref> <sel> --exec     run it now (interactive; inherits terminal)
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { loadConfig } from "../config.js";
import { worktreePath } from "../worktree.js";
import { sessionDir, listSessions, recentRuns } from "../sessions.js";
import { ago } from "./ls.js";

/** @param {string|number} s @param {number} n */
const pad = (s, n) => String(s).padEnd(n);
/** @param {string} s @param {number} n */
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
/** @param {number} ms */
const iso = (ms) => new Date(ms).toISOString();

/** Count `.jsonl` transcripts under a dir (0 if it doesn't exist). @param {string} dir */
const sessionCount = (dir) => {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).length;
  } catch {
    return 0;
  }
};

/** Pick a session by exact id, unique prefix, or 1-based list index.
 * @param {{id:string, step:string}[]} sessions @param {string} sel */
function select(sessions, sel) {
  const exact = sessions.find((s) => s.id === sel);
  if (exact) return exact;
  const pref = sessions.filter((s) => s.id.startsWith(sel));
  if (pref.length === 1) return pref[0];
  if (pref.length > 1) throw new Error(`ambiguous session "${sel}" — ${pref.length} match; use more chars`);
  if (/^\d+$/.test(sel)) {
    const i = Number(sel) - 1;
    if (i >= 0 && i < sessions.length) return sessions[i];
  }
  return null;
}

/** @param {any} args */
export async function resume(args) {
  const cfg = loadConfig({ configPath: args.config });
  const ref = args._[0];
  const sel = args._[1];

  // No ref → recent runs across all refs (one row per ref).
  if (!ref) {
    const runs = recentRuns(cfg, args.limit ? Number(args.limit) : 10);
    if (!runs.length) {
      console.log("no agent runs recorded yet (no per-run logs under the profile's logDir).");
      return;
    }
    console.log(`${pad("REF", 22)}${pad("LAST STEP", 12)}${pad("LAST RUN", 12)}${pad("WT", 10)}SESSIONS`);
    for (const r of runs) {
      const present = fs.existsSync(worktreePath(cfg, r.ref));
      console.log(
        `${pad(r.ref, 22)}${pad(r.step, 12)}${pad(ago(iso(r.at)), 12)}` +
          `${pad(present ? "present" : "drained", 10)}${sessionCount(sessionDir(cfg, r.ref))}`,
      );
    }
    console.log(`\nlist a ref's sessions:  agenthook resume <ref>`);
    return;
  }

  const sessions = listSessions(cfg, ref);
  if (!sessions.length) throw new Error(`no recorded agent session for ref ${ref} (looked in ${sessionDir(cfg, ref)})`);
  const wt = worktreePath(cfg, ref);
  const present = fs.existsSync(wt);

  // ref only → list the ref's sessions and how to resume each.
  if (!sel) {
    console.log(`sessions for ref ${ref}  (worktree: ${present ? wt : "drained — recreate before resuming"})\n`);
    console.log(`${pad("#", 3)}${pad("STEP", 10)}${pad("AGE", 10)}${pad("MSGS", 6)}${pad("SESSION", 38)}FIRST PROMPT`);
    sessions.forEach((s, i) => {
      console.log(
        `${pad(i + 1, 3)}${pad(s.step, 10)}${pad(ago(iso(s.at)), 10)}${pad(s.msgs, 6)}${pad(s.id, 38)}${clip(s.prompt, 50)}`,
      );
    });
    console.log(`\nresume one:  agenthook resume ${ref} <#|session-id> [--exec]`);
    return;
  }

  // ref + selection → resolve to one session, print or run its resume command.
  const chosen = select(sessions, sel);
  if (!chosen) throw new Error(`no session "${sel}" for ref ${ref}. Run \`agenthook resume ${ref}\` to list them.`);

  if (args.exec) {
    if (!present)
      throw new Error(
        `worktree for ${ref} is drained (${wt}). Recreate it (re-run the step, or \`git worktree add\`) before resuming — claude resolves the session by cwd.`,
      );
    const r = spawnSync(cfg.claudeBin, ["-r", chosen.id], { cwd: wt, stdio: "inherit" });
    if (r.error) throw r.error;
    process.exitCode = r.status ?? 0;
    return;
  }

  console.log(`cd ${wt} && ${cfg.claudeBin} -r ${chosen.id}   # ${chosen.step}`);
  if (!present)
    console.log(`\n⚠ worktree is drained — recreate ${wt} before this works (claude resolves the session by cwd).`);
}
