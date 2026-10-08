// Detached receiver spawns: `start --detach` and the control-socket `restart` both
// launch `bin/agenthook.js start …` in the background, logging to <stateDir>/receiver.log.
// The argv builders are pure (unit-tested); spawnDetached does the I/O.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { ensurePrivateDir } from "./config.js";

/**
 * argv (after the node binary) for a `start` child on `cfg.configPath`.
 * @param {{installDir: string, configPath: string}} cfg
 * @param {{detach?: boolean, reconcileOnBoot?: boolean}} [opts]
 */
export function startArgv(cfg, { detach = false, reconcileOnBoot = false } = {}) {
  return [
    path.join(cfg.installDir, "bin", "agenthook.js"),
    "start",
    ...(detach ? ["--detach"] : []),
    "--config",
    cfg.configPath,
    ...(reconcileOnBoot ? ["--reconcile-on-boot"] : []),
  ];
}

/**
 * The respawn a `restart` fires on exit: a detached `start --detach` on the same config
 * whose server runs one reconcile after boot (recovering webhooks missed in the gap).
 * @param {{installDir: string, configPath: string}} cfg
 * @param {{execPath?: string, installDir?: string}} [opts]
 * @returns {{command: string, args: string[]}}
 */
export function restartSpawnArgs(cfg, { execPath = process.execPath, installDir = cfg.installDir } = {}) {
  return { command: execPath, args: startArgv({ installDir, configPath: cfg.configPath }, { detach: true, reconcileOnBoot: true }) };
}

/**
 * Spawn `command args` detached (own process group, unref'd), stdio appended to
 * <stateDir>/receiver.log.
 * @param {{stateDir: string}} cfg
 * @param {{command: string, args: string[]}} spec
 * @returns {{pid: number|undefined, logPath: string}}
 */
export function spawnDetached(cfg, { command, args }) {
  ensurePrivateDir(cfg.stateDir);
  const logPath = path.join(cfg.stateDir, "receiver.log");
  const fd = fs.openSync(logPath, "a");
  try {
    const child = spawn(command, args, { detached: true, stdio: ["ignore", fd, fd] });
    child.unref();
    return { pid: child.pid, logPath };
  } finally {
    fs.closeSync(fd);
  }
}
