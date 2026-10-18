// What a sandboxed run gets, decided here (dispatch) and not in src/sandbox/ (which only runs
// it): the mounts, the env split between the container and the runtime client, and the git
// config that lets the container commit and push with no ~/.gitconfig, SSH agent or helper.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { HOST_GIT_SAFE } from "../worktree.js";

/**
 * A checkout's git dirs: `gitDir` (a worktree's admin dir `<common>/worktrees/<id>`, or the
 * main checkout's `.git`) and `commonDir` (the shared objects/refs/config). `<dir>/.git` is a
 * FILE in a `git worktree add` checkout (`gitdir: <admin>`), whose admin dir names the common
 * dir in `commondir`. Undefined when `dir` is not a git checkout.
 * @param {string} dir @param {(file: string) => string} [readFile]  throws EISDIR on a dir
 * @returns {{gitDir: string, commonDir: string}|undefined}
 */
export function gitDirsFor(dir, readFile = (f) => fs.readFileSync(f, "utf8")) {
  const dotGit = path.join(dir, ".git");
  let text;
  try {
    text = readFile(dotGit);
  } catch (e) {
    return e.code === "EISDIR" ? { gitDir: dotGit, commonDir: dotGit } : undefined;
  }
  const m = /^gitdir:\s*(.+)$/m.exec(text);
  if (!m) return undefined;
  const gitDir = path.resolve(dir, m[1].trim());
  let common;
  try {
    common = readFile(path.join(gitDir, "commondir")).trim();
  } catch {
    return { gitDir, commonDir: gitDir };
  }
  return { gitDir, commonDir: path.resolve(gitDir, common) };
}

/**
 * The bind mounts of a sandboxed run, in order. A worktree step gets its worktree and the
 * repo's common git dir read-write (committing writes objects, refs and the worktree's admin
 * dir), with `<common>/config` and `<common>/hooks` overlaid read-only: the host's own git runs
 * against that dir, so an agent-written `core.fsmonitor`/`core.sshCommand`/alias/filter or hook
 * would hand code execution back to the host. `hooks` is created (empty) first when missing, so
 * the agent can't create it. A no-worktree step (triage) gets the main checkout and its git dir
 * read-only. Then the per-run verdict dir (rw) and the agent's own mounts. Creates `hooks`.
 * @param {{cwd: string, hasWorktree: boolean, verdictDir: string, gitCommonDir?: string, agentMounts?: import('../types.js').SandboxMount[]}} o
 * @returns {import('../types.js').SandboxMount[]}
 */
export function sandboxMounts({ cwd, hasWorktree, verdictDir, gitCommonDir, agentMounts = [] }) {
  /** @type {import('../types.js').SandboxMount[]} */
  const mounts = [{ path: cwd, ro: !hasWorktree }];
  if (gitCommonDir) {
    mounts.push({ path: gitCommonDir, ro: !hasWorktree });
    if (hasWorktree) {
      const config = path.join(gitCommonDir, "config");
      if (fs.existsSync(config)) mounts.push({ path: config, ro: true });
      const hooks = path.join(gitCommonDir, "hooks");
      fs.mkdirSync(hooks, { recursive: true });
      mounts.push({ path: hooks, ro: true });
    }
  }
  mounts.push({ path: verdictDir }, ...agentMounts);
  return mounts;
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

/**
 * Git config for a container with no ~/.gitconfig, as GIT_CONFIG_COUNT/KEY_n/VALUE_n env (names
 * only reach argv): an SSH `origin` rewritten to HTTPS, a credential helper from the forge's
 * token in the env (github: `gh auth git-credential` over GH_TOKEN/GITHUB_TOKEN; gitlab:
 * GITLAB_TOKEN), `safe.directory=*`, and the host's commit identity. Pure.
 * @param {{originUrl?: string, forgeType?: string, forgeBaseUrl?: string, author?: {name?: string, email?: string}}} o
 * @returns {Record<string, string>}
 */
export function gitSandboxEnv({ originUrl, forgeType, forgeBaseUrl, author }) {
  const host = forgeType === "github" ? "github.com" : hostOf(forgeBaseUrl) ?? hostOf(originUrl);
  const kind = forgeType ?? (host === "github.com" ? "github" : host && /gitlab/.test(host) ? "gitlab" : undefined);
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

/** One host git read against a repo a sandbox can write (hardened; "" when unset or failing).
 * @param {string} repo @param {string[]} args */
function hostGit(repo, args) {
  try {
    return execFileSync("git", [...HOST_GIT_SAFE, "-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

/** The host side of `gitSandboxEnv`: the repo's origin URL and commit identity, read once per run.
 * @param {string} repo @returns {{originUrl?: string, author: {name?: string, email?: string}}} */
export function hostGitFacts(repo) {
  return {
    originUrl: hostGit(repo, ["remote", "get-url", "origin"]) || undefined,
    author: { name: hostGit(repo, ["config", "user.name"]) || undefined, email: hostGit(repo, ["config", "user.email"]) || undefined },
  };
}
