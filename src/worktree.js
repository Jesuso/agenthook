// System-owned git worktrees. In pipeline mode the RECEIVER creates and destroys
// the worktree (not the agent), so every step of a task shares one deterministic
// path/branch and `drainWorktree` can reliably tear it down. The path is keyed by
// task ref alone, so the "code" step creates it and later steps ("review", "done")
// find the exact same one — no globbing.
//
// Multi-repo profiles (a `repos` block) nest it one level deeper, `<base>/<repo.id>/<ref>`,
// so sibling checkouts that resolve the default prefix to the same dir never collide.
// `repo` defaults to the profile's default repo — single-repo callers pass nothing.
//
// INVARIANT: one ref = one in-flight flow. Because this path AND store.running are
// keyed by ref, two concurrent jobs on the same ref would share this worktree and
// clobber each other's commits + crash-recovery entry. `agenthook run`'s entry guard
// (src/commands/run.js) enforces it: it refuses to inject a ref already mid-flow.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { worktreeDir } from "./paths.js";
import { primaryRepo } from "./repos.js";

// stderr piped (not inherited) so a probe that throws (e.g. no origin/HEAD) doesn't
// spam the receiver log — the message is still on the thrown error if a caller cares.
/** @param {string} repo @param {string[]} args */
const git = (repo, args) =>
  execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** @param {string} ref */
const safeRef = (ref) => String(ref).replace(/[^A-Za-z0-9_.-]/g, "_");

/** Deterministic worktree path for a task ref (shared across all its steps).
 * @param {import('./types.js').Config} cfg @param {string} ref @param {import('./types.js').RepoConfig} [repo] */
export function worktreePath(cfg, ref, repo = primaryRepo(cfg)) {
  const base = worktreeDir(cfg, repo);
  return cfg.multiRepo ? path.join(base, repo.id, safeRef(ref)) : path.join(base, safeRef(ref));
}

/** @param {string} ref */
export function branchName(ref) {
  return `agent/${safeRef(ref)}`;
}

/** repo's default branch (origin/HEAD), falling back to the current HEAD.
 * @param {string} repo */
function defaultBranch(repo) {
  try {
    return git(repo, ["rev-parse", "--abbrev-ref", "origin/HEAD"]).replace(/^origin\//, "");
  } catch {
    return git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
  }
}

/** @param {string} repo @param {string} branch */
function branchExists(repo, branch) {
  try {
    git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure a worktree exists for this task, creating the branch on first use.
 * Idempotent: a second call (e.g. the review step) returns the existing one.
 * @param {import('./types.js').Config} cfg @param {string} ref @param {import('./types.js').RepoConfig} [repo]
 * @returns {{ worktree: string, branch: string, created: boolean }}
 */
export function ensureWorktree(cfg, ref, repo = primaryRepo(cfg)) {
  const worktree = worktreePath(cfg, ref, repo);
  const branch = branchName(ref);
  if (fs.existsSync(worktree)) return { worktree, branch, created: false };
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  if (branchExists(repo.path, branch)) {
    git(repo.path, ["worktree", "add", worktree, branch]);
  } else {
    git(repo.path, ["worktree", "add", "-b", branch, worktree, defaultBranch(repo.path)]);
  }
  return { worktree, branch, created: true };
}

/** Remove the worktree (keeps the branch, which the PR still needs).
 * @param {import('./types.js').Config} cfg @param {string} ref @param {import('./types.js').RepoConfig} [repo]
 * @returns {boolean} removed */
export function drainWorktree(cfg, ref, repo = primaryRepo(cfg)) {
  const worktree = worktreePath(cfg, ref, repo);
  if (!fs.existsSync(worktree)) return false;
  git(repo.path, ["worktree", "remove", "--force", worktree]);
  return true;
}
