// `agenthook start` — boot a profile's receiver. Server owns the ingress lifecycle
// (see engine.js). Refuses to start if the profile is already running (pid alive).
//
// `--detach` returns only once the child is serving (its pidfile names a live pid — written
// right after the control socket listens), so a command typed next (`ticket add`, `run`)
// reaches it instead of racing its boot. Waits on an fs.watch of the state dir, not a poll.
//
// `--reconcile-on-boot` is internal: a control-socket `restart` respawns with it so the
// new server runs one reconcile after boot. `--detach` forwards it to the child. A restart under
// a systemd unit can't change the unit's argv, so it leaves a marker file in the state dir
// instead (src/respawn.js RECONCILE_MARKER); the foreground boot honours it and clears it once
// the boot succeeded, so a failed attempt (network not up yet) keeps it for systemd's retry.
//
// Under the unit (`AGENTHOOK_SERVICE=1`) a refusal — already running, control socket owned, port
// in use — exits REFUSED_EXIT_CODE instead of 1: the unit's `RestartPreventExitStatus=` keeps
// systemd from retrying it until the start limit trips. It is the operator's to resolve.
import { loadConfig } from "../config.js";
import { createEngine } from "../engine.js";
import { readProfile } from "../heartbeat.js";
import { claimStateDir } from "../profile.js";
import fs from "node:fs";
import { startArgv, spawnDetached, hasReconcileMarker, clearReconcileMarker, underSystemdUnit, REFUSED_EXIT_CODE } from "../respawn.js";
import { isAlive } from "../heartbeat.js";
import { checkSockPath } from "../control.js";
import { claimedPorts, portInUse } from "../port.js";
import { unitName } from "../service.js";

/**
 * The error a refused `start` throws. Under the systemd unit it carries `exitCode`
 * REFUSED_EXIT_CODE (bin/agenthook.js honours it) and one line names the hand-over.
 * Pure given `env`.
 * @param {{name: string, stateKey: string, configPath: string}} cfg
 * @param {string} message
 * @param {{env?: NodeJS.ProcessEnv, log?: (line: string) => void}} [o]
 * @returns {Error & {exitCode?: number}}
 */
export function refusal(cfg, message, { env = process.env, log = (l) => console.error(l) } = {}) {
  if (!underSystemdUnit(env)) return new Error(message);
  log(
    `[start] refused under the systemd unit — exiting ${REFUSED_EXIT_CODE} so systemd does not retry it. To hand the running receiver over to the unit: agenthook stop --keep-hooks --config ${cfg.configPath}, then systemctl --user start ${unitName(cfg.stateKey)}`,
  );
  return Object.assign(new Error(message), { exitCode: REFUSED_EXIT_CODE });
}

/** @param {any} args */
export async function start(args) {
  const cfg = loadConfig({ configPath: args.config });
  const reconcileOnBoot = !!args["reconcile-on-boot"];

  const existing = readProfile(cfg.stateKey);
  if (existing.up) {
    throw refusal(cfg, `profile "${cfg.name}" is already running (pid ${existing.pid}). Run \`agenthook stop\` first.`);
  }

  // Refuse here too, so the reason lands in this terminal rather than only in receiver.log.
  try {
    checkSockPath(cfg.controlSock);
  } catch (e) {
    throw refusal(cfg, e.message);
  }

  // A busy port that's just another registered profile's — named, so the EADDRINUSE below
  // doesn't surface as an unexplained bind failure deep in boot (src/engine/boot.js).
  if (await portInUse(cfg.port)) {
    const claimant = claimedPorts({ exclude: { stateKey: cfg.stateKey } }).find((c) => c.port === cfg.port);
    if (claimant) {
      const running = readProfile(claimant.stateKey).up;
      if (running) {
        throw refusal(cfg, `port ${cfg.port} is in use by profile "${claimant.name}" — stop it (agenthook stop, in its dir) or set a different "port"`);
      }
      throw refusal(cfg, `port ${cfg.port} is in use by another process; profile "${claimant.name}" is also configured for it — free the port or set a different "port" (both profiles can't share it)`);
    }
  }

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

  // serve() resolves once the boot sequence (listen, webhooks, recovery, the one-shot reconcile)
  // is through, and keeps the process alive via the open server + signal handlers. The marker
  // goes only then: a boot that throws leaves it for the attempt that makes it.
  const marker = hasReconcileMarker(cfg.stateDir);
  await createEngine(cfg, { reconcileOnBoot: reconcileOnBoot || marker }).serve();
  if (marker) clearReconcileMarker(cfg.stateDir);
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
