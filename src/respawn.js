// Detached receiver spawns: `start --detach` and the control-socket `restart` both
// launch `bin/agenthook.js start …` in the background, logging to <stateDir>/receiver.log.
// The argv builders are pure (unit-tested); spawnDetached does the I/O.
//
// On Linux, spawnDetached also escapes the caller's cgroup scope via `systemd-run --user
// --scope`: plain `{detached:true}` only gets a new process group/session, so a receiver
// launched from a terminal still dies when that terminal's scope is torn down (tab closed,
// launcher OOM-killed). See issue #232.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { ensurePrivateDir } from "./config.js";

/**
 * Whether `spawnDetached` should wrap the child in `systemd-run --user --scope` so it
 * survives the caller's cgroup scope. Pure given injected probes (no I/O when supplied).
 * @param {{platform?: string, env?: NodeJS.ProcessEnv, onPath?: (cmd: string) => boolean, exists?: (p: string) => boolean}} [opts]
 */
export function systemdScopeAvailable({
  platform = process.platform,
  env = process.env,
  onPath = (cmd) =>
    (env.PATH ?? "").split(path.delimiter).some((dir) => dir && fs.existsSync(path.join(dir, cmd))),
  exists = (p) => fs.existsSync(p),
} = {}) {
  if (platform !== "linux") return false;
  if (env.AGENTHOOK_NO_SYSTEMD_SCOPE === "1") return false;
  if (!onPath("systemd-run")) return false;
  if (!env.XDG_RUNTIME_DIR) return false;
  return exists(path.join(env.XDG_RUNTIME_DIR, "systemd", "private"));
}

/**
 * Wrap a spawn spec in `systemd-run --user --scope` when `scope` is true; otherwise return
 * it unchanged. The unit name includes `now` (ms) so a restart respawn can't collide with a
 * live predecessor's unit.
 * @param {{command: string, args: string[]}} spec
 * @param {{scope: boolean, stateKey: string, now?: number}} opts
 * @returns {{command: string, args: string[]}}
 */
export function detachedSpawnSpec({ command, args }, { scope, stateKey, now = Date.now() }) {
  if (!scope) return { command, args };
  return {
    command: "systemd-run",
    args: ["--user", "--scope", "--collect", "--quiet", `--unit=agenthook-${stateKey}-${now}`, command, ...args],
  };
}

/**
 * Parse the `0::/…` line of `/proc/<pid>/cgroup` and classify its last path segment.
 * @param {string} text
 * @returns {{scope: string|null, terminal: boolean}}
 */
export function classifyCgroup(text) {
  const line = (text ?? "").split("\n").find((l) => l.startsWith("0::"));
  if (!line) return { scope: null, terminal: false };
  const segments = line.slice(3).split("/").filter(Boolean);
  const scope = segments.length ? segments[segments.length - 1] : null;
  if (!scope) return { scope: null, terminal: false };
  const terminal = /^vte-spawn-/.test(scope) || /-terminal-/.test(scope) || /^tmux-spawn-/.test(scope) || /^app-.*-code-.*\.scope$/.test(scope);
  return { scope, terminal };
}

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
 * <stateDir>/receiver.log. On Linux with a reachable systemd user manager, wraps the
 * command in `systemd-run --user --scope` so the child survives the caller's cgroup scope.
 * @param {{stateDir: string, stateKey: string}} cfg
 * @param {{command: string, args: string[]}} spec
 * @returns {{pid: number|undefined, logPath: string}}
 */
export function spawnDetached(cfg, spec) {
  ensurePrivateDir(cfg.stateDir);
  const logPath = path.join(cfg.stateDir, "receiver.log");
  const fd = fs.openSync(logPath, "a");
  try {
    const { command, args } = detachedSpawnSpec(spec, { scope: systemdScopeAvailable(), stateKey: cfg.stateKey });
    const child = spawn(command, args, { detached: true, stdio: ["ignore", fd, fd] });
    child.unref();
    return { pid: child.pid, logPath };
  } finally {
    fs.closeSync(fd);
  }
}
