// Derived filesystem paths the ops commands need. Kept out of config.js so the
// loader stays focused on parsing/resolving the profile itself.
import os from "node:os";
import path from "node:path";
import { primaryRepo } from "./repos.js";

// Claude Code keys a session transcript dir by its launch cwd, mangling every
// non-alphanumeric char to '-' (/home/me/repo -> -home-me-repo). The receiver
// launches `claude -p` with cwd = repoPath, so transcripts live under that mangle.
/** @param {string} p */
export const mangle = (p) => p.replace(/[^A-Za-z0-9]/g, "-");

/** Claude's transcript dir for the repo the agents work in. @param {string} repoPath */
export const claudeProjectDir = (repoPath) => path.join(os.homedir(), ".claude", "projects", mangle(repoPath));

/** The agent worktree base, resolved against the repo (default: the profile's default repo).
 * A per-repo worktreePrefix overrides the global one.
 * @param {import('./types.js').Config} cfg @param {import('./types.js').RepoConfig} [repo] */
export const worktreeDir = (cfg, repo = primaryRepo(cfg)) =>
  path.resolve(repo.path, repo.worktreePrefix || cfg.worktreePrefix || "../agenthook-worktrees");
