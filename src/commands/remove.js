// `agenthook remove <name|key> [--purge] [--yes] [--keep-hooks]` — retire a profile (epic #209):
// archive its state dir ~/.agenthook/<key>/ to ~/.agenthook-archive/<key>-<stamp>/ (reversible by
// moving it back). A running receiver does it itself through a `decommission {when:'idle'}` over
// the control socket (it unregisters its webhooks, exits and archives in teardown); the CLI just
// watches the registry for the dir to go. A stopped one is archived here directly. `--purge`
// (stopped only) then deletes the archived copy. Never touches the config file and never calls
// loadConfig (it would recreate the state dir as a ghost profile).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { archiveRoot, archiveStateDir } from "../archive.js";
import { registryDir } from "../config.js";
import { resolveProfile } from "../heartbeat.js";
import { controlSockPath } from "../paths.js";
import { readMarker } from "../profile.js";
import { controlRequest } from "../ui/control-client.js";
import { listWorktrees } from "../worktree.js";

const USAGE = "usage: agenthook remove <name|key> [--purge] [--yes] [--keep-hooks]";

/** @param {string} s */
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");

/**
 * The testable core. Resolves the profile, prints what will happen, confirms, then archives
 * (directly when stopped, via a decommission when running) and optionally purges. Throws a clear
 * error on any refusal — nothing is changed in that case.
 * @param {{
 *   nameOrKey?: string, purge?: boolean, yes?: boolean, keepHooks?: boolean, registry?: string,
 *   ask?: (question: string) => Promise<string>,
 *   request?: typeof controlRequest,
 *   waitTimeoutMs?: number, graceMs?: number,
 *   log?: (msg: string) => void, error?: (msg: string) => void,
 * }} o
 * @returns {Promise<{ archivedTo: string | null, purged: boolean, state: 'archived'|'waiting'|'failed' }>}
 */
export async function removeProfile({
  nameOrKey,
  purge = false,
  yes = false,
  keepHooks = false,
  registry = registryDir,
  ask = async () => {
    throw new Error("remove: no way to prompt — pass --yes");
  },
  request = controlRequest,
  waitTimeoutMs = 10 * 60_000,
  graceMs = 2000,
  log = console.log,
  error = console.error,
}) {
  if (!nameOrKey) throw new Error(USAGE);
  const p = resolveProfile(nameOrKey, registry);
  if (!p) throw new Error(`remove: no profile "${nameOrKey}" (see \`agenthook ls\`)`);
  if (purge && p.up) {
    throw new Error(`remove: "${p.name}" is running — --purge needs a stopped receiver; run \`agenthook remove ${p.name}\` (archive) or stop it first`);
  }

  const configPath = p.heartbeat?.configPath ?? readMarker(p.dir)?.configPath ?? null;
  const root = archiveRoot(registry);
  log(`profile "${p.name}" (state key "${p.stateKey}")`);
  log(`  state dir:  ${p.dir}`);
  log(`  archive to: ${path.join(root, `${p.stateKey}-<stamp>`)}`);
  log(`  receiver:   ${p.up ? `running (pid ${p.pid}) — it archives itself once its agents finish` : "stopped"}`);
  log(`  config:     ${configPath ?? "config path unknown"} (the config file is not touched)`);
  if (purge) log("  --purge:    the archived copy is then PERMANENTLY deleted");
  if (p.up) {
    log(keepHooks ? "  webhooks:   kept (--keep-hooks)" : "  webhooks:   the receiver unregisters them before it exits");
  } else if (!keepHooks) {
    log(unregisterHint(configPath, "before removing, while the state is still in place"));
  }
  noteWorktrees(p.up ? p.heartbeat?.repos : reposFromConfig(configPath), configPath, log);

  if (!yes) {
    const answer = await ask("Type the profile name to confirm: ");
    if (String(answer).trim() !== p.name) throw new Error("remove: confirmation did not match — nothing changed");
  }

  if (p.up) {
    return waitForDecommission({ p, registry, request, keepHooks, waitTimeoutMs, graceMs, log, error });
  }

  const { archivedTo } = archiveStateDir({ stateKey: p.stateKey, registry, reason: "remove", source: "cli" });
  log(`archived ${p.dir} → ${archivedTo}`);
  if (!keepHooks) {
    log(
      `${unregisterHint(configPath, "now")} — note this recreates an empty ${path.join(registry, p.stateKey)}${path.sep} ` +
        `(\`agenthook ls\` shows it; \`agenthook remove ${p.stateKey} --yes\` archives it again) and may miss the forge hook, whose id now sits in the archive`,
    );
  }
  if (!purge) return { archivedTo, purged: false, state: "archived" };

  if (!yes) {
    const again = await ask(`Type the profile name again to PERMANENTLY delete ${archivedTo}: `);
    if (String(again).trim() !== p.name) throw new Error(`remove: confirmation did not match — archive kept at ${archivedTo}`);
  }
  if (path.dirname(archivedTo) !== root) throw new Error(`remove: refusing to delete ${archivedTo} — not directly under ${root}`);
  fs.rmSync(archivedTo, { recursive: true });
  log(`deleted ${archivedTo}`);
  return { archivedTo, purged: true, state: "archived" };
}

/** The "unregister by hand" warning for a stopped receiver. @param {string|null} configPath @param {string} when */
function unregisterHint(configPath, when) {
  const cmd = configPath ? `agenthook unregister --config ${configPath}` : "agenthook unregister --config <path> (config path unknown)";
  return `warning: the receiver is stopped, so its tracker/forge webhooks are NOT unregistered — run \`${cmd}\` ${when}`;
}

/**
 * `{path}` repos from the raw config file — JSON.parse only (no env interpolation, no
 * loadConfig, which would recreate the state dir). Best-effort: [] on any error.
 * @param {string|null} configPath @returns {{ path: string }[]}
 */
function reposFromConfig(configPath) {
  if (!configPath) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const paths = Array.isArray(raw.repos) && raw.repos.length ? raw.repos.map((/** @type {any} */ r) => r?.path) : [raw.repoPath];
    const base = path.dirname(configPath);
    return paths
      .filter((/** @type {any} */ x) => typeof x === "string" && x && !x.includes("${"))
      .map((/** @type {string} */ x) => ({ path: path.resolve(base, x.startsWith("~") ? path.join(os.homedir(), x.slice(1)) : x) }));
  } catch {
    return [];
  }
}

/** Mention leftover `agent/*` worktrees per repo. Never throws. @param {any} repos @param {string|null} configPath @param {(m: string) => void} log */
function noteWorktrees(repos, configPath, log) {
  if (!Array.isArray(repos)) return;
  for (const r of repos) {
    try {
      if (typeof r?.path !== "string") continue;
      const n = listWorktrees(r.path).filter((w) => w.branch.startsWith("agent/")).length;
      if (n > 0) log(`${n} agent/* worktree(s) in ${r.path} — prune done ones with \`agenthook cleanup --config ${configPath ?? "<path>"}\``);
    } catch {
      /* git/IO error: best-effort */
    }
  }
}

/** The newest `<key>-<stamp>` under the archive root, cross-checked against the archived
 * receiver.log's `[decommission] archived … → <to>` line. @param {string} root @param {string} stateKey */
function findArchive(root, stateKey) {
  const re = new RegExp(`^${escapeRe(stateKey)}-\\d{4}-\\d\\d-\\d\\dT\\d\\d-\\d\\d-\\d\\d$`);
  let names = [];
  try {
    names = fs.readdirSync(root).filter((n) => re.test(n)).sort();
  } catch {
    return null;
  }
  if (!names.length) return null;
  const newest = path.join(root, names[names.length - 1]);
  try {
    const logged = fs.readFileSync(path.join(newest, "receiver.log"), "utf8").match(/\[decommission\] archived .* → (.+)$/m)?.[1]?.trim();
    if (logged && logged !== newest && fs.existsSync(logged)) return logged;
  } catch {
    /* no receiver.log (e.g. not started detached) */
  }
  return newest;
}

/**
 * The running path: watchers first (an idle receiver archives within a tick of replying), then
 * the `decommission` request, then re-check on every watch event — no polling loop.
 * @param {{ p: NonNullable<ReturnType<typeof resolveProfile>>, registry: string, request: typeof controlRequest, keepHooks: boolean,
 *   waitTimeoutMs: number, graceMs: number, log: (m: string) => void, error: (m: string) => void }} o
 * @returns {Promise<{ archivedTo: string | null, purged: boolean, state: 'archived'|'waiting'|'failed' }>}
 */
async function waitForDecommission({ p, registry, request, keepHooks, waitTimeoutMs, graceMs, log, error }) {
  const pidFile = path.join(p.dir, "server.pid");
  const logFile = path.join(p.dir, "receiver.log");
  let logOffset = 0;
  try {
    logOffset = fs.statSync(logFile).size;
  } catch {
    /* no receiver.log yet */
  }

  /** @type {fs.FSWatcher[]} */
  const watchers = [];
  /** @type {NodeJS.Timeout | undefined} */
  let grace;
  /** @type {NodeJS.Timeout | undefined} */
  let overall;
  /** @type {(r: { archivedTo: string | null, purged: boolean, state: 'archived'|'waiting'|'failed' }) => void} */
  let settle = () => {};
  let settled = false;
  const done = new Promise((resolve) => {
    settle = (r) => {
      if (settled) return;
      settled = true;
      for (const w of watchers) w.close();
      clearTimeout(grace);
      clearTimeout(overall);
      resolve(r);
    };
  });

  const archived = () => {
    const to = findArchive(archiveRoot(registry), p.stateKey);
    if (!to) {
      error(`state dir ${p.dir} is gone but no archive was found under ${archiveRoot(registry)}`);
      return settle({ archivedTo: null, purged: false, state: "failed" });
    }
    log(`archived ${p.dir} → ${to}`);
    settle({ archivedTo: to, purged: false, state: "archived" });
  };
  const afterGrace = () => {
    if (!fs.existsSync(p.dir)) return archived();
    let tail = "";
    try {
      const buf = fs.readFileSync(logFile);
      tail = buf.subarray(Math.min(logOffset, buf.length)).toString("utf8");
    } catch {
      /* no receiver.log */
    }
    const failed = tail.match(/\[decommission\] archive failed: .*$/m)?.[0];
    error(failed ?? `receiver exited without archiving (cancelled by a signal?) — state dir left at ${p.dir}`);
    settle({ archivedTo: null, purged: false, state: "failed" });
  };
  let sent = false;
  const check = () => {
    if (settled || !sent) return;
    if (!fs.existsSync(p.dir)) return archived();
    if (!fs.existsSync(pidFile) && !grace) grace = setTimeout(afterGrace, graceMs);
  };

  for (const dir of [registry, p.dir]) {
    try {
      const w = fs.watch(dir, check);
      w.on("error", () => {}); // p.dir renamed away under the watcher
      watchers.push(w);
    } catch {
      /* the overall timeout still bounds the wait */
    }
  }

  let reply;
  try {
    reply = await request(controlSockPath(p.dir, p.stateKey), "decommission", { when: "idle", unregister: !keepHooks }, { timeoutMs: 5000 });
  } catch (e) {
    settle({ archivedTo: null, purged: false, state: "failed" });
    throw new Error(`remove: ${e.code === "timeout" ? "timed out waiting for the receiver" : "receiver is down"} — nothing changed`);
  }
  if (!reply.ok) {
    settle({ archivedTo: null, purged: false, state: "failed" });
    throw new Error(`remove: ${reply.error} — nothing changed`);
  }

  const { alreadyPending, active, queued } = reply.result;
  log(
    alreadyPending
      ? `decommission already pending (${active} agent(s) running, ${queued} queued)`
      : `waiting for ${active} agent(s) to finish (${queued} queued; they stay in the archived queue.json)…`,
  );
  log("Ctrl-C stops waiting but does not cancel the decommission");
  overall = setTimeout(() => {
    log("still waiting — the receiver archives itself once its agents finish; check `agenthook ls`");
    settle({ archivedTo: null, purged: false, state: "waiting" });
  }, waitTimeoutMs);
  sent = true;
  check();
  return done;
}

/** @param {string} question */
async function askTty(question) {
  if (!process.stdin.isTTY) throw new Error("remove: refusing to prompt on a non-interactive stdin — pass --yes");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

/** @param {any} args */
export async function remove(args) {
  try {
    const r = await removeProfile({
      nameOrKey: args._[0],
      purge: !!args.purge,
      yes: !!args.yes,
      keepHooks: !!args["keep-hooks"],
      ask: askTty,
    });
    if (r.state === "failed") process.exitCode = 1;
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}
