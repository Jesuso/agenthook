// Derived filesystem paths the ops commands need. Kept out of config.js so the
// loader stays focused on parsing/resolving the profile itself.
import os from "node:os";
import path from "node:path";

// Claude Code keys a session transcript dir by its launch cwd, mangling every
// non-alphanumeric char to '-' (/home/me/repo -> -home-me-repo). The receiver
// launches `claude -p` with cwd = repoPath, so transcripts live under that mangle.
/** @param {string} p */
export const mangle = (p) => p.replace(/[^A-Za-z0-9]/g, "-");

/** Claude's transcript dir for the repo the agents work in. @param {string} repoPath */
export const claudeProjectDir = (repoPath) => path.join(os.homedir(), ".claude", "projects", mangle(repoPath));

/** The agent worktree base, resolved against the repo. @param {import('./types.js').Config} cfg */
export const worktreeDir = (cfg) => path.resolve(cfg.repoPath, cfg.worktreePrefix || "../agenthook-worktrees");
