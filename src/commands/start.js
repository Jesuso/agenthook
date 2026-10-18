// `agenthook start` — boot a profile's receiver. Server owns the ingress lifecycle
// (see engine.js). Refuses to start if the profile is already running (pid alive).
//
// `--detach` returns only once the child is serving (its pidfile names a live pid — written
// right after the control socket listens), so a command typed next (`ticket add`, `run`)
// reaches it instead of racing its boot. Waits on an fs.watch of the state dir, not a poll.
//
// `--reconcile-on-boot` is internal: a control-socket `restart` respawns with it so the
// new server runs one reconcile after boot. `--detach` forwards it to the child.
import { loadConfig } from "../config.js";
import { createEngine } from "../engine.js";
import { readProfile } from "../heartbeat.js";
import { claimStateDir } from "../profile.js";
import fs from "node:fs";
import { startArgv, spawnDetached } from "../respawn.js";
import { isAlive } from "../heartbeat.js";
import { checkSockPath } from "../control.js";

/** @param {any} args */
export async function start(args) {
  const cfg = loadConfig({ configPath: args.config });
  const reconcileOnBoot = !!args["reconcile-on-boot"];

  const existing = readProfile(cfg.stateKey);
  if (existing.up) {
    throw new Error(`profile "${cfg.name}" is already running (pid ${existing.pid}). Run \`agenthook stop\` first.`);
  }

  // Refuse here too, so the reason lands in this terminal rather than only in receiver.log.
  checkSockPath(cfg.controlSock);

  if (args.detach) {
    // Check here, not only in the child: spawnDetached writes receiver.log into the state dir
    // (so the child would no longer see it fresh), and the refusal belongs in this terminal.
    claimStateDir(cfg);
    const { pid, logPath } = spawnDetached(cfg, { command: process.execPath, args: startArgv(cfg, { reconcileOnBoot }) });
    const boot = await waitForBoot(cfg, pid);
    if (boot === "exited") throw new Error(`"${cfg.name}" exited during boot — see ${logPath}`);
    if (boot === "timeout") {
      console.log(`started "${cfg.name}" in background (pid ${pid}), still booting. Log: ${logPath}`);
      return;
    }
    console.log(`started "${cfg.name}" in background (pid ${pid}). Log: ${logPath}`);
    return;
  }

  await createEngine(cfg, { reconcileOnBoot }).serve();
  // serve() keeps the process alive via the open server + signal handlers.
}

/**
 * Resolve once a detached receiver is serving: "up" when its pidfile names a live pid,
 * "exited" when the spawned child died first, "timeout" after `timeoutMs` (still booting —
 * e.g. a slow ngrok tunnel). Event-driven: re-checked on every change in the state dir.
 * @param {{stateDir: string, pidFile: string}} cfg
 * @param {number | undefined} childPid
 * @param {{timeoutMs?: number}} [opts]
 * @returns {Promise<"up" | "exited" | "timeout">}
 */
export function waitForBoot(cfg, childPid, { timeoutMs = 20000 } = {}) {
  return new Promise((resolve) => {
    /** @type {fs.FSWatcher | undefined} */
    let watcher;
    const done = (/** @type {"up" | "exited" | "timeout"} */ r) => {
      clearTimeout(timer);
      watcher?.close();
      resolve(r);
    };
    const check = () => {
      let pid = 0;
      try {
        pid = Number(fs.readFileSync(cfg.pidFile, "utf8").trim());
      } catch {}
      if (isAlive(pid)) return done("up");
      if (childPid && !isAlive(childPid)) return done("exited");
    };
    const timer = setTimeout(() => done(childPid && !isAlive(childPid) ? "exited" : "timeout"), timeoutMs);
    try {
      watcher = fs.watch(cfg.stateDir, check);
    } catch {}
    check();
  });
}
