// Resolve config values for the bash ops scripts so they stay provider-blind.
// The shell never parses config.json itself — it asks here and gets absolute,
// expanded paths plus a few derived values the scripts need.
//
//   node scripts/_config.mjs repoPath      -> the repo agents work in (absolute)
//   node scripts/_config.mjs worktreeDir   -> worktreePrefix resolved against repoPath
//   node scripts/_config.mjs projectDir    -> Claude's transcript dir for that repo
//   node scripts/_config.mjs <anyCfgKey>   -> that resolved config field
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.js";

const cfg = loadConfig();
const key = process.argv[2] || "";

// Claude Code keys a session's transcript dir by its launch cwd, mangling every
// non-alphanumeric char to '-' (so /home/me/repo -> -home-me-repo). The receiver
// launches `claude -p` with cwd = repoPath, so transcripts live under that mangle.
/** @param {string} p */
const mangle = (p) => p.replace(/[^A-Za-z0-9]/g, "-");

/** @type {Record<string, string>} */
const derived = {
  worktreeDir: path.resolve(cfg.repoPath, cfg.worktreePrefix || "../agenthook-worktrees"),
  projectDir: path.join(os.homedir(), ".claude", "projects", mangle(cfg.repoPath)),
};

const value = key in derived ? derived[key] : /** @type {any} */ (cfg)[key];
process.stdout.write(value == null ? "" : String(value));
