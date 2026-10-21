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

// Cursor's `agent` keys its project dir by the launch cwd too, but collapses every RUN of
// non-alphanumerics to one '-' and trims the ends (/home/me/.repo -> home-me-repo).
/** @param {string} p */
export const cursorMangle = (p) => p.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/** Claude's transcript dir for the repo the agents work in. @param {string} repoPath */
export const claudeProjectDir = (repoPath) => path.join(os.homedir(), ".claude", "projects", mangle(repoPath));

/** Where a sandboxed claude run in a cwd it doesn't own (a no-worktree step, cwd = the main
 * checkout) keeps its transcript: receiver-owned, under the state dir. Never the host's
 * `claudeProjectDir(repoPath)` — that dir holds the operator's own sessions and auto-memory.
 * @param {string} stateDir @param {string} cwd */
export const sandboxClaudeProjectDir = (stateDir, cwd) => path.join(stateDir, "sandbox-transcripts", mangle(cwd));

/** The agent worktree base, resolved against the repo (default: the profile's default repo).
 * A per-repo worktreePrefix overrides the global one. With neither set, the default is a
 * sibling dir named after the repo's own directory (`../<repo-dir>-worktrees`), so two
 * profiles (or two single-repo setups) sharing a parent directory never collide on ref.
 * @param {import('./types.js').Config} cfg @param {import('./types.js').RepoConfig} [repo] */
export const worktreeDir = (cfg, repo = primaryRepo(cfg)) =>
  path.resolve(repo.path, repo.worktreePrefix || cfg.worktreePrefix || `../${path.basename(path.resolve(repo.path))}-worktrees`);

/** The pre-fix worktree base (`../agenthook-worktrees`), for honoring a worktree already
 * created there for an in-flight ref. `null` when an explicit prefix is set (nothing legacy
 * to fall back to) or when it's identical to the new default (repo dir literally named
 * "agenthook").
 * @param {import('./types.js').Config} cfg @param {import('./types.js').RepoConfig} [repo] */
export const legacyWorktreeDir = (cfg, repo = primaryRepo(cfg)) => {
  if (repo.worktreePrefix || cfg.worktreePrefix) return null;
  const legacy = path.resolve(repo.path, "../agenthook-worktrees");
  return legacy === worktreeDir(cfg, repo) ? null : legacy;
};

/** The receiver's liveness control socket (named pipe on win32). @param {string} stateDir @param {string} name @param {string} [platform] */
export const controlSockPath = (stateDir, name, platform = process.platform) =>
  platform === "win32" ? `\\\\.\\pipe\\agenthook-${name}` : path.join(stateDir, "control.sock");
