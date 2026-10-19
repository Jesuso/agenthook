// What a sandboxed run gets, decided here (dispatch) and not in src/sandbox/ (which only runs
// it): the mounts, the env split between the container and the runtime client, and the git
// config that lets the container commit and push with no ~/.gitconfig, SSH agent or helper.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { HOST_GIT_SAFE } from "../worktree.js";
import { FORGE_EGRESS_HOSTS } from "../forges/index.js";

/** Read a small agent-writable metadata file without trusting its type: a FIFO would block the
 * event loop on open, a symlink would point the host elsewhere, a huge file would be slurped.
 * @param {string} file @returns {string|undefined}  undefined unless a regular file ≤ 4 KiB */
function readSmallFile(file) {
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.size > 4096) return undefined;
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

/** True when `p` exists and is a real directory (not a symlink to one). @param {string} p */
function isRealDir(p) {
  try {
    return fs.lstatSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The git dirs a sandboxed run mounts, derived from the TRUSTED side only. `commonDir` (the
 * shared objects/refs/config) is always the main checkout's own `<repo>/.git`, which no
 * sandboxed run can write: a mount source must never come from a file a container could have
 * edited, or run N's agent would pick what run N+1 bind-mounts (e.g. `gitdir: /home/<op>`).
 * For a worktree `cwd`, its agent-writable `.git` file and the admin dir's `commondir` are
 * then only CHECKED: `.git` must be a regular file naming a direct child of
 * `<common>/worktrees/`, whose `commondir` resolves back to the same common dir. Any mismatch
 * throws — the run is refused, never mounted elsewhere.
 * @param {string} repoPath  the main checkout @param {string} cwd  the run's cwd (a worktree or `repoPath`)
 * @returns {{gitDir: string, commonDir: string}}
 */
export function trustedGitDirs(repoPath, cwd) {
  const commonDir = path.join(repoPath, ".git");
  if (!isRealDir(commonDir)) throw new Error(`${commonDir} is not a directory — a sandboxed run needs repoPath to be a plain git checkout`);
  if (path.resolve(cwd) === path.resolve(repoPath)) return { gitDir: commonDir, commonDir };
  const bad = new Error(`worktree git metadata does not point into ${commonDir}`);
  const realCommon = fs.realpathSync(commonDir);
  const worktrees = path.join(commonDir, "worktrees");
  if (!isRealDir(worktrees)) throw bad;
  const m = /^gitdir:\s*(.+)$/m.exec(readSmallFile(path.join(cwd, ".git")) ?? "");
  if (!m) throw bad;
  const gitDir = path.resolve(cwd, m[1].trim());
  if (!isRealDir(gitDir) || path.dirname(fs.realpathSync(gitDir)) !== path.join(realCommon, "worktrees")) throw bad;
  const common = readSmallFile(path.join(gitDir, "commondir"))?.trim();
  if (!common) throw bad;
  const named = path.resolve(gitDir, common);
  if (!isRealDir(named) || fs.realpathSync(named) !== realCommon) throw bad;
  return { gitDir, commonDir };
}

/**
 * The bind mounts of a sandboxed run, in order. A worktree step gets its worktree and the
 * repo's common git dir read-write (committing writes objects, refs and the worktree's admin
 * dir), with `<common>/config` and `<common>/hooks` overlaid read-only: the host's own git runs
 * against that dir, so an agent-written `core.fsmonitor`/`core.sshCommand`/alias/filter or hook
 * would hand code execution back to the host. `hooks` is created (empty) first when missing, so
 * the agent can't create it. A no-worktree step (triage) gets the main checkout and its git dir
 * read-only. Then the per-run verdict dir (rw) and the agent's own mounts. Creates `hooks`;
 * throws when `config`/`hooks` is not a regular file/real dir (e.g. a planted symlink).
 * @param {{cwd: string, hasWorktree: boolean, verdictDir: string, gitCommonDir?: string, agentMounts?: import('../types.js').SandboxMount[]}} o
 * @returns {import('../types.js').SandboxMount[]}
 */
export function sandboxMounts({ cwd, hasWorktree, verdictDir, gitCommonDir, agentMounts = [] }) {
  /** @type {import('../types.js').SandboxMount[]} */
  const mounts = [{ path: cwd, ro: !hasWorktree }];
  if (gitCommonDir) {
    mounts.push({ path: gitCommonDir, ro: !hasWorktree });
    if (hasWorktree) {
      // Both overlays must be what they claim: a symlink planted by an earlier run would make
      // the runtime bind its target instead.
      const config = path.join(gitCommonDir, "config");
      if (fs.existsSync(config) || isSymlink(config)) {
        if (!fs.lstatSync(config).isFile()) throw new Error(`${config} is not a regular file`);
        mounts.push({ path: config, ro: true });
      }
      const hooks = path.join(gitCommonDir, "hooks");
      if (!isSymlink(hooks)) fs.mkdirSync(hooks, { recursive: true });
      if (!isRealDir(hooks)) throw new Error(`${hooks} is not a directory`);
      mounts.push({ path: hooks, ro: true });
    }
  }
  mounts.push({ path: verdictDir }, ...agentMounts);
  return mounts;
}

/** @param {string} p */
function isSymlink(p) {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

const HOST_ONLY = new Set(["PATH", "HOME", "USER", "LOGNAME", "SHELL", "PWD", "OLDPWD", "TMPDIR", "SSH_AUTH_SOCK", "DISPLAY", "WAYLAND_DISPLAY", "NODE_OPTIONS"]);
const HOST_ONLY_PREFIXES = ["TERM", "XDG_", "DBUS_", "DOCKER_", "CONTAINER_", "CONTAINERS_", "PODMAN_", "npm_"];

/** The env a container gets: the run's env minus host-only keys (paths, sockets, the session,
 * the runtime's own config). Pure. @param {Record<string, string|undefined>} env @returns {Record<string, string>} */
export function containerEnv(env) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || HOST_ONLY.has(k) || HOST_ONLY_PREFIXES.some((p) => k.startsWith(p))) continue;
    out[k] = v;
  }
  return out;
}

const RUNTIME_KEYS = new Set(["PATH", "HOME", "USER", "XDG_RUNTIME_DIR"]);
const RUNTIME_PREFIXES = ["DOCKER_", "CONTAINER_", "CONTAINERS_"];

/** The env the runtime CLIENT needs from the receiver's own env to find and reach its daemon
 * (rootless podman needs XDG_RUNTIME_DIR). Pure. @param {Record<string, string|undefined>} env @returns {Record<string, string>} */
export function runtimeEnv(env) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined && (RUNTIME_KEYS.has(k) || RUNTIME_PREFIXES.some((p) => k.startsWith(p)))) out[k] = v;
  }
  return out;
}

/** The host of a git remote or base URL (`git@h:o/r`, `ssh://git@h:22/o/r`, `https://h/o/r`). Pure.
 * @param {string|undefined} url @returns {string|undefined} */
export function hostOf(url) {
  if (!url) return undefined;
  const scp = /^[^@/\s]+@([^:/\s]+):/.exec(url);
  if (scp) return scp[1];
  try {
    return new URL(url).hostname || undefined;
  } catch {
    return undefined;
  }
}

/** The git host and forge kind a run talks to: the configured forge's, else inferred from the
 * origin (`github.com` → github, a `gitlab` host → gitlab). Pure.
 * @param {{originUrl?: string, forgeType?: string, forgeBaseUrl?: string}} o
 * @returns {{host?: string, kind?: string}} */
export function forgeOf({ originUrl, forgeType, forgeBaseUrl }) {
  const host = forgeType === "github" ? "github.com" : hostOf(forgeBaseUrl) ?? hostOf(originUrl);
  const kind = forgeType ?? (host === "github.com" ? "github" : host && /gitlab/.test(host) ? "gitlab" : undefined);
  return { host, kind };
}

/** The forge egress hosts for a profile with no `forge` block, inferred from the origin like
 * gitSandboxEnv's credential helper: the prompts still run `gh pr …` against a github origin,
 * so `api.github.com` must be reachable. [] for an origin with no known forge. Pure.
 * @param {string|undefined} originUrl @returns {string[]} */
export function inferredForgeEgressHosts(originUrl) {
  const { host, kind } = forgeOf({ originUrl });
  if (!host || !kind) return [];
  return FORGE_EGRESS_HOSTS[kind]?.({ type: kind, ...(kind === "github" ? {} : { baseUrl: `https://${host}` }) }) ?? [];
}

/**
 * Git config for a container with no ~/.gitconfig, as GIT_CONFIG_COUNT/KEY_n/VALUE_n env (names
 * only reach argv): an SSH `origin` rewritten to HTTPS, a credential helper from the forge's
 * token in the env (github: `gh auth git-credential` over GH_TOKEN/GITHUB_TOKEN; gitlab:
 * GITLAB_TOKEN), `safe.directory=*`, and the host's commit identity. Pure.
 * @param {{originUrl?: string, forgeType?: string, forgeBaseUrl?: string, author?: {name?: string, email?: string}}} o
 * @returns {Record<string, string>}
 */
export function gitSandboxEnv({ originUrl, forgeType, forgeBaseUrl, author }) {
  const { host, kind } = forgeOf({ originUrl, forgeType, forgeBaseUrl });
  /** @type {[string, string][]} */
  const pairs = [];
  if (host) {
    pairs.push([`url.https://${host}/.insteadOf`, `git@${host}:`], [`url.https://${host}/.insteadOf`, `ssh://git@${host}/`]);
    if (kind === "github") pairs.push([`credential.https://${host}.helper`, "!gh auth git-credential"]);
    else if (kind === "gitlab") pairs.push([`credential.https://${host}.helper`, `!f() { test "$1" = get && echo username=oauth2 && echo "password=$GITLAB_TOKEN"; }; f`]);
  }
  pairs.push(["safe.directory", "*"]);
  /** @type {Record<string, string>} */
  const env = { GIT_CONFIG_COUNT: String(pairs.length) };
  pairs.forEach(([k, v], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = k;
    env[`GIT_CONFIG_VALUE_${i}`] = v;
  });
  if (author?.name) env.GIT_AUTHOR_NAME = env.GIT_COMMITTER_NAME = author.name;
  if (author?.email) env.GIT_AUTHOR_EMAIL = env.GIT_COMMITTER_EMAIL = author.email;
  return env;
}

/** Cap on one host git read at run start: a FIFO the agent planted in the common git dir must
 * fail the read, not hang the receiver (see HOST_GIT_TIMEOUT_MS). */
export const HOST_GIT_READ_TIMEOUT_MS = 10_000;

/** One host git read against a repo a sandbox can write (hardened and time-capped; "" when unset,
 * failing or timed out).
 * @param {string} repo @param {string[]} args @param {number} timeoutMs */
function hostGit(repo, args, timeoutMs) {
  try {
    return execFileSync("git", [...HOST_GIT_SAFE, "-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: timeoutMs, killSignal: "SIGKILL" }).trim();
  } catch {
    return "";
  }
}

/** The host side of `gitSandboxEnv`: the repo's origin URL and commit identity, read once per run.
 * @param {string} repo @param {{timeoutMs?: number}} [o]
 * @returns {{originUrl?: string, author: {name?: string, email?: string}}} */
export function hostGitFacts(repo, { timeoutMs = HOST_GIT_READ_TIMEOUT_MS } = {}) {
  return {
    originUrl: hostGit(repo, ["remote", "get-url", "origin"], timeoutMs) || undefined,
    author: { name: hostGit(repo, ["config", "user.name"], timeoutMs) || undefined, email: hostGit(repo, ["config", "user.email"], timeoutMs) || undefined },
  };
}
