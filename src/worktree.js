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
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { worktreeDir } from "./paths.js";
import { primaryRepo } from "./repos.js";

// stderr piped (not inherited) so a probe that throws (e.g. no origin/HEAD) doesn't
// spam the receiver log — the message is still on the thrown error if a caller cares.
/** @param {string} repo @param {string[]} args */
const git = (repo, args) =>
  execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const execFileP = promisify(execFile);

/** @param {string} ref */
const safeRef = (ref) => String(ref).replace(/[^A-Za-z0-9_.-]/g, "_");

/** Deterministic worktree path for a task ref (shared across all its steps).
 * @param {import('./types.js').Config} cfg @param {string} ref @param {import('./types.js').RepoConfig} [repo] */
export function worktreePath(cfg, ref, repo = primaryRepo(cfg)) {
  const base = worktreeDir(cfg, repo);
  return cfg.multiRepo ? path.join(base, repo.id, safeRef(ref)) : path.join(base, safeRef(ref));
}

/** Every worktree git knows for a repo (`git worktree list --porcelain`), main checkout
 * included. Callers filter to agent worktrees by path prefix. Throws if git fails.
 * @param {string} repoPath @returns {{ path: string, branch: string }[]} */
export function listWorktrees(repoPath) {
  /** @type {{ path: string, branch: string }[]} */
  const records = [];
  let cur = { path: "", branch: "" };
  for (const line of git(repoPath, ["worktree", "list", "--porcelain"]).split("\n")) {
    if (line.startsWith("worktree ")) cur = { path: line.slice(9), branch: "" };
    else if (line.startsWith("branch ")) cur.branch = line.slice(7).replace("refs/heads/", "");
    else if (line === "") {
      if (cur.path) records.push(cur);
      cur = { path: "", branch: "" };
    }
  }
  if (cur.path) records.push(cur);
  return records;
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
 * Pick the start point for a new agent branch: a freshly fetched `origin/<default>` when
 * possible, else the local default branch. The fetch is async (never block the event loop /
 * webhook ACKs), best-effort, and touches only `refs/remotes/origin/<name>` — never the
 * checkout's branches, index or working tree.
 * @param {string} repo @returns {Promise<{ ref: string, sha: string }>}
 */
async function resolveBase(repo) {
  const name = defaultBranch(repo);
  let ref = name;
  let hasOrigin = true;
  try {
    git(repo, ["remote", "get-url", "origin"]);
  } catch {
    hasOrigin = false;
  }
  if (hasOrigin) {
    try {
      await execFileP("git", ["-C", repo, "fetch", "--quiet", "origin", name], {
        timeout: 10_000,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      });
      git(repo, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${name}`]);
      ref = `origin/${name}`;
    } catch (e) {
      const msg = String(e.stderr || e.message || e).trim().split("\n")[0];
      console.warn(`[worktree] fetch origin ${name} failed: ${msg}; basing on local ${name}`);
    }
  }
  return { ref, sha: git(repo, ["rev-parse", "--short", ref]) };
}

/**
 * Ensure a worktree exists for this task, creating the branch on first use.
 * Idempotent: a second call (e.g. the review step) returns the existing one.
 * `base` is set only when a new branch was created.
 * @param {import('./types.js').Config} cfg @param {string} ref @param {import('./types.js').RepoConfig} [repo]
 * @returns {Promise<{ worktree: string, branch: string, created: boolean, base?: { ref: string, sha: string } }>}
 */
export async function ensureWorktree(cfg, ref, repo = primaryRepo(cfg)) {
  const worktree = worktreePath(cfg, ref, repo);
  const branch = branchName(ref);
  if (fs.existsSync(worktree)) return { worktree, branch, created: false };
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  if (branchExists(repo.path, branch)) {
    git(repo.path, ["worktree", "add", worktree, branch]);
    return { worktree, branch, created: true };
  }
  const base = await resolveBase(repo.path);
  // --no-track: a plain `git push` from the agent must not target origin/<default>.
  git(repo.path, ["worktree", "add", "--no-track", "-b", branch, worktree, base.ref]);
  return { worktree, branch, created: true, base };
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
