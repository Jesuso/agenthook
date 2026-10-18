// `agenthook doctor` — preflight a profile before you trust it. Loads the config,
// then checks the things that silently break a run: missing token, repoPath not a
// git repo, agent/tunnel binaries absent, port already taken, ingress misconfigured.
// Multi-repo profiles also get routing lints; ⚠ warnings print but don't fail the run.
// (Duplicate repo ids / paths / route keys and >1 default are already fatal in loadConfig.)
// `--fix` applies the safe, local, idempotent fixes a ✗/⚠ check carries, then re-checks.
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import { portInUse } from "../port.js";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { loadConfig, ensurePrivateDir } from "../config.js";
import { worktreeDir } from "../paths.js";
import { reposOf, defaultRepo } from "../repos.js";
import { listWorktrees } from "../worktree.js";
import { readProfile, isAlive, instructionTargets } from "../heartbeat.js";
import { systemdScopeAvailable, classifyCgroup } from "../respawn.js";
import { fileURLToPath } from "node:url";
import { agentFor } from "../agents/index.js";
import { hermesSourceHome, hermesProviderInfo } from "../agents/hermes-home.js";
import { uiBundleState } from "../ui-bundle.js";
import { isAppAuth, normalizePem, createGithubAuth } from "../github-auth.js";

const UI_SRC_DIR = fileURLToPath(new URL("../../ui/src/", import.meta.url));
const UI_DIST_DIR = fileURLToPath(new URL("../../ui/dist/", import.meta.url));

/** @param {string} bin */
function onPath(bin) {
  const r = spawnSync(process.platform === "win32" ? "where" : "which", [bin], { encoding: "utf8" });
  return r.status === 0;
}

/** The distinct agent binaries the pipeline spawns, resolved exactly like dispatch
 * (`step.bin || agent.defaults.bin || cfg.claudeBin`) for every non-manual step, each with
 * its agent and the step ids that use it — doctor checks each is on PATH. Pure.
 * @param {Pick<import('../types.js').Config, 'claudeBin'|'agent'|'pipeline'>} cfg
 * @returns {{ bin: string, agent: string, steps: string[] }[]} */
export function agentBinChecks(cfg) {
  /** @type {Map<string, { bin: string, agent: string, steps: string[] }>} */
  const byKey = new Map();
  for (const s of cfg.pipeline ?? []) {
    if (s.manual) continue;
    const agent = agentFor(cfg, s);
    const bin = s.bin || agent.defaults.bin || cfg.claudeBin;
    const name = agent.describe().name;
    const key = `${name}\0${bin}`;
    const group = byKey.get(key) ?? { bin, agent: name, steps: [] };
    group.steps.push(s.id);
    byKey.set(key, group);
  }
  return [...byKey.values()];
}

/** Per-step agent lints that pass loadConfig yet weaken the pipeline. Pure (config only).
 * Today: a text-only agent (no structured stream — hermes) with `requireVerdict: false`
 * set explicitly, so a run that wrote no verdict file advances unchecked.
 * @param {Pick<import('../types.js').Config, 'agent'|'pipeline'>} cfg
 * @returns {{ level: 'warn', label: string, note: string }[]} */
export function agentLints(cfg) {
  /** @type {{ level: 'warn', label: string, note: string }[]} */
  const out = [];
  for (const s of cfg.pipeline ?? []) {
    if (s.manual || s.requireVerdict !== false) continue;
    const d = agentFor(cfg, s).describe();
    if (d.stdout !== "text") continue;
    out.push({ level: "warn", label: `step "${s.id}" requires a verdict`, note: `${d.name} output is plain text — with requireVerdict:false a run that wrote no verdict file advances` });
  }
  return out;
}

/** Isolated hermes steps (the default) whose run would fail for want of credentials: the
 * source `config.yaml` an isolated home copies is missing, or the step's provider (step →
 * cfg.agentProvider → config.yaml `model.provider`) is not a local `providers:` entry.
 * Pure given `readFile` (returns the text, or null when missing); an undecidable provider
 * stays silent, like the run's own fail-open check.
 * @param {Pick<import('../types.js').Config, 'agent'|'pipeline'|'agentProvider'>} cfg
 * @param {{sourceHome: string, readFile: (file: string) => string|null}} io
 * @returns {{ level: 'warn', label: string, note: string }[]} */
export function hermesLints(cfg, { sourceHome, readFile }) {
  /** @type {{ level: 'warn', label: string, note: string }[]} */
  const out = [];
  const file = path.join(sourceHome, "config.yaml");
  /** @type {string|null|undefined} */
  let text;
  for (const s of cfg.pipeline ?? []) {
    if (s.manual || s.isolated === false || s.env?.HERMES_HOME || agentFor(cfg, s).describe().name !== "hermes") continue;
    if (text === undefined) text = readFile(file);
    const label = `step "${s.id}" isolated hermes home`;
    if (text === null) {
      out.push({ level: "warn", label, note: `${file} is missing — the run will fail; create it or set isolated:false` });
      continue;
    }
    const { effective, local } = hermesProviderInfo(text, s.provider ?? cfg.agentProvider);
    if (local === false) out.push({ level: "warn", label, note: `provider "${effective}" is not a local providers: entry in ${file} — an isolated run has no credentials; use a local provider or set isolated:false` });
  }
  return out;
}

/** Pipeline step bindings (the source-, success-, failure-, hold-prefixed keys)
 * left empty or still an `init` `TODO_*` placeholder. These pass every other
 * check yet match no incoming event, so the receiver silently does nothing — the
 * common first-run trap. Returns `step.id.key` per offender (absent optional
 * bindings are fine).
 * @param {import('../types.js').Step[]|null} pipeline */
export function unfilledBindings(pipeline) {
  /** @type {string[]} */
  const out = [];
  for (const step of pipeline || []) {
    for (const [k, v] of Object.entries(step)) {
      if (/^(source|success|failure|hold)/.test(k) && typeof v === "string" && (v.trim() === "" || v.startsWith("TODO_"))) {
        out.push(`${step.id}.${k}`);
      }
    }
  }
  return out;
}

/** Pre-`repos` worktrees (`<base>/<safeRef>`, depth 1 under the repo's worktree base).
 * Multi-repo paths nest one level deeper (`<base>/<repo.id>/<ref>`), so these are
 * orphans left from before `repos` was declared.
 * @param {import('../types.js').Config} cfg @param {import('../types.js').RepoConfig} repo
 * @param {string[]} worktreePaths  e.g. listWorktrees(repo.path).map((w) => w.path) */
export function legacyOrphans(cfg, repo, worktreePaths) {
  if (!cfg.multiRepo) return [];
  const base = worktreeDir(cfg, repo);
  return worktreePaths.filter((p) => path.dirname(p) === base);
}

/** Multi-repo routing lints that pass loadConfig yet leave tickets unroutable or
 * unparkable. Pure (config only). Empty for single-repo profiles.
 * @param {import('../types.js').Config} cfg
 * @returns {{ level: 'fail'|'warn', label: string, note?: string }[]} problems only */
export function repoLints(cfg) {
  /** @type {{ level: 'fail'|'warn', label: string, note?: string }[]} */
  const out = [];
  if (!cfg.multiRepo) return out;
  const repos = reposOf(cfg);
  if (repos.length > 1 && !cfg.providerConfig?.routeField) {
    out.push({ level: "fail", label: "tracker.routeField set", note: `${repos.length} repos but no routeField — nothing can ever route` });
  }
  if (!defaultRepo(cfg)) {
    out.push({ level: "warn", label: "a default repo is set", note: "none — every unrouted ticket will HOLD (mark one repo default:true)" });
  }
  const noHold = (cfg.pipeline || [])
    .filter((s) => !s.manual && !Object.entries(s).some(([k, v]) => k.startsWith("hold") && typeof v === "string" && v.trim()))
    .map((s) => s.id);
  if (noHold.length) {
    out.push({ level: "warn", label: "steps have a hold binding", note: `${noHold.join(", ")} — routing errors have nowhere to park` });
  }
  return out;
}

/** Warn when a `github` tracker has no forge block — merge/CI events never arrive
 * and the event-driven loop quietly falls back to polling — or when a `gitlab` forge
 * block is missing what it needs. Pure (config only).
 * @param {import('../types.js').Config} cfg
 * @returns {{level: 'warn', label: string, note: string}[]} */
export function forgeLints(cfg) {
  if (cfg.forge?.type === "gitlab") return gitlabForgeLints(cfg.forge);
  if (cfg.provider !== "github" || cfg.forge) return [];
  return [{ level: "warn", label: "forge configured", note: "no forge block — merge/CI events will not arrive" }];
}

/** A `gitlab` forge needs a `group/project` path, a token, and an http(s) base URL. Pure.
 * @param {import('../types.js').ForgeConfig} fc
 * @returns {{level: 'warn', label: string, note: string}[]} */
function gitlabForgeLints(fc) {
  /** @type {{level: 'warn', label: string, note: string}[]} */
  const out = [];
  const project = typeof fc.project === "string" ? fc.project.trim() : "";
  if (!project.includes("/")) {
    out.push({ level: "warn", label: "forge.project set", note: project ? `"${project}" is not group/project` : "gitlab forge has no forge.project (group/sub/project)" });
  }
  const token = typeof fc.token === "string" ? fc.token.trim() : "";
  if (!token || /\$\{[^}]*\}/.test(token)) {
    out.push({ level: "warn", label: "forge.token set", note: "gitlab forge token is empty or unresolved — set it (e.g. ${GITLAB_TOKEN})" });
  }
  if (fc.baseUrl != null && !/^https?:\/\/[^/\s]+/.test(String(fc.baseUrl))) {
    out.push({ level: "warn", label: "forge.baseUrl is an http(s) URL", note: `"${fc.baseUrl}"` });
  }
  return out;
}

/** The ingress preflight: a managed tunnel needs its binary on PATH (cloudflared also both or
 * neither of tunnel/hostname); tailscale needs only its CLI; a static ingress needs ingress.url.
 * @param {import('../types.js').IngressConfig} ingress @param {(bin: string) => boolean} [has]
 * @returns {{ ok: boolean, label: string, note?: string, manual: string }[]} */
export function ingressChecks(ingress, has = onPath) {
  if (ingress.type === "ngrok") return [{ ok: has(process.env.NGROK || "ngrok"), label: "ngrok binary on PATH", manual: "install ngrok or put it on PATH (or set $NGROK)" }];
  if (ingress.type === "tailscale") return [{ ok: has(process.env.TAILSCALE || "tailscale"), label: "tailscale binary on PATH", manual: "install tailscale or put it on PATH (or set $TAILSCALE)" }];
  if (ingress.type === "cloudflared") {
    /** @type {{ ok: boolean, label: string, note?: string, manual: string }[]} */
    const checks = [{ ok: has(process.env.CLOUDFLARED || "cloudflared"), label: "cloudflared binary on PATH", manual: "install cloudflared or put it on PATH (or set $CLOUDFLARED)" }];
    if (ingress.tunnel || ingress.hostname) {
      const ok = !!ingress.tunnel && !!ingress.hostname;
      checks.push({ ok, label: "cloudflared named tunnel: tunnel + hostname both set", note: ok ? "" : `missing ingress.${ingress.tunnel ? "hostname" : "tunnel"}`, manual: "set both ingress.tunnel and ingress.hostname, or neither for a quick tunnel" });
    }
    return checks;
  }
  return [{ ok: !!ingress.url, label: `ingress.url set (${ingress.type})`, note: ingress.url || "missing", manual: "set ingress.url in the config" }];
}

/** Whether a busy port is this profile's own receiver (info, not a problem) or a real
 * conflict (fail). Pure.
 * @param {{ port: number, busy: boolean, profile: { up: boolean, pid: number, heartbeatPort?: number|null } }} args
 * @returns {{ level: 'ok'|'info'|'fail', label: string, note?: string }} */
export function portCheck({ port, busy, profile }) {
  if (!busy) return { level: "ok", label: `port ${port} is free` };
  if (profile.up && (profile.heartbeatPort == null || profile.heartbeatPort === port)) {
    return { level: "info", label: `port ${port} is in use by this profile's receiver (pid ${profile.pid})` };
  }
  return { level: "fail", label: `port ${port} is free`, note: "something is already listening" };
}

/** A check's remedy: a safe local fix (`describe` is its `--dry-run` text) or the manual
 * action for a problem that is never auto-fixed. Only ✗/⚠ checks carry one.
 * @typedef {{ describe: string, apply: () => void|Promise<void> } | { manual: string }} Fix */
/** @typedef {{ ok: boolean, warn?: boolean, info?: boolean, label: string, note?: string, fix?: Fix }} Check */
/** A detector's problem. @typedef {{ level: 'fail'|'warn', label: string, note?: string, fix?: Fix }} Finding */
/** The child-process seam for the two fixers that shell out (tests inject a recorder).
 * @typedef {(cmd: string, args: string[], opts: {cwd?: string, stdio?: any}) => { status: number|null }} Spawner */

/** A pidfile's raw text and pid (0 when unparsable); null when absent/unreadable. @param {string} file */
function readPidFile(file) {
  try {
    const text = fs.readFileSync(file, "utf8");
    return { text, pid: Number(text.trim()) || 0 };
  } catch {
    return null;
  }
}

/** The state dir exists but group/other can read it (POSIX only) — run logs, verdicts and
 * the control socket live there. A missing dir is not a problem (boot creates it 0700).
 * @param {Pick<import('../types.js').Config, 'stateDir'>} cfg @param {{platform?: string}} [io]
 * @returns {Finding[]} */
export function stateDirLints(cfg, { platform = process.platform } = {}) {
  if (platform === "win32" || !fs.existsSync(cfg.stateDir)) return [];
  const mode = fs.statSync(cfg.stateDir).mode & 0o777;
  if (!(mode & 0o077)) return [];
  return [
    {
      level: "warn",
      label: "state dir is private (0700)",
      note: `mode 0${mode.toString(8)} — group/other can read it`,
      fix: { describe: `chmod 0700 ${cfg.stateDir}`, apply: () => void ensurePrivateDir(cfg.stateDir, { tighten: true }) },
    },
  ];
}

/** A pidfile whose pid is not alive: the receiver died without cleaning up. The fix removes
 * it only if it still holds the same content (a receiver booting meanwhile rewrites it).
 * @param {Pick<import('../types.js').Config, 'pidFile'>} cfg @param {{isAlive?: (pid: number) => boolean}} [io]
 * @returns {Finding[]} */
export function pidfileLints(cfg, { isAlive: alive = isAlive } = {}) {
  const rec = readPidFile(cfg.pidFile);
  if (!rec || alive(rec.pid)) return [];
  return [
    {
      level: "warn",
      label: "stale pidfile",
      note: `${cfg.pidFile} names pid ${rec.pid || "?"}, which is not running`,
      fix: {
        describe: `remove ${cfg.pidFile}`,
        apply: () => {
          if (readPidFile(cfg.pidFile)?.text !== rec.text) throw new Error("the pidfile changed — a receiver may be starting; re-run doctor");
          fs.rmSync(cfg.pidFile, { force: true });
        },
      },
    },
  ];
}

/** Connect to a unix socket: `open` (something listens), `dead` (ECONNREFUSED/ENOENT — no
 * listener), `unknown` (any other error or no answer within `timeoutMs`).
 * @param {string} sock @param {number} [timeoutMs] @returns {Promise<'open'|'dead'|'unknown'>} */
export function probeSocket(sock, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const s = net.connect(sock);
    /** @param {'open'|'dead'|'unknown'} r */
    const done = (r) => {
      s.destroy();
      resolve(r);
    };
    s.once("connect", () => done("open"));
    s.once("error", (/** @type {any} */ e) => done(e.code === "ECONNREFUSED" || e.code === "ENOENT" ? "dead" : "unknown"));
    s.setTimeout(timeoutMs, () => done("unknown"));
  });
}

/** A leftover `control.sock` (POSIX only): present, no live pid in the pidfile, AND nothing
 * accepts a connect. A dead pid alone is not proof — a booting receiver listens on the socket
 * before it writes its pidfile. The fix re-probes before removing it.
 * @param {Pick<import('../types.js').Config, 'pidFile'|'controlSock'>} cfg
 * @param {{isAlive?: (pid: number) => boolean, probe?: (sock: string) => Promise<'open'|'dead'|'unknown'>, platform?: string}} [io]
 * @returns {Promise<Finding[]>} */
export async function controlSockLints(cfg, { isAlive: alive = isAlive, probe = probeSocket, platform = process.platform } = {}) {
  if (platform === "win32" || !fs.existsSync(cfg.controlSock)) return [];
  if (alive(readPidFile(cfg.pidFile)?.pid ?? 0)) return [];
  if ((await probe(cfg.controlSock)) !== "dead") return [];
  return [
    {
      level: "warn",
      label: "stale control socket",
      note: `${cfg.controlSock} has no listener`,
      fix: {
        describe: `remove ${cfg.controlSock}`,
        apply: async () => {
          if ((await probe(cfg.controlSock)) !== "dead") throw new Error("something now listens on it — a receiver may be starting");
          fs.rmSync(cfg.controlSock, { force: true });
        },
      },
    },
  ];
}

/** Step/default/repo instruction files that don't exist — a run reads them as "" and goes
 * with no standing instructions, silently. The fix copies the packaged template in, never
 * overwriting (`wx`; EEXIST counts as fixed). The Digest's SOUL file is out of scope.
 * @param {import('../types.js').Config} cfg @returns {Finding[]} */
export function instructionLints(cfg) {
  const template = path.join(cfg.installDir, "INSTRUCTIONS.example.md");
  /** @type {Finding[]} */
  const out = [];
  for (const t of instructionTargets(cfg)) {
    if (t.scope === "soul" || fs.existsSync(t.path)) continue;
    out.push({
      level: "warn", // a warning, not a ✗: configs that ran this way before must not start failing doctor
      label: `instructions file exists: ${t.path}`,
      note: `missing — ${t.scope === "repo" ? "repo" : "step"} ${t.ids.join(", ")} would run with empty standing instructions`,
      fix: {
        describe: `create ${t.path} from INSTRUCTIONS.example.md`,
        apply: () => {
          const text = fs.readFileSync(template);
          fs.mkdirSync(path.dirname(t.path), { recursive: true });
          try {
            fs.writeFileSync(t.path, text, { flag: "wx" });
          } catch (e) {
            if (e.code !== "EEXIST") throw e;
          }
        },
      },
    });
  }
  return out;
}

/** The existing UI-bundle warning (checkout only — an npm install is `no-src`), with
 * `npm run build:ui` in the install dir as its fix.
 * @param {{state: string, newest?: string}} bundle @param {{installDir: string, spawn?: Spawner}} io
 * @returns {Finding[]} */
export function uiBundleLints(bundle, { installDir, spawn = spawnSync }) {
  /** @type {Fix} */
  const fix = {
    describe: `run \`npm run build:ui\` in ${installDir}`,
    apply: () => {
      const r = spawn("npm", ["run", "build:ui"], { cwd: installDir, stdio: "inherit" });
      if (r.status !== 0) throw new Error(`run \`npm run build:ui\` in ${installDir}`);
    },
  };
  if (bundle.state === "missing") return [{ level: "warn", label: "UI bundle built", note: "ui/dist missing — run `npm run build:ui`", fix }];
  if (bundle.state === "stale") return [{ level: "warn", label: "UI bundle up to date", note: `${bundle.newest} is newer than ui/dist — run \`npm run build:ui\``, fix }];
  return [];
}

/** Per git repo: a missing worktree base (fix: create it), and worktrees git reports as
 * prunable under that base (fix: `git worktree prune`, which only drops git's admin entries
 * for already-deleted dirs — branches and commits stay). Repos without `.git` are skipped
 * (doctor already fails them).
 * @param {import('../types.js').Config} cfg
 * @param {{listWorktrees?: (repoPath: string) => { path: string, prunable?: boolean }[], spawn?: Spawner}} [io]
 * @returns {Finding[]} */
export function worktreeLints(cfg, { listWorktrees: list = listWorktrees, spawn = spawnSync } = {}) {
  /** @type {Finding[]} */
  const out = [];
  const seenBase = new Set();
  for (const repo of reposOf(cfg)) {
    if (!fs.existsSync(path.join(repo.path, ".git"))) continue;
    const base = worktreeDir(cfg, repo);
    const who = cfg.multiRepo ? ` for "${repo.id}"` : "";
    if (!seenBase.has(base) && !fs.existsSync(base)) {
      out.push({ level: "warn", label: `worktree base exists${who}: ${base}`, note: "missing", fix: { describe: `mkdir -p ${base}`, apply: () => void fs.mkdirSync(base, { recursive: true }) } });
    }
    seenBase.add(base);
    /** @type {string[]} */
    let prunable;
    try {
      prunable = list(repo.path)
        .filter((w) => w.prunable && w.path.startsWith(base + path.sep))
        .map((w) => w.path);
    } catch {
      continue;
    }
    if (!prunable.length) continue;
    const argv = ["-C", repo.path, "worktree", "prune"];
    out.push({
      level: "warn",
      label: `prunable worktrees${who}`,
      note: `${prunable.join(", ")} — dir gone, git still lists it`,
      fix: {
        describe: `git ${argv.join(" ")}`,
        apply: () => {
          const r = spawn("git", argv, { stdio: "ignore" });
          if (r.status !== 0) throw new Error(`\`git ${argv.join(" ")}\` exited ${r.status}`);
        },
      },
    });
  }
  return out;
}

/** GitHub App auth preflight for one config block (`tracker` or `forge`), in place of the token
 * check: the private key parses, an installation token is fetchable (one live call), and — for
 * the tracker — `assigneeLogin` (the human the App acts for) is set.
 * @param {{auth?: import('../types.js').GithubAuthConfig, assigneeLogin?: string}} block
 * @param {'tracker'|'forge'} at @param {{fetch?: typeof fetch}} [io] @returns {Promise<Check[]>} */
export async function githubAppChecks(block, at, { fetch: f } = {}) {
  const auth = /** @type {import('../types.js').GithubAuthConfig} */ (block.auth);
  /** @type {Check[]} */
  const out = [];
  let keyOk = false;
  let keyNote = "";
  try {
    crypto.createPrivateKey(normalizePem(auth.privateKey || ""));
    keyOk = true;
  } catch (e) {
    keyNote = e?.message ?? String(e);
  }
  out.push({ ok: keyOk, label: `${at} GitHub App private key parses (app ${auth.appId})`, note: keyNote, fix: { manual: `set ${at}.auth.privateKey to the App's PEM (a \${VAR} ref; literal \\n is fine) or ${at}.auth.privateKeyPath to the .pem file` } });
  if (keyOk) {
    let tokOk = false;
    let tokNote = "";
    try {
      await createGithubAuth(block, f ? { fetch: f } : {}).header();
      tokOk = true;
    } catch (e) {
      tokNote = e?.message ?? String(e);
    }
    out.push({ ok: tokOk, label: `${at} GitHub App installation token fetchable (installation ${auth.installationId})`, note: tokNote, fix: { manual: `check ${at}.auth.appId / installationId and that the App is installed on the repo/org (see docs/github-app.md)` } });
  }
  if (at === "tracker") {
    const login = typeof block.assigneeLogin === "string" ? block.assigneeLogin.trim() : "";
    out.push({ ok: !!login, label: `tracker.assigneeLogin set (the human the App acts for)`, note: login || "missing", fix: { manual: "set tracker.assigneeLogin to your GitHub login" } });
  }
  return out;
}

/** The env var the raw config's `tracker.token` references (`${VAR}`), for the remedy text.
 * @param {string} configPath @returns {string|null} */
export function tokenVar(configPath) {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
    return /\$\{(\w+)\}/.exec(String(raw?.tracker?.token ?? raw?.token ?? ""))?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Doctor's side-effecting probes, overridable for tests.
 * @typedef {{
 *   onPath?: (bin: string) => boolean,
 *   portInUse?: (port: number) => Promise<boolean>,
 *   isAlive?: (pid: number) => boolean,
 *   probe?: (sock: string) => Promise<'open'|'dead'|'unknown'>,
 *   spawn?: Spawner,
 *   listWorktrees?: (repoPath: string) => { path: string, branch: string, prunable?: boolean }[],
 *   uiBundle?: () => {state: 'no-src'|'missing'|'stale'|'fresh', newest?: string},
 *   platform?: string,
 *   fetch?: typeof fetch,
 * }} DoctorIo */

/** Run every check against a loaded config; prints nothing.
 * @param {import('../types.js').Config} cfg @param {DoctorIo} [io] @returns {Promise<Check[]>} */
export async function runChecks(cfg, io = {}) {
  const {
    onPath: have = onPath,
    portInUse: busyPort = portInUse,
    isAlive: alive = isAlive,
    probe = probeSocket,
    spawn = spawnSync,
    listWorktrees: list = listWorktrees,
    uiBundle = () => uiBundleState({ srcDir: UI_SRC_DIR, distDir: UI_DIST_DIR }),
    platform = process.platform,
    fetch: f,
  } = io;
  /** @type {Check[]} */
  const checks = [];
  /** @param {boolean} ok @param {string} label @param {string} [note] @param {Fix} [fix] */
  const add = (ok, label, note, fix) => checks.push({ ok, label, note, fix });
  /** A ⚠ line: shown, but not counted as a problem. @param {string} label @param {string} [note] @param {Fix} [fix] */
  const warn = (label, note, fix) => checks.push({ ok: true, warn: true, label, note, fix });
  /** An ℹ line: informational only, never carries a fix. @param {string} label @param {string} [note] */
  const info = (label, note) => checks.push({ ok: true, info: true, label, note });
  /** @param {Finding} f */
  const finding = (f) => (f.level === "fail" ? add(false, f.label, f.note, f.fix) : warn(f.label, f.note, f.fix));

  add(true, `config loaded: ${cfg.configPath}`);
  if (fs.existsSync(cfg.stateDir)) add(true, `profile "${cfg.name}" — state ${cfg.stateDir}`);
  else info(`profile "${cfg.name}" — state dir not created yet (profile never started)`, cfg.stateDir);
  stateDirLints(cfg, { platform }).forEach(finding);
  pidfileLints(cfg, { isAlive: alive }).forEach(finding);
  (await controlSockLints(cfg, { isAlive: alive, probe, platform })).forEach(finding);

  const profile = readProfile(cfg.stateKey);

  if (cfg.provider === "local") info("local tracker — no token needed");
  else if (isAppAuth(cfg.providerConfig)) checks.push(...(await githubAppChecks(cfg.providerConfig, "tracker", { fetch: f })));
  else {
    const v = tokenVar(cfg.configPath);
    add(!!cfg.providerConfig.token, `tracker token resolved (${cfg.provider})`, cfg.providerConfig.token ? "" : "empty — check the ${ENV} ref", { manual: v ? `set ${v} in .env (or the env), then re-run doctor` : "set tracker.token to a ${VAR} ref, set that VAR in .env (or the env), then re-run doctor" });
  }

  for (const repo of reposOf(cfg)) {
    const isGit = fs.existsSync(path.join(repo.path, ".git"));
    const label = cfg.multiRepo ? `repo "${repo.id}" is a git repo: ${repo.path}` : `repoPath is a git repo: ${repo.path}`;
    add(isGit, label, isGit ? "" : "no .git found", { manual: `point ${cfg.multiRepo ? `repo "${repo.id}"'s path` : "repoPath"} at a git checkout (or \`git init\` it)` });
  }
  for (const l of repoLints(cfg)) {
    if (l.level === "fail") add(false, l.label, l.note, { manual: "set tracker.routeField in the config to the field that names each ticket's repo" });
    else warn(l.label, l.note);
  }
  if (cfg.multiRepo) {
    for (const repo of reposOf(cfg)) {
      /** @type {string[]} */
      let paths;
      try {
        paths = list(repo.path).map((w) => w.path);
      } catch {
        continue; // not a git repo — already flagged above
      }
      const orphans = legacyOrphans(cfg, repo, paths);
      if (orphans.length) warn(`legacy worktrees in "${repo.id}"`, `${orphans.join(", ")} — pre-repos layout; finish or drain them, then \`agenthook cleanup\``);
    }
  }
  instructionLints(cfg).forEach(finding);

  const binChecks = agentBinChecks(cfg);
  for (const { bin, agent, steps } of binChecks) add(have(bin), `${agent} binary on PATH: ${bin} (steps: ${steps.join(", ")})`, undefined, { manual: `install ${bin} or put it on PATH` });
  // No step spawns claudeBin, but the on-demand Digest still does — missing it is a warning only.
  if (!binChecks.some((c) => c.bin === cfg.claudeBin) && !have(cfg.claudeBin)) {
    warn(`claude binary on PATH: ${cfg.claudeBin}`, "not found — no step uses it, but the Digest does");
  }
  for (const l of agentLints(cfg)) warn(l.label, l.note);
  const readFile = (/** @type {string} */ f) => {
    try {
      return fs.readFileSync(f, "utf8");
    } catch {
      return null;
    }
  };
  for (const l of hermesLints(cfg, { sourceHome: hermesSourceHome(), readFile })) warn(l.label, l.note);

  for (const c of ingressChecks(cfg.ingress, have)) add(c.ok, c.label, c.note, { manual: c.manual });

  const busy = await busyPort(cfg.port);
  const pc = portCheck({ port: cfg.port, busy, profile: { up: profile.up, pid: profile.pid, heartbeatPort: profile.heartbeat?.port } });
  if (pc.level === "info") info(pc.label, pc.note);
  else add(pc.level === "ok", pc.label, pc.note, { manual: `stop whatever listens on port ${cfg.port}, or set a different "port" in the config` });

  const unfilled = unfilledBindings(cfg.pipeline);
  add(!unfilled.length, "pipeline bindings filled", unfilled.length ? `unfilled/placeholder: ${unfilled.join(", ")}` : "", { manual: `fill ${unfilled.join(", ")} in the config with real tracker stages` });

  for (const l of forgeLints(cfg)) warn(l.label, l.note);
  if (cfg.forge?.type === "github" && isAppAuth(cfg.forge)) checks.push(...(await githubAppChecks(cfg.forge, "forge", { fetch: f })));

  uiBundleLints(uiBundle(), { installDir: cfg.installDir, spawn }).forEach(finding);
  worktreeLints(cfg, { listWorktrees: list, spawn }).forEach(finding);

  if (platform === "linux") {
    const scopeOn = systemdScopeAvailable();
    info(`start --detach will use a systemd user scope: ${scopeOn}`, process.env.AGENTHOOK_NO_SYSTEMD_SCOPE === "1" ? "AGENTHOOK_NO_SYSTEMD_SCOPE=1 disables it" : "");
    if (profile.up) {
      try {
        const { scope, terminal } = classifyCgroup(fs.readFileSync(`/proc/${profile.pid}/cgroup`, "utf8"));
        if (scope) {
          info(`scope: ${scope}`);
          if (terminal) warn("receiver scope", "will die with this terminal — restart it with `agenthook restart` or `start --detach` (now scope-escaping)");
        }
      } catch {
        /* /proc unreadable — not fatal */
      }
    }
  }
  return checks;
}

/** A ✗ or ⚠ check (ℹ and ✓ lines are never problems). @param {Check} c */
const isProblem = (c) => !c.info && (!c.ok || !!c.warn);
/** @param {Fix|undefined} fix @returns {fix is { describe: string, apply: () => void|Promise<void> }} */
const autoFix = (fix) => !!fix && "apply" in fix;

/** How many ✗/⚠ checks `--fix` can repair. @param {Check[]} checks */
export const fixableCount = (checks) => checks.filter((c) => isProblem(c) && autoFix(c.fix)).length;

/** Apply (or under `dryRun`, plan) every problem's fix in check order, one line each:
 * `fixed:`, `would fix:`, or `can't fix:` (manual-only, or `apply` threw — never aborts the rest).
 * @param {Check[]} checks @param {{dryRun?: boolean, log?: (line: string) => void}} [opts]
 * @returns {Promise<string[]>} the printed lines */
export async function applyFixes(checks, { dryRun = false, log = console.log } = {}) {
  /** @type {string[]} */
  const lines = [];
  /** @param {string} l */
  const say = (l) => (lines.push(l), log(l));
  for (const c of checks) {
    if (!isProblem(c) || !c.fix) continue;
    const fix = c.fix;
    if (!autoFix(fix)) say(`can't fix: ${c.label} — ${"manual" in fix ? fix.manual : ""}`);
    else if (dryRun) say(`would fix: ${c.label} — ${fix.describe}`);
    else {
      try {
        await fix.apply();
        say(`fixed: ${c.label}`);
      } catch (e) {
        say(`can't fix: ${c.label} — ${e?.message ?? e}`);
      }
    }
  }
  return lines;
}

/** Print the ✓/✗/⚠/ℹ report and summary; returns the ✗ count.
 * @param {Check[]} checks @param {{hint?: boolean, log?: (line: string) => void}} [opts] */
export function report(checks, { hint = true, log = console.log } = {}) {
  let bad = 0;
  let warned = 0;
  for (const c of checks) {
    log(`${c.info ? "ℹ" : c.warn ? "⚠" : c.ok ? "✓" : "✗"} ${c.label}${c.note ? `  — ${c.note}` : ""}`);
    if (!c.ok) bad++;
    if (c.warn) warned++;
  }
  log(bad ? `\n${bad} problem(s) found.` : warned ? `\nno problems; ${warned} warning(s).` : `\nall good.`);
  const n = fixableCount(checks);
  if (hint && n) log(`${n} can be fixed with \`agenthook doctor --fix\``);
  return bad;
}

/** @param {any} args */
export async function doctor(args) {
  const cfg = loadConfig({ configPath: args.config }); // throws (and surfaces unset ${VARs}) if broken
  if (args.fix) {
    await applyFixes(await runChecks(cfg), { dryRun: !!args["dry-run"] });
    if (args["dry-run"]) return;
    console.log("");
  }
  if (report(await runChecks(cfg), { hint: !args.fix })) process.exitCode = 1;
}
