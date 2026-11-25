// The `ssh` executor (#689 phase 1, #690 phase 2 — the remote-harness epic #681): a harness with
// a `remote` block runs its agent on another machine over ssh instead of the host/sandbox. Code
// transport (#690): before every run the ticket's code is synced to a deterministic per-ref(+step)
// path under the worker's `remote.workDir` over git+SSH (no forge) — a hub-authoritative force-push
// + `worktree add` for a worktree step, a tracked-only `git archive` for a no-worktree step; after
// every run (always, incl. timeout/cancel) any commits are fetched back and fast-forwarded into the
// hub worktree. The hub worktree stays the only real copy; the worker's uncommitted edits never
// travel either direction. Submodules/LFS are refused (not supported yet). Claude and OpenCode are
// supported (config refuses any other agent on a remote harness, #739).
import fs from "node:fs";
import path from "node:path";
import { execFile, execFileSync, spawn } from "node:child_process";
import { promisify } from "node:util";
import { MAX_SANDBOX_VERDICT_BYTES } from "./verdict.js";
import { runtimeEnv } from "./sandbox.js";
import { mangle } from "../paths.js";
import { OUTBOX_FILE_NAMES, OUTBOX_COPY_CAP_BYTES } from "./outbox.js";
import { gitArgv, HOST_GIT_TIMEOUT_MS } from "../worktree.js";

const execFileP = promisify(execFile);

/** Cap on one hub-side git-transport call (push/fetch over ssh) — network, so more generous
 * than HOST_GIT_TIMEOUT_MS's local-only budget. */
const HUB_GIT_TRANSPORT_TIMEOUT_MS = 30_000;

/** Cap on one quick hub-side read (dirty check, submodule/LFS probe) before a sync. */
const HUB_GIT_READ_TIMEOUT_MS = 10_000;

/** How long the remote watchdog (closed-stdin detector) and the explicit kill path wait between
 * SIGTERM and SIGKILL. Short on purpose — these are receiver-managed runs, not interactive ones. */
const SSH_KILL_GRACE_S = 2;

/** POSIX single-quote a string for a remote shell: wraps it in `'…'`, escaping embedded `'` as
 * `'\''`. Safe for any bytes — no interpolation, no special-casing `$`/backtick/newline/empty.
 * Pure. @param {string} s @returns {string} */
export function shQuote(s) {
  return `'${String(s).replace(/'/g, "'\\''")}'`;
}

/** A ref/step-safe path component, matching spawn.js's own sanitizer. @param {string} s */
const safePart = (s) => String(s).replace(/[^A-Za-z0-9_.-]/g, "_");

/** The per-stateKey base dir under a remote harness's `workDir`. @param {import('../types.js').RemoteHarness} remote @param {string} stateKey */
const remoteBase = (remote, stateKey) => `${remote.workDir}/.agenthook/${safePart(stateKey)}`;

/** Where a run's pgid/prompt-pipe files live on the worker. @param {import('../types.js').RemoteHarness} remote @param {string} stateKey */
const remoteRunsDir = (remote, stateKey) => `${remoteBase(remote, stateKey)}/runs`;

/** The remote per-run verdict dir (mirrors sandboxVerdictPathFor's own naming). @param {import('../types.js').RemoteHarness} remote @param {string} stateKey @param {string} ref @param {string} stepId */
const remoteVerdictDir = (remote, stateKey, ref, stepId) => `${remoteBase(remote, stateKey)}/verdicts/run-${safePart(ref)}-${safePart(stepId)}`;

/** One bare repo per routed repo (#690), created on first use. @param {import('../types.js').RemoteHarness} remote @param {string} stateKey */
const remoteReposDir = (remote, stateKey) => `${remoteBase(remote, stateKey)}/repos`;
/** @param {import('../types.js').RemoteHarness} remote @param {string} stateKey @param {string} repoId */
const remoteRepoGitPath = (remote, stateKey, repoId) => `${remoteReposDir(remote, stateKey)}/${safePart(repoId)}.git`;

/** Worker worktrees for a worktree step (#690), one per ref, deterministic — a verdict-repair
 * resume turn relaunches into the same one. @param {import('../types.js').RemoteHarness} remote @param {string} stateKey */
const remoteWorktreesDir = (remote, stateKey) => `${remoteBase(remote, stateKey)}/worktrees`;
/** @param {import('../types.js').RemoteHarness} remote @param {string} stateKey @param {string} ref */
const remoteWorktreePath = (remote, stateKey, ref) => `${remoteWorktreesDir(remote, stateKey)}/${safePart(ref)}`;

/** Worker export dirs for a no-worktree step (#690), one per ref+step. @param {import('../types.js').RemoteHarness} remote @param {string} stateKey */
const remoteExportsDir = (remote, stateKey) => `${remoteBase(remote, stateKey)}/exports`;
/** @param {import('../types.js').RemoteHarness} remote @param {string} stateKey @param {string} ref @param {string} stepId */
const remoteExportPath = (remote, stateKey, ref, stepId) => `${remoteExportsDir(remote, stateKey)}/${safePart(ref)}-${safePart(stepId)}`;

/** Per-run config dir (#739) an `AgentAdapter.remote` hook's `files` are written into — under
 * `runs/`, outside the synced worktree/export dir, so it is never committed or synced back.
 * Deterministic per ref+step (like `remoteVerdictDir`), so a verdict-repair resume turn's
 * `OPENCODE_CONFIG` still points at a dir that exists. @param {import('../types.js').RemoteHarness} remote @param {string} stateKey @param {string} ref @param {string} stepId */
const remoteConfigDir = (remote, stateKey, ref, stepId) => `${remoteRunsDir(remote, stateKey)}/${safePart(ref)}-${safePart(stepId)}.opencode`;

/** The ssh option argv (no `-T`, no host) shared by the launcher's own ssh call and
 * `gitSshCommand`'s `GIT_SSH_COMMAND` (#690) — one source for host/port/identity/user. Never `-A`.
 * @param {import('../types.js').RemoteHarness} remote @returns {string[]} */
function sshOptionArgs(remote) {
  /** @type {string[]} */
  const args = ["-o", "BatchMode=yes"];
  if (remote.port) args.push("-p", String(remote.port));
  if (remote.identityFile) args.push("-i", remote.identityFile);
  if (remote.user) args.push("-l", remote.user);
  return args;
}

/** The base ssh argv (options + host), before the trailing remote command. @param {import('../types.js').RemoteHarness} remote @returns {string[]} */
export function sshBaseArgs(remote) {
  return ["-T", ...sshOptionArgs(remote), remote.host];
}

/** The full `ssh` argv for a one-off probe of `script` on this harness's worker (#691 doctor
 * checks): the same base argv the executor's own `runRemote`/`runRemoteChecked` use, so doctor
 * never builds its own copy of the ssh command. Each remote-command element is individually
 * shQuoted, same as `runRemote`. @param {import('../types.js').RemoteHarness} remote @param {string} script @returns {string[]} */
export function remoteProbeArgv(remote, script) {
  return [...sshBaseArgs(remote), shQuote("sh"), shQuote("-c"), shQuote(script)];
}

/** The full `ssh` argv for an INTERACTIVE command on this harness's worker (`resume --exec`,
 * #830): the only tty variant — `-t` instead of `-T`, the same options (still `BatchMode=yes`,
 * never `-A`) and host, then the same shQuoted `sh -c <script>` tail. @param {import('../types.js').RemoteHarness} remote @param {string} script @returns {string[]} */
export function sshInteractiveArgv(remote, script) {
  return ["-t", ...sshOptionArgs(remote), remote.host, shQuote("sh"), shQuote("-c"), shQuote(script)];
}

/** The env the LOCAL ssh client for this worker gets: the receiver's own runtime env
 * (`runtimeEnv` — PATH/HOME/USER/XDG_RUNTIME_DIR + container prefixes, never the step's `env`
 * nor the rest of process.env) plus the agent-forwarding socket, and `TERM` only for a pty
 * (`sshInteractiveArgv`). Same env shape as the executor's own ssh call. @param {{tty?: boolean}} [o] @returns {Record<string, string>} */
export function sshClientEnv({ tty = false } = {}) {
  const env = { ...runtimeEnv(process.env) };
  if (typeof process.env.SSH_AUTH_SOCK === "string") env.SSH_AUTH_SOCK = process.env.SSH_AUTH_SOCK;
  if (tty && typeof process.env.TERM === "string") env.TERM = process.env.TERM;
  return env;
}

/** The worker paths one run's agent lived in (#830): its launch cwd (the worktree or export dir
 * `paths()` computed) and — for a worktree step — the bare repo that worktree came from, so a
 * hand-resume can `git worktree add` it back. Reuses the private path helpers, so nothing else
 * re-derives them. @param {import('../types.js').RemoteHarness} remote @param {string} stateKey
 * @param {{ref: string, stepId: string, hasWorktree: boolean, repoId?: string}} o
 * @returns {{cwd: string, bareRepo?: string}} */
export function remoteRunPaths(remote, stateKey, { ref, stepId, hasWorktree, repoId }) {
  const cwd = hasWorktree ? remoteWorktreePath(remote, stateKey, ref) : remoteExportPath(remote, stateKey, ref, stepId);
  return { cwd, ...(hasWorktree && repoId ? { bareRepo: remoteRepoGitPath(remote, stateKey, repoId) } : {}) };
}

/** The agent transcript dir for a worker launch cwd, RELATIVE to the worker user's `$HOME`
 * (#830): Claude keys its project dir by the launch cwd's mangle (src/paths.js), and no `HOME`
 * crosses to the worker (`remoteEnvAllowlist`) — so it's the worker user's own `~/.claude`.
 * @param {string} cwd the worker launch cwd (absolute) @returns {string} */
export function remoteTranscriptDir(cwd) {
  return path.posix.join(".claude", "projects", mangle(cwd));
}

/** `GIT_SSH_COMMAND` for a hub git-transport call (push/fetch) against this harness's worker
 * (#690): same options `sshBaseArgs` uses, shell-quoted, no host (git appends it itself from the
 * `ssh://` URL) and no `-T` (git's own ssh transport allocates no tty). Never `-A`.
 * @param {import('../types.js').RemoteHarness} remote @returns {string} */
function gitSshCommand(remote) {
  const parts = ["ssh", "-o", shQuote("BatchMode=yes")];
  if (remote.port) parts.push("-p", String(remote.port));
  if (remote.identityFile) parts.push("-i", shQuote(remote.identityFile));
  if (remote.user) parts.push("-l", shQuote(remote.user));
  return parts.join(" ");
}

/** The `ssh://` URL for a path on this harness's worker (#690): host only — port/identity/user
 * ride on `GIT_SSH_COMMAND` instead. @param {import('../types.js').RemoteHarness} remote @param {string} remotePath */
const gitSshUrl = (remote, remotePath) => `ssh://${remote.host}${remotePath}`;

/** The env for a hub git-transport call against this harness's worker (#690): the receiver's own
 * env plus `GIT_SSH_COMMAND`, with interactive auth prompts disabled. @param {import('../types.js').RemoteHarness} remote */
const hubTransportEnv = (remote) => ({ ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: gitSshCommand(remote) });

/** Run `sh -c <script>` on the worker over a fresh ssh connection, each remote-command element
 * individually shQuoted (ssh joins its trailing argv with spaces before the remote shell parses
 * it — never `-A`). Resolves to stdout (a Buffer); a non-zero exit or network failure resolves to
 * null rather than throwing (every caller treats "couldn't reach it" as best-effort).
 * @param {import('../types.js').RemoteHarness} remote @param {string} script @param {{maxBuffer?: number}} [opts]
 * @returns {Promise<Buffer|null>} */
function runRemote(remote, script, { maxBuffer } = {}) {
  const args = [...sshBaseArgs(remote), shQuote("sh"), shQuote("-c"), shQuote(script)];
  return new Promise((resolve) => {
    execFile("ssh", args, { encoding: "buffer", maxBuffer: maxBuffer ?? 256 * 1024 }, (err, stdout) => {
      resolve(err ? null : stdout);
    });
  });
}

/** Like `runRemote`, but a non-zero exit or network failure REJECTS with the remote stderr (or
 * the ssh client's own error) — for the sync paths (#690), where a caller needs a clear reason to
 * refuse the run on, not best-effort silence.
 * @param {import('../types.js').RemoteHarness} remote @param {string} script @param {{maxBuffer?: number}} [opts]
 * @returns {Promise<string>} */
function runRemoteChecked(remote, script, { maxBuffer } = {}) {
  const args = [...sshBaseArgs(remote), shQuote("sh"), shQuote("-c"), shQuote(script)];
  return new Promise((resolve, reject) => {
    execFile("ssh", args, { encoding: "utf8", maxBuffer: maxBuffer ?? 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || "").trim() || err.message));
      else resolve(stdout);
    });
  });
}

/** The script a short-lived ssh call runs to TERM-then-KILL a run's process group, given its
 * pgid file. Idempotent — a missing file or an already-dead group is silently ignored.
 * @param {string} pgidFile @returns {string} */
function killScript(pgidFile) {
  return `p=$(cat ${shQuote(pgidFile)} 2>/dev/null); if [ -n "$p" ]; then kill -TERM "-$p" 2>/dev/null; sleep ${SSH_KILL_GRACE_S}; kill -KILL "-$p" 2>/dev/null; fi`;
}

// --- code transport (#690) ---

/** Refuse a worktree step whose hub worktree has uncommitted changes to TRACKED files — they
 * would never reach the worker (untracked/ignored files already never travel: the sync is a push
 * of committed history, or an archive of HEAD). Throws with a clear reason on git failure too.
 * @param {{sandbox?: unknown, harnesses?: Record<string, {remote?: unknown}|undefined>}} cfg @param {string} worktree */
function refuseIfDirty(cfg, worktree) {
  let out;
  try {
    out = execFileSync("git", gitArgv(cfg, worktree, ["status", "--porcelain", "--untracked-files=no"]), {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: HUB_GIT_READ_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
  } catch (e) {
    throw new Error(`could not check ${worktree} for uncommitted changes: ${(e.stderr || e.message || e).toString().trim().split("\n")[0]}`);
  }
  if (out.trim()) throw new Error(`${worktree} has uncommitted changes to tracked files — they would not reach the worker; commit or discard them first`);
}

/** Whether `atRef` in `repoPath` has a `.gitmodules` file, or a `.gitattributes` with a
 * `filter=lfs` entry — either way the tree is refused on a remote harness (not supported yet).
 * `repoPath` is the dir git runs `-C` against (a worktree or the main checkout); best-effort
 * reads (git exits non-zero when the path is simply absent at that ref).
 * @param {{sandbox?: unknown, harnesses?: Record<string, {remote?: unknown}|undefined>}} cfg @param {string} repoPath @param {string} [atRef]
 * @returns {string|null} */
function submoduleOrLfsPath(cfg, repoPath, atRef = "HEAD") {
  /** @param {string} path */
  const readAtRef = (path) => {
    try {
      return execFileSync("git", gitArgv(cfg, repoPath, ["show", `${atRef}:${path}`]), {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: HUB_GIT_READ_TIMEOUT_MS,
        killSignal: "SIGKILL",
      });
    } catch {
      return null;
    }
  };
  if (readAtRef(".gitmodules") !== null) return ".gitmodules";
  const attrs = readAtRef(".gitattributes");
  if (attrs !== null && /filter=lfs/.test(attrs)) return ".gitattributes (filter=lfs)";
  return null;
}

/** @param {{sandbox?: unknown, harnesses?: Record<string, {remote?: unknown}|undefined>}} cfg @param {string} repoPath @param {string} atRef @param {string} what */
function refuseIfSubmoduleOrLfs(cfg, repoPath, atRef, what) {
  const hit = submoduleOrLfsPath(cfg, repoPath, atRef);
  if (hit) throw new Error(`${repoPath} (${what}) uses ${hit} — submodules/LFS are not supported on a remote harness yet`);
}

/** Make sure the worker's bare repo for this routed repo exists (idempotent `git init --bare`).
 * @param {import('../types.js').RemoteHarness} remote @param {string} gitPath */
async function ensureWorkerBareRepo(remote, gitPath) {
  await runRemoteChecked(remote, `mkdir -p ${shQuote(path.posix.dirname(gitPath))} && { [ -d ${shQuote(gitPath)} ] || git init --quiet --bare ${shQuote(gitPath)}; }`);
}

/** Force-push the hub worktree's branch to the worker's bare repo — the hub is authoritative, so
 * this overwrites anything a crashed/refused prior run left there.
 * @param {{sandbox?: unknown, harnesses?: Record<string, {remote?: unknown}|undefined>}} cfg @param {import('../types.js').RemoteHarness} remote @param {string} worktree @param {string} gitPath @param {string} branch
 * @returns {Promise<string>} the pushed sha (the "before" sha for done()'s ff-only merge-back) */
async function pushWorktreeToWorker(cfg, remote, worktree, gitPath, branch) {
  const sha = execFileSync("git", gitArgv(cfg, worktree, ["rev-parse", "HEAD"]), { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: HOST_GIT_TIMEOUT_MS, killSignal: "SIGKILL" }).trim();
  await execFileP("git", gitArgv(cfg, worktree, ["push", "--force", gitSshUrl(remote, gitPath), `${branch}:refs/heads/${branch}`]), {
    env: hubTransportEnv(remote),
    timeout: HUB_GIT_TRANSPORT_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
  });
  return sha;
}

/** Prune the bare repo's worktree admin and remove any dir at `wtPath` — a prior run's branch
 * must not still be "currently checked out" in a linked worktree, or the force-push itself is
 * refused by receive-pack. Called before the push (not just before `worktree add`) so a leftover
 * worktree a crashed run's best-effort cleanup never reaped doesn't block every later run on that
 * ref. @param {import('../types.js').RemoteHarness} remote @param {string} gitPath @param {string} wtPath */
async function clearWorkerWorktree(remote, gitPath, wtPath) {
  await runRemoteChecked(remote, [`git -C ${shQuote(gitPath)} worktree prune`, `rm -rf ${shQuote(wtPath)}`, `git -C ${shQuote(gitPath)} worktree prune`].join(" && "));
}

/** Add the worker's worktree for this branch at `wtPath` (already cleared by `clearWorkerWorktree`
 * before the push). @param {import('../types.js').RemoteHarness} remote @param {string} gitPath @param {string} wtPath @param {string} branch */
async function addWorkerWorktree(remote, gitPath, wtPath, branch) {
  await runRemoteChecked(remote, [`mkdir -p ${shQuote(path.posix.dirname(wtPath))}`, `git -C ${shQuote(gitPath)} worktree add ${shQuote(wtPath)} ${shQuote(branch)}`].join(" && "));
}

/** Stream a tracked-only `git archive HEAD` of `repoPath` straight into a fresh dir on the worker
 * (no intermediate hub-side file) — a gitignored/untracked file, `.env` or the profile config
 * never travels. Rejects with whichever side failed first.
 * @param {{sandbox?: unknown, harnesses?: Record<string, {remote?: unknown}|undefined>}} cfg @param {import('../types.js').RemoteHarness} remote @param {string} repoPath @param {string} dir
 * @returns {Promise<void>} */
function archiveToWorker(cfg, remote, repoPath, dir) {
  return new Promise((resolve, reject) => {
    const git = spawn("git", gitArgv(cfg, repoPath, ["archive", "--format=tar", "HEAD"]), { stdio: ["ignore", "pipe", "pipe"] });
    const remoteScript = `rm -rf ${shQuote(dir)} && mkdir -p ${shQuote(dir)} && tar -x -C ${shQuote(dir)}`;
    const ssh = spawn("ssh", [...sshBaseArgs(remote), shQuote("sh"), shQuote("-c"), shQuote(remoteScript)], { stdio: ["pipe", "pipe", "pipe"] });
    let gitErr = "";
    let sshErr = "";
    git.stderr.on("data", (d) => (gitErr += d));
    ssh.stderr.on("data", (d) => (sshErr += d));
    git.stdout.pipe(ssh.stdin);
    let settled = false;
    /** @param {Error} e */
    const fail = (e) => {
      if (settled) return;
      settled = true;
      resolve = () => {}; // past this point only `fail` may settle
      reject(e);
    };
    git.on("error", (e) => fail(new Error(`git archive failed: ${e.message}`)));
    ssh.on("error", (e) => fail(new Error(`export to worker failed: ${e.message}`)));
    /** @type {number|null} */ let gitCode = null;
    /** @type {number|null} */ let sshCode = null;
    const settle = () => {
      if (settled || gitCode === null || sshCode === null) return;
      if (gitCode !== 0) fail(new Error(`git archive failed: ${gitErr.trim() || `exit ${gitCode}`}`));
      else if (sshCode !== 0) fail(new Error(`export to worker failed: ${sshErr.trim() || `exit ${sshCode}`}`));
      else {
        settled = true;
        resolve();
      }
    };
    git.on("close", (c) => {
      gitCode = c ?? 1;
      settle();
    });
    ssh.on("close", (c) => {
      sshCode = c ?? 1;
      settle();
    });
  });
}

/** Fetch the worker branch into the hub repo under a temporary ref (#690's sync-back, step 1).
 * @param {{sandbox?: unknown, harnesses?: Record<string, {remote?: unknown}|undefined>}} cfg @param {import('../types.js').RemoteHarness} remote @param {string} worktree @param {string} gitPath @param {string} branch @param {string} tmpRef */
async function fetchWorkerBranch(cfg, remote, worktree, gitPath, branch, tmpRef) {
  await execFileP("git", gitArgv(cfg, worktree, ["fetch", "--no-tags", gitSshUrl(remote, gitPath), `+refs/heads/${branch}:${tmpRef}`]), {
    env: hubTransportEnv(remote),
    timeout: HUB_GIT_TRANSPORT_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
  });
}

/** @param {{sandbox?: unknown, harnesses?: Record<string, {remote?: unknown}|undefined>}} cfg @param {string} dir @param {string} ref @returns {string} */
function revParse(cfg, dir, ref) {
  return execFileSync("git", gitArgv(cfg, dir, ["rev-parse", ref]), { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: HOST_GIT_TIMEOUT_MS, killSignal: "SIGKILL" }).trim();
}

/** @param {{sandbox?: unknown, harnesses?: Record<string, {remote?: unknown}|undefined>}} cfg @param {string} dir @param {string} ancestor @param {string} descendant @returns {boolean} */
function isAncestor(cfg, dir, ancestor, descendant) {
  try {
    execFileSync("git", gitArgv(cfg, dir, ["merge-base", "--is-ancestor", ancestor, descendant]), { stdio: ["ignore", "ignore", "ignore"], timeout: HOST_GIT_TIMEOUT_MS, killSignal: "SIGKILL" });
    return true;
  } catch {
    return false;
  }
}

/** @param {{sandbox?: unknown, harnesses?: Record<string, {remote?: unknown}|undefined>}} cfg @param {string} worktree @param {string} ref */
function deleteRef(cfg, worktree, ref) {
  try {
    execFileSync("git", gitArgv(cfg, worktree, ["update-ref", "-d", ref]), { stdio: ["ignore", "ignore", "ignore"], timeout: HOST_GIT_TIMEOUT_MS, killSignal: "SIGKILL" });
  } catch {
    /* best effort — a leftover temp ref under refs/agenthook/remote/ is harmless */
  }
}

/** Pre-run sync (#690): push + `worktree add` for a worktree step, `git archive` + untar for a
 * no-worktree one. Any failure (dirty tree, submodule/LFS, a push/ssh error) throws with a clear,
 * user-facing reason — the caller's `launch()` rejection becomes the run's `refused`, nothing
 * spawns. Returns the pushed "before" sha for a worktree step (what `syncAfter` compares the
 * worker's branch against), else undefined.
 * @param {{sandbox?: unknown, harnesses?: Record<string, {remote?: unknown}|undefined>}} cfg @param {import('../types.js').RemoteHarness} remote @param {string} stateKey
 * @param {{repoId: string, repoPath: string, worktree?: string, branch?: string}} hub @param {string} cwd
 * @returns {Promise<string|undefined>} */
async function syncBefore(cfg, remote, stateKey, hub, cwd) {
  if (hub.worktree && hub.branch) {
    refuseIfDirty(cfg, hub.worktree);
    refuseIfSubmoduleOrLfs(cfg, hub.worktree, "HEAD", "the worktree");
    const gitPath = remoteRepoGitPath(remote, stateKey, hub.repoId);
    await ensureWorkerBareRepo(remote, gitPath);
    await clearWorkerWorktree(remote, gitPath, cwd);
    const beforeSha = await pushWorktreeToWorker(cfg, remote, hub.worktree, gitPath, hub.branch);
    await addWorkerWorktree(remote, gitPath, cwd, hub.branch);
    return beforeSha;
  }
  refuseIfSubmoduleOrLfs(cfg, hub.repoPath, "HEAD", "the repo");
  await archiveToWorker(cfg, remote, hub.repoPath, cwd);
  return undefined;
}

/** Post-run sync-back (#690), always attempted (even after a timeout/cancel/crash) so commits
 * aren't stranded. Worktree step: fetch the worker's branch, then fast-forward the hub worktree
 * onto it — a no-op when the fetched sha already equals `beforeSha`; a `failed` reason (never
 * touching the hub worktree) when `beforeSha` isn't the fetched sha's ancestor (rewritten/
 * diverged history) or the fast-forward itself fails. No-worktree step: nothing is fetched back —
 * only committed content ever went out, and the worker's own edits were never meant to return.
 * Cleanup (the worker worktree/export dir) is always attempted after, best-effort, and never
 * overrides a sync-back refusal already found.
 * @param {{sandbox?: unknown, harnesses?: Record<string, {remote?: unknown}|undefined>}} cfg @param {import('../types.js').RemoteHarness} remote @param {string} stateKey
 * @param {{repoId: string, repoPath: string, worktree?: string, branch?: string}} hub @param {string} cwd @param {string|undefined} beforeSha
 * @returns {Promise<{failed?: string}>} */
async function syncAfter(cfg, remote, stateKey, hub, cwd, beforeSha) {
  const gitPath = remoteRepoGitPath(remote, stateKey, hub.repoId);
  if (!(hub.worktree && hub.branch)) {
    await runRemote(remote, `rm -rf ${shQuote(cwd)}`);
    return {};
  }
  const tmpRef = `refs/agenthook/remote/${safePart(hub.branch)}`;
  /** @type {{failed?: string}} */
  let result = {};
  try {
    await fetchWorkerBranch(cfg, remote, hub.worktree, gitPath, hub.branch, tmpRef);
    const fetchedSha = revParse(cfg, hub.worktree, tmpRef);
    if (fetchedSha !== beforeSha) {
      if (!beforeSha || !isAncestor(cfg, hub.worktree, beforeSha, fetchedSha)) {
        result = { failed: `the worker's branch ${hub.branch} no longer descends from what was pushed (rewritten or diverged history) — refusing to touch the hub worktree` };
      } else {
        try {
          execFileSync("git", gitArgv(cfg, hub.worktree, ["merge", "--ff-only", fetchedSha]), { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: HOST_GIT_TIMEOUT_MS, killSignal: "SIGKILL" });
        } catch (e) {
          result = { failed: `could not fast-forward the hub worktree to the worker's commits: ${(e.stderr || e.message || e).toString().trim().split("\n")[0]}` };
        }
      }
    }
  } catch (e) {
    result = { failed: `could not fetch commits back from the worker: ${(e.stderr || e.message || e).toString().trim().split("\n")[0]}` };
  } finally {
    deleteRef(cfg, hub.worktree, tmpRef);
  }
  await runRemote(remote, `git -C ${shQuote(gitPath)} worktree remove --force ${shQuote(cwd)} 2>/dev/null; git -C ${shQuote(gitPath)} worktree prune`);
  return result;
}

/** Cleanup-only counterpart to `syncAfter`, for a `raw` launch (#710's gate): remove the worker
 * worktree (pruning the bare repo's admin) or export dir — never fetches anything back.
 * @param {import('../types.js').RemoteHarness} remote @param {string|undefined} gitPath @param {string} cwd
 * @param {{repoId: string, repoPath: string, worktree?: string, branch?: string}|undefined} hub
 * @returns {Promise<void>} */
async function cleanupWorker(remote, gitPath, cwd, hub) {
  if (hub?.worktree && hub?.branch && gitPath) {
    await runRemote(remote, `git -C ${shQuote(gitPath)} worktree remove --force ${shQuote(cwd)} 2>/dev/null; git -C ${shQuote(gitPath)} worktree prune`);
  } else {
    await runRemote(remote, `rm -rf ${shQuote(cwd)}`);
  }
}

/** Non-secret run metadata + a couple of locale/CI knobs — everything else (tracker/forge
 * tokens, per-run App tokens, ANTHROPIC_ and CLAUDE_ vars, SSH_AUTH_SOCK, an arbitrary harness `env` key)
 * is dropped. `AGENTHOOK_VERDICT_FILE` rides the `AGENTHOOK_` prefix. TERM/LANG/CI come straight
 * from the receiver's own env — containerEnv (spawn.js) already stripped them off `env` (it
 * treats TERM as host-only), so pulling them from `env` here would always miss. `extra` (#739) is
 * an explicit, named addition — exactly the keys an `AgentAdapter.remote` hook returned (e.g.
 * opencode's `OPENCODE_CONFIG`/`OPENCODE_DISABLE_*`) — never a prefix passthrough from `env`
 * itself, so a hub-side `OPENCODE_*` value (unrelated to the hook's own return) never crosses just
 * because its name matches. Pure (ignoring the `process.env` read).
 * @param {Record<string, string|undefined>} env @param {Record<string, string>} [extra] @returns {Record<string, string>} */
export function remoteEnvAllowlist(env, extra = {}) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === "string" && k.startsWith("AGENTHOOK_")) out[k] = v;
  }
  for (const k of /** @type {const} */ (["TERM", "LANG", "CI"])) {
    if (typeof process.env[k] === "string") out[k] = /** @type {string} */ (process.env[k]);
  }
  return { ...out, ...extra };
}

/** The stdin payload the remote launcher reads: a line-count header of `KEY=VALUE` env records,
 * then — only when `files` is non-empty (#739; an EMPTY array adds nothing, so the claude path's
 * frame stays byte-for-byte unchanged) — a file-count header followed by `path`/`mode`/byte-count
 * lines and that many raw bytes per file (a config/contract/standing file an `AgentAdapter.remote`
 * hook returned), then finally a byte-count line and exactly that many raw bytes of the prompt.
 * Nothing here is shell-quoted (it travels as data, not argv), so any content is safe. Env/file
 * path values must not contain a newline (the allowlist's env values never do: paths, TERM/LANG/
 * CI; file paths are receiver-built, under a per-run dir). Pure.
 * @param {Record<string, string>} env @param {string} prompt @param {{dst: string, content: string, mode?: number}[]} [files] @returns {string} */
export function framePayload(env, prompt, files = []) {
  const entries = Object.entries(env);
  const lines = entries.map(([k, v]) => `${k}=${v}\n`).join("");
  const filesSection = files.length
    ? `${files.length}\n${files.map((f) => {
        const bytes = Buffer.byteLength(f.content, "utf8");
        return `${f.dst}\n${(f.mode ?? 0o600).toString(8)}\n${bytes}\n${f.content}`;
      }).join("")}`
    : "";
  const text = String(prompt ?? "");
  const plen = Buffer.byteLength(text, "utf8");
  return `${entries.length}\n${lines}${filesSection}${plen}\n${text}`;
}

/**
 * The remote POSIX-sh launcher (#689): reads the framed env+prompt off stdin, puts the agent in
 * its own process group (pgid file for reap/kill), runs it with the prompt on ITS stdin (not
 * argv — `execArgv` never includes the prompt), and starts a watchdog that TERM-then-KILLs the
 * group once stdin closes (client died, link dropped, or the hub ended it on a kill). Removes its
 * pgid file on exit and exits with the agent's own code. `head -c`/`setsid`/`/proc` are assumed
 * (Linux workers; a missing /proc falls back to the launcher's own pid as the pgid).
 * A `raw` launch (a gate, #710) never touches `verdictDir` — it has no verdict to write and must
 * not disturb whatever the agent's own launch already left there. `hasFiles` (#739): when true, a
 * file-count header followed by `path`/`mode`/byte-count-then-bytes per file is read right after
 * the env section (written before the prompt by `framePayload`) and each written to disk with the
 * given mode, before the agent is launched — so e.g. an OpenCode `OPENCODE_CONFIG` file exists
 * before `opencode run` starts reading it. `configDir` (its dir, already created by the caller
 * when `hasFiles`) is removed at the end alongside the pgid/pipe files, on every exit path.
 * `resume` (a verdict-repair turn, #677/#825): the verdict dir is KEPT — only `verdict.json`
 * itself is removed so the agent rewrites it — because the turn's outbox (`verdictDir/outbox/`,
 * #825) must survive to the last turn's copy-back. A fresh launch still wipes it whole.
 * @param {{workDir: string, runsDir: string, pgidFile: string, promptPipe: string, verdictDir: string|undefined, configDir: string|undefined, hasFiles: boolean, execArgv: string[], resume?: boolean}} o
 * @returns {string} */
export function launcherScript({ workDir, runsDir, pgidFile, promptPipe, verdictDir, configDir, hasFiles, execArgv, resume }) {
  const exec = execArgv.map(shQuote).join(" ");
  return [
    `cd ${shQuote(workDir)} || exit 1`,
    `mkdir -p ${shQuote(runsDir)}`,
    ...(verdictDir
      ? resume
        ? [`[ -d ${shQuote(verdictDir)} ] || mkdir -p -m 700 ${shQuote(verdictDir)}`, `rm -f ${shQuote(`${verdictDir}/verdict.json`)}`]
        : [`rm -rf ${shQuote(verdictDir)}`, `mkdir -p -m 700 ${shQuote(verdictDir)}`]
      : []),
    ...(configDir ? [`rm -rf ${shQuote(configDir)}`, `mkdir -p -m 700 ${shQuote(configDir)}`] : []),
    `rm -f ${shQuote(promptPipe)}`,
    `mkfifo ${shQuote(promptPipe)}`,
    `read -r n`,
    `i=0`,
    `while [ "$i" -lt "$n" ]; do IFS= read -r line; k=\${line%%=*}; v=\${line#*=}; export "$k=$v"; i=$((i+1)); done`,
    ...(hasFiles
      ? [
          `read -r nf`,
          `j=0`,
          `while [ "$j" -lt "$nf" ]; do`,
          `  IFS= read -r fpath`,
          `  read -r fmode`,
          `  read -r flen`,
          `  mkdir -p "$(dirname "$fpath")"`,
          `  head -c "$flen" > "$fpath"`,
          `  chmod "$fmode" "$fpath"`,
          `  j=$((j+1))`,
          `done`,
        ]
      : []),
    `read -r plen`,
    `setsid ${exec} < ${shQuote(promptPipe)} &`,
    `agentpid=$!`,
    `head -c "$plen" > ${shQuote(promptPipe)}`,
    // A backgrounded job of a non-job-control sh is never its own process group leader, so the
    // `setsid` command never forks (man setsid(1)): it calls setsid() on itself and execs in
    // place. Its pid is therefore always its own new pgid — no /proc read, no race.
    `echo "$agentpid" > ${shQuote(pgidFile)}`,
    `exec 3<&0`,
    `( cat <&3 >/dev/null; p=$(cat ${shQuote(pgidFile)} 2>/dev/null); if [ -n "$p" ]; then kill -TERM "-$p" 2>/dev/null; sleep ${SSH_KILL_GRACE_S}; kill -KILL "-$p" 2>/dev/null; fi ) &`,
    `wait "$agentpid" 2>/dev/null`,
    `code=$?`,
    `rm -f ${shQuote(pgidFile)} ${shQuote(promptPipe)}`,
    ...(configDir ? [`rm -rf ${shQuote(configDir)}`] : []),
    `exit "$code"`,
  ].join("\n");
}

/**
 * One harness's `ssh` executor (#689 launch/kill/env, #690 code transport). `spawnPaths.
 * sandboxVerdictPathFor` supplies the hub-local copy-back target (`hubVerdictFile`) — same
 * per-run-dir helper the sandbox executor's own verdict path uses, so both get the "only dir
 * mounted/copied into" guarantee. `cfg` is only used for the hardened hub-side git calls
 * (`gitArgv`) the sync makes — never network-touched except via `remote`'s own host.
 * @param {{stateKey: string, remote: import('../types.js').RemoteHarness, spawnPaths: {sandboxVerdictPathFor: (stepId: string, ref: string) => string}, cfg?: {sandbox?: unknown, harnesses?: Record<string, {remote?: unknown}|undefined>}}} o
 * @returns {import('../types.js').Executor} */
export function createSshExecutor({ stateKey, remote, spawnPaths, cfg = {} }) {
  return {
    name: "ssh",
    paths: ({ stepId, ref, hasWorktree }) => {
      const cwd = hasWorktree ? remoteWorktreePath(remote, stateKey, ref) : remoteExportPath(remote, stateKey, ref, stepId);
      return {
        cwd,
        worktree: hasWorktree ? cwd : undefined,
        verdictFile: `${remoteVerdictDir(remote, stateKey, ref, stepId)}/verdict.json`,
        hubVerdictFile: spawnPaths.sandboxVerdictPathFor(stepId, ref),
        configDir: remoteConfigDir(remote, stateKey, ref, stepId),
      };
    },
    launch: async ({ runId, ref, stepId, bin, defaultBin, args, env, cwd, hub, raw, files, remoteEnv, prompt: expectedPrompt, resume }) => {
      // `raw` (#710, a step's gate): the given argv runs on the worker verbatim — never the
      // agent-launch assumption that a known argv element is the prompt to pull off onto stdin.
      let prompt = "";
      let execArgv;
      if (raw) {
        execArgv = [bin, ...args];
      } else {
        // The prompt sits at args[1] (claude's `-p <prompt>`) or as the final element (opencode's
        // trailing positional, behind `--`) — never assumed by agent name, so a mismatch (a future
        // agent whose argv shape differs) refuses the run instead of leaking the prompt into argv.
        if (args[1] === expectedPrompt) {
          prompt = args[1];
          execArgv = [args[0], ...args.slice(2)];
        } else if (args.length > 0 && args[args.length - 1] === expectedPrompt) {
          prompt = args[args.length - 1];
          execArgv = args.slice(0, -1);
        } else {
          throw new Error("could not find the prompt at its expected argv position — refusing to risk it leaking into the worker's argv");
        }
        execArgv = [remote.bin || defaultBin || "claude", ...execArgv];
      }
      const runsDir = remoteRunsDir(remote, stateKey);
      const safeRunId = safePart(runId);
      const pgidFile = `${runsDir}/${safeRunId}.pgid`;
      const promptPipe = `${runsDir}/${safeRunId}.pipe`;
      // `raw` (a gate, #710) skips both verdict paths: `verdictDir` on the worker is left
      // untouched by the launcher, and `sandboxVerdictPathFor` is never called on the hub side —
      // calling it again would `rmSync` the dir that already holds the agent's copied-back
      // verdict out from under it.
      const verdictDir = raw ? undefined : remoteVerdictDir(remote, stateKey, ref, stepId);
      const hubVerdictFile = raw ? undefined : spawnPaths.sandboxVerdictPathFor(stepId, ref);
      // Per-run config dir (#739): only created/written/removed when an AgentAdapter.remote hook
      // actually returned files (opencode) — a plain claude run never touches it.
      const hasFiles = !raw && Array.isArray(files) && files.length > 0;
      const configDir = hasFiles ? remoteConfigDir(remote, stateKey, ref, stepId) : undefined;
      // The agent's own cwd: the worker path `paths()` already computed (worktree or export
      // dir) when a caller goes through step.js. A launch() with no `hub` (this module's own
      // low-level tests) skips the sync entirely and just cds into whatever `cwd` it was given.
      const workDir = cwd || remote.workDir;
      const gitPath = hub ? remoteRepoGitPath(remote, stateKey, hub.repoId) : undefined;
      const beforeSha = hub ? await syncBefore(cfg, remote, stateKey, hub, workDir) : undefined;
      const script = launcherScript({ workDir, runsDir, pgidFile, promptPipe, verdictDir, configDir, hasFiles, execArgv, resume: !raw && !!resume });
      return {
        bin: "ssh",
        args: [...sshBaseArgs(remote), shQuote("sh"), shQuote("-c"), shQuote(script)],
        env: /** @type {Record<string, string>} */ (process.env.SSH_AUTH_SOCK ? { SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK } : {}),
        id: safeRunId,
        stdin: framePayload(remoteEnvAllowlist(env, raw ? {} : remoteEnv), prompt, hasFiles ? files : []),
        kill: async () => {
          await runRemote(remote, killScript(pgidFile));
        },
        done: async () => {
          // A `raw` run (a gate, #710) never reads or writes a verdict — `verdictDir`/
          // `hubVerdictFile` are undefined for it — and never fetches code back; its edits, if
          // any, are discarded. It only cleans up the worker worktree/export dir.
          if (raw) {
            await cleanupWorker(remote, gitPath, workDir, hub);
            return {};
          }
          // Belt-and-suspenders (#739): the launcher script already removes `configDir` itself
          // once the agent exits, but a hard-dropped connection could leave the script's own
          // cleanup unreached — best-effort, same as the worktree/export removal below.
          if (configDir) await runRemote(remote, `rm -rf ${shQuote(configDir)}`);
          const resolvedHubVerdictFile = /** @type {string} */ (hubVerdictFile);
          const buf = await runRemote(remote, `head -c ${MAX_SANDBOX_VERDICT_BYTES + 1} ${shQuote(`${verdictDir}/verdict.json`)} 2>/dev/null`, { maxBuffer: MAX_SANDBOX_VERDICT_BYTES + 2 });
          if (buf && buf.length > 0 && buf.length <= MAX_SANDBOX_VERDICT_BYTES) {
            try {
              fs.mkdirSync(path.dirname(resolvedHubVerdictFile), { recursive: true });
              fs.writeFileSync(resolvedHubVerdictFile, buf);
            } catch (e) {
              console.error(`[ssh] verdict copy-back write failed for ${resolvedHubVerdictFile}: ${e.message}`);
            }
          }
          // The outbox (#825): the only two known names, each over the same ssh channel with the
          // same `head -c cap+1` over-cap=drop rule as the verdict. The remote side refuses a
          // symlinked outbox dir and a symlink/non-regular entry (`-f` is false for a FIFO, and
          // the `-L` check is belt-and-suspenders behind it) BEFORE opening anything, so a
          // planted FIFO can never block the copy-back; `head` never writes past the cap. The
          // hub's own lstat refusal + field caps happen in readOutbox (src/dispatch/outbox.js).
          // Absent outbox is the normal case — nothing copied, nothing logged.
          for (const name of OUTBOX_FILE_NAMES) {
            const outboxDir = `${verdictDir}/outbox`;
            const f = `${outboxDir}/${name}`;
            const obuf = await runRemote(remote, `[ -d ${shQuote(outboxDir)} ] && [ ! -L ${shQuote(outboxDir)} ] && [ ! -L ${shQuote(f)} ] && [ -f ${shQuote(f)} ] && head -c ${OUTBOX_COPY_CAP_BYTES + 1} ${shQuote(f)}`, { maxBuffer: OUTBOX_COPY_CAP_BYTES + 2 });
            if (obuf && obuf.length > 0 && obuf.length <= OUTBOX_COPY_CAP_BYTES) {
              try {
                const dest = path.join(path.dirname(resolvedHubVerdictFile), "outbox", name);
                fs.mkdirSync(path.dirname(dest), { recursive: true });
                fs.writeFileSync(dest, obuf);
              } catch (e) {
                console.error(`[ssh] outbox copy-back write failed for outbox/${name}: ${e.message}`);
              }
            }
          }
          // Sync-back always runs (incl. after a timeout/cancel/crash), so commits made before
          // the run ended aren't stranded on the worker. A failure here never masks the verdict
          // copy-back above (already done) — it only ever adds `failed`, which step.js maps onto
          // `refused` so the run fails instead of advancing on code the hub never actually got.
          if (!hub) return {};
          try {
            return await syncAfter(cfg, remote, stateKey, hub, workDir, beforeSha);
          } catch (e) {
            return { failed: `sync-back failed: ${e.message}` };
          }
        },
      };
    },
    reap: async () => {
      const runsDir = remoteRunsDir(remote, stateKey);
      const script = [
        `for f in ${shQuote(runsDir)}/*.pgid; do`,
        `  [ -f "$f" ] || continue`,
        `  p=$(cat "$f" 2>/dev/null)`,
        `  echo "$f"`,
        `  [ -n "$p" ] && kill -KILL "-$p" 2>/dev/null`,
        `  rm -f "$f"`,
        `done`,
        // Leftover per-ref/export dirs a crashed run's done() never got to clean up (#690), plus
        // any leftover per-run config dir (#739, e.g. an opencode.json an interrupted run's
        // launcherScript cleanup never reached) — never echoed, reap()'s `runs` list is the pgid
        // names above, nothing else.
        `for d in ${shQuote(remoteWorktreesDir(remote, stateKey))}/* ${shQuote(remoteExportsDir(remote, stateKey))}/* ${shQuote(runsDir)}/*.opencode; do [ -e "$d" ] || continue; rm -rf "$d"; done`,
        `for g in ${shQuote(remoteReposDir(remote, stateKey))}/*.git; do [ -d "$g" ] || continue; git -C "$g" worktree prune; done`,
      ].join("\n");
      const buf = await runRemote(remote, script);
      const runs = buf
        ? buf.toString("utf8").split("\n").filter(Boolean).map((f) => safePart(path.basename(f, ".pgid")))
        : [];
      return { containers: [], networks: [], runs };
    },
  };
}

/**
 * One `ssh` executor per harness that declares a `remote` block, keyed by harness name; `{}`
 * when none do. @param {{cfg?: Pick<import('../types.js').Config, 'stateKey'|'harnesses'|'sandbox'>, spawnPaths?: {sandboxVerdictPathFor: (stepId: string, ref: string) => string}}} o
 * @returns {Record<string, import('../types.js').Executor>} */
export function createSshExecutors({ cfg, spawnPaths }) {
  /** @type {Record<string, import('../types.js').Executor>} */
  const out = {};
  if (!cfg?.harnesses || !spawnPaths) return out;
  for (const [name, h] of Object.entries(cfg.harnesses)) {
    if (h.remote) out[name] = createSshExecutor({ stateKey: cfg.stateKey, remote: h.remote, spawnPaths, cfg });
  }
  return out;
}
