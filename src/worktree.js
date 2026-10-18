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

/** Prepended to every host git call against a repo a sandboxed agent can write: the agent
 * controls the branch's files, so a `core.hooksPath` pointing into them (husky's `.husky/_`)
 * would run agent-written hooks on the host at the next `git worktree add` (post-checkout). */
export const HOST_GIT_SAFE = /** @type {const} */ (["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"]);

/** The host git argv for `args` in `repo`: HOST_GIT_SAFE first when the profile has a sandbox. Pure.
 * @param {{sandbox?: unknown}} cfg @param {string} repo @param {string[]} args */
export const gitArgv = (cfg, repo, args) => [...(cfg.sandbox ? HOST_GIT_SAFE : []), "-C", repo, ...args];

/** Cap on one synchronous host git call. A sandboxed agent can write the common git dir, and a
 * FIFO at `.git/HEAD` or `.git/packed-refs` makes git block on open forever; under execFileSync
 * that would freeze the receiver's event loop. Past the cap git is killed and the call throws. */
export const HOST_GIT_TIMEOUT_MS = 60_000;

// stderr piped (not inherited) so a probe that throws (e.g. no origin/HEAD) doesn't
// spam the receiver log — the message is still on the thrown error if a caller cares.
/** @param {{sandbox?: unknown}} cfg @param {string} repo @param {string[]} args */
const git = (cfg, repo, args) =>
  execFileSync("git", gitArgv(cfg, repo, args), { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: HOST_GIT_TIMEOUT_MS, killSignal: "SIGKILL" }).trim();

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
 * `prunable` is set (true) only on a record git reports as prunable (its dir is gone).
 * @param {string} repoPath @returns {{ path: string, branch: string, prunable?: boolean }[]} */
export function listWorktrees(repoPath) {
  /** @type {{ path: string, branch: string, prunable?: boolean }[]} */
  const records = [];
  /** @type {{ path: string, branch: string, prunable?: boolean }} */
  let cur = { path: "", branch: "" };
  for (const line of git({}, repoPath, ["worktree", "list", "--porcelain"]).split("\n")) {
    if (line.startsWith("worktree ")) cur = { path: line.slice(9), branch: "" };
    else if (line.startsWith("branch ")) cur.branch = line.slice(7).replace("refs/heads/", "");
    else if (line === "prunable" || line.startsWith("prunable ")) cur.prunable = true;
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
 * @param {{sandbox?: unknown}} cfg @param {string} repo */
function defaultBranch(cfg, repo) {
  try {
    return git(cfg, repo, ["rev-parse", "--abbrev-ref", "origin/HEAD"]).replace(/^origin\//, "");
  } catch {
    return git(cfg, repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
  }
}

/** @param {{sandbox?: unknown}} cfg @param {string} repo @param {string} branch */
function branchExists(cfg, repo, branch) {
  try {
    git(cfg, repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
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
 * @param {{sandbox?: unknown}} cfg @param {string} repo @returns {Promise<{ ref: string, sha: string }>}
 */
async function resolveBase(cfg, repo) {
  const name = defaultBranch(cfg, repo);
  let ref = name;
  let hasOrigin = true;
  try {
    git(cfg, repo, ["remote", "get-url", "origin"]);
  } catch {
    hasOrigin = false;
  }
  if (hasOrigin) {
    try {
      await execFileP("git", gitArgv(cfg, repo, ["fetch", "--quiet", "origin", name]), {
        timeout: 10_000,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      });
      git(cfg, repo, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${name}`]);
      ref = `origin/${name}`;
    } catch (e) {
      const msg = String(e.stderr || e.message || e).trim().split("\n")[0];
      console.warn(`[worktree] fetch origin ${name} failed: ${msg}; basing on local ${name}`);
    }
  }
  return { ref, sha: git(cfg, repo, ["rev-parse", "--short", ref]) };
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
  if (branchExists(cfg, repo.path, branch)) {
    git(cfg, repo.path, ["worktree", "add", worktree, branch]);
    return { worktree, branch, created: true };
  }
  const base = await resolveBase(cfg, repo.path);
  // --no-track: a plain `git push` from the agent must not target origin/<default>.
  git(cfg, repo.path, ["worktree", "add", "--no-track", "-b", branch, worktree, base.ref]);
  return { worktree, branch, created: true, base };
}

/** Remove the worktree (keeps the branch, which the PR still needs).
 * @param {import('./types.js').Config} cfg @param {string} ref @param {import('./types.js').RepoConfig} [repo]
 * @returns {boolean} removed */
export function drainWorktree(cfg, ref, repo = primaryRepo(cfg)) {
  const worktree = worktreePath(cfg, ref, repo);
  if (!fs.existsSync(worktree)) return false;
  git(cfg, repo.path, ["worktree", "remove", "--force", worktree]);
  return true;
}
