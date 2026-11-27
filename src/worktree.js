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
// The base itself (`worktreeDir`) defaults to a sibling dir named after the repo's own
// directory (`../<repo-dir>-worktrees`), so two profiles sharing a parent dir don't collide
// either. An in-flight ref already checked out under the old shared `../agenthook-worktrees`
// base keeps resolving there (`legacyWorktreeDir`); only new refs move to the new base.
//
// INVARIANT: one ref = one in-flight flow. Because this path AND store.running are
// keyed by ref, two concurrent jobs on the same ref would share this worktree and
// clobber each other's commits + crash-recovery entry. `agenthook run`'s entry guard
// (`entryBlock`, src/pipeline.js) enforces it: it refuses to inject a ref already mid-flow.
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { worktreeDir, legacyWorktreeDir } from "./paths.js";
import { primaryRepo } from "./repos.js";

/** Prepended to every host git call against a repo a sandboxed agent can write: the agent
 * controls the branch's files, so a `core.hooksPath` pointing into them (husky's `.husky/_`)
 * would run agent-written hooks on the host at the next `git worktree add` (post-checkout). */
export const HOST_GIT_SAFE = /** @type {const} */ (["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"]);

/** Whether hub-side git calls against this profile must be HOST_GIT_SAFE-hardened: a sandboxed
 * step can write the common git dir (husky's `.husky/_`), and a remote harness's worker is an
 * untrusted git peer (#690) — either way a hub `git worktree add`/push/fetch must never run a
 * hook or an fsmonitor hook the other side planted. Pure.
 * @param {{sandbox?: unknown, harnesses?: Record<string, {remote?: unknown}|undefined>}} cfg */
export function hostGitSafe(cfg) {
  return !!cfg.sandbox || Object.values(cfg.harnesses ?? {}).some((h) => h?.remote);
}

/** The host git argv for `args` in `repo`: HOST_GIT_SAFE first when `hostGitSafe(cfg)`. Pure.
 * @param {{sandbox?: unknown, harnesses?: Record<string, {remote?: unknown}|undefined>}} cfg @param {string} repo @param {string[]} args */
export const gitArgv = (cfg, repo, args) => [...(hostGitSafe(cfg) ? HOST_GIT_SAFE : []), "-C", repo, ...args];

/** Cap on one synchronous host git call. A sandboxed agent can write the common git dir, and a
 * FIFO at `.git/HEAD` or `.git/packed-refs` makes git block on open forever; under execFileSync
 * that would freeze the receiver's event loop. Past the cap git is killed and the call throws. */
export const HOST_GIT_TIMEOUT_MS = 60_000;

// stderr piped (not inherited) so a probe that throws (e.g. no origin/HEAD) doesn't
// spam the receiver log — the message is still on the thrown error if a caller cares.
/** @param {{sandbox?: unknown, harnesses?: Record<string, {remote?: unknown}|undefined>}} cfg @param {string} repo @param {string[]} args */
const git = (cfg, repo, args) =>
  execFileSync("git", gitArgv(cfg, repo, args), { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: HOST_GIT_TIMEOUT_MS, killSignal: "SIGKILL" }).trim();

const execFileP = promisify(execFile);

/** @param {string} ref */
const safeRef = (ref) => String(ref).replace(/[^A-Za-z0-9_.-]/g, "_");

/** Deterministic worktree path for a task ref (shared across all its steps). An in-flight ref
 * already checked out under the legacy `../agenthook-worktrees` base keeps resolving there
 * (new refs always go to the new base) — see `legacyWorktreeDir`.
 * @param {import('./types/index.js').Config} cfg @param {string} ref @param {import('./types/index.js').RepoConfig} [repo] */
export function worktreePath(cfg, ref, repo = primaryRepo(cfg)) {
  const base = worktreeDir(cfg, repo);
  /** @param {string} b */
  const sub = (b) => (cfg.multiRepo ? path.join(b, repo.id, safeRef(ref)) : path.join(b, safeRef(ref)));
  const legacy = legacyWorktreeDir(cfg, repo);
  if (legacy) {
    const legacyPath = sub(legacy);
    if (fs.existsSync(legacyPath)) return legacyPath;
  }
  return sub(base);
}

/** Every worktree git knows for a repo (`git worktree list --porcelain`), main checkout
 * included. Callers filter to agent worktrees by path prefix. Throws if git fails.
 * `prunable` is set (true) only on a record git reports as prunable (its dir is gone).
 * @param {{sandbox?: unknown, harnesses?: Record<string, {remote?: unknown}|undefined>}} cfg @param {string} repoPath @returns {{ path: string, branch: string, prunable?: boolean }[]} */
export function listWorktrees(cfg, repoPath) {
  /** @type {{ path: string, branch: string, prunable?: boolean }[]} */
  const records = [];
  /** @type {{ path: string, branch: string, prunable?: boolean }} */
  let cur = { path: "", branch: "" };
  for (const line of git(cfg, repoPath, ["worktree", "list", "--porcelain"]).split("\n")) {
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

/** The default branch prefix, overridden per-profile by `cfg.branchPrefix` — two profiles on
 * the same repo need distinct ones or `ensureWorktree` reuses the other's branch. */
export const DEFAULT_BRANCH_PREFIX = "agent/";

/** @param {string} ref @param {string} [prefix] */
export function branchName(ref, prefix = DEFAULT_BRANCH_PREFIX) {
  return `${prefix}${safeRef(ref)}`;
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

/** The hub-side merge base for a REMOTE (ssh) run's review diff (#826): the worker's clone
 * is fresh (no origin default ref), so the hub computes `merge-base origin/<default> HEAD`
 * in its own worktree and embeds the sha in the prompt. The default branch NAME is resolved
 * from the repo's main checkout (`repo.path`), never from the worktree's HEAD — the worktree
 * sits on the agent branch, and naming that would make the "diff" empty. Falls back to the
 * local default branch when `origin/<default>` isn't resolvable (the caller can see it: `ref`
 * then lacks the `origin/` prefix); null when nothing names a default (e.g. a detached main
 * checkout) — a caller must never diff against an unknown base.
 * @param {{sandbox?: unknown, harnesses?: Record<string, {remote?: unknown} | undefined>}} cfg @param {{path: string}} repo @param {string} worktree @returns {{sha: string, ref: string} | null} */
export function remoteMergeBase(cfg, repo, worktree) {
  const name = defaultBranch(cfg, repo.path);
  if (name === "HEAD") return null; // the main checkout is detached — no default to name
  /** @param {string[]} args */
  const tryGit = (args) => {
    try {
      return git(cfg, worktree, args);
    } catch {
      return null;
    }
  };
  const sha = tryGit(["merge-base", `origin/${name}`, "HEAD"]);
  if (sha) return { sha, ref: `origin/${name}` };
  const local = tryGit(["merge-base", name, "HEAD"]);
  return local ? { sha: local, ref: name } : null;
}

/**
 * Ensure a worktree exists for this task, creating the branch on first use.
 * Idempotent: a second call (e.g. the review step) returns the existing one.
 * `base` is set only when a new branch was created.
 * @param {import('./types/index.js').Config} cfg @param {string} ref @param {import('./types/index.js').RepoConfig} [repo]
 * @returns {Promise<{ worktree: string, branch: string, created: boolean, base?: { ref: string, sha: string } }>}
 */
export async function ensureWorktree(cfg, ref, repo = primaryRepo(cfg)) {
  const worktree = worktreePath(cfg, ref, repo);
  const branch = branchName(ref, cfg.branchPrefix);
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
 * @param {import('./types/index.js').Config} cfg @param {string} ref @param {import('./types/index.js').RepoConfig} [repo]
 * @returns {boolean} removed */
export function drainWorktree(cfg, ref, repo = primaryRepo(cfg)) {
  const worktree = worktreePath(cfg, ref, repo);
  if (!fs.existsSync(worktree)) return false;
  git(cfg, repo.path, ["worktree", "remove", "--force", worktree]);
  return true;
}

/** The branch's current HEAD sha in `dir`, or null on any git error (fail closed — a
 * caller deducing a verdict from "commits since" must never deduce from an unknown start point).
 * @param {{sandbox?: unknown}} cfg @param {string} dir */
export function branchHead(cfg, dir) {
  try {
    return git(cfg, dir, ["rev-parse", "HEAD"]);
  } catch {
    return null;
  }
}

/** How many commits `dir`'s current HEAD has past `sha` (`git rev-list --count sha..HEAD`); 0 on
 * any git error — fail closed, same reasoning as `branchHead`.
 * @param {{sandbox?: unknown}} cfg @param {string} dir @param {string} sha */
export function commitsSince(cfg, dir, sha) {
  try {
    return Number(git(cfg, dir, ["rev-list", "--count", `${sha}..HEAD`])) || 0;
  } catch {
    return 0;
  }
}
