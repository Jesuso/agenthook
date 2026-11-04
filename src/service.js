// Start a profile's receiver at boot: a systemd --user unit (`agenthook service install`).
// `start --detach` survives the terminal that launched it (respawn.js wraps it in a
// `systemd-run --user --scope`), but nothing brings it back after a reboot or a crash. A user
// service does both: systemd starts `agenthook start` in the foreground at login (or at boot,
// once the user has lingering enabled) and restarts it when it dies.
//
// The unit runs the same `start` a terminal would, so the receiver is unchanged. Two details:
// - `AGENTHOOK_SERVICE=1` + `RestartForceExitStatus=75`: a control-socket `restart` under the
//   unit does not respawn a detached process (that would escape systemd); it exits 75 and
//   systemd starts it again inside the unit (src/respawn.js RESTART_EXIT_CODE).
// - `PATH` is the installing shell's: a user manager's default PATH rarely holds the agent CLI,
//   git or gh, and the receiver spawns them. Re-run `install` after moving them.
// Linux only. Never runs sudo: lingering (`loginctl enable-linger`) is printed for the user to run.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { RESTART_EXIT_CODE } from "./respawn.js";

/** The unit name for a profile. @param {string} stateKey */
export const unitName = (stateKey) => `agenthook-${stateKey}.service`;

/**
 * The directory systemd reads user units from. Pure given `env`/`home`.
 * @param {{env?: NodeJS.ProcessEnv, home?: string}} [o]
 */
export function userUnitDir({ env = process.env, home = os.homedir() } = {}) {
  const base = env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : path.join(home, ".config");
  return path.join(base, "systemd", "user");
}

/**
 * Quote one word for a unit file: `%` specifiers are escaped everywhere; `$` only in ExecStart
 * (the one place systemd expands variables). Quoted when it holds spaces, quotes or backslashes.
 * @param {string} s @param {{exec?: boolean}} [o]
 */
export function quoteArg(s, { exec = true } = {}) {
  let esc = String(s).replace(/%/g, "%%");
  if (exec) esc = esc.replace(/\$/g, "$$$$");
  if (!/[\s"'\\]/.test(esc) && esc !== "") return esc;
  return `"${esc.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** One `Environment=` assignment, quoted. @param {string} k @param {string} v */
const envLine = (k, v) => `Environment=${quoteArg(`${k}=${v}`, { exec: false })}`;

/**
 * The unit file text for a profile. Pure.
 * @param {{name: string, stateKey: string, configPath: string, execPath: string, installDir: string, pathEnv?: string, home?: string}} o
 *   `home` = AGENTHOOK_HOME when the profile lives outside ~/.agenthook
 */
export function renderUnit({ name, stateKey, configPath, execPath, installDir, pathEnv, home }) {
  const exec = [execPath, path.join(installDir, "bin", "agenthook.js"), "start", "--config", configPath].map((a) => quoteArg(a)).join(" ");
  return [
    "# Written by `agenthook service install`. Re-run it to regenerate; `agenthook service uninstall` removes it.",
    "[Unit]",
    `Description=agenthook receiver (${name})`,
    // No network-online.target: a user manager can't see the system one. A boot before the
    // network is up fails the ingress, and Restart=on-failure retries it.
    // Every start counts, a control-socket `restart` included; 10 leaves room for a busy
    // afternoon of restarts. When it trips: systemctl --user reset-failed <unit>.
    "StartLimitIntervalSec=300",
    "StartLimitBurst=10",
    "",
    "[Service]",
    "Type=simple",
    // A path setting takes the rest of the line as-is (no quotes), so only `%` is escaped.
    `WorkingDirectory=${path.dirname(configPath).replace(/%/g, "%%")}`,
    `ExecStart=${exec}`,
    envLine("AGENTHOOK_SERVICE", "1"),
    ...(pathEnv ? [envLine("PATH", pathEnv)] : []),
    ...(home ? [envLine("AGENTHOOK_HOME", home)] : []),
    "Restart=on-failure",
    `RestartForceExitStatus=${RESTART_EXIT_CODE}`,
    "RestartSec=3",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
    `# profile state key: ${stateKey}`,
    "",
  ].join("\n");
}

/**
 * @typedef {{status: number|null, stdout: string, stderr: string}} RunResult
 * @typedef {(cmd: string, args: string[]) => RunResult} Runner
 */

/** @type {Runner} */
export const defaultRunner = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return { status: r.error ? null : r.status, stdout: r.stdout ?? "", stderr: r.error ? r.error.message : r.stderr ?? "" };
};

/**
 * Lingering for the current user (`loginctl show-user`): true/false, or null when unknown.
 * @param {Runner} run @param {string} user
 */
export function lingerEnabled(run, user) {
  const r = run("loginctl", ["show-user", user, "--property=Linger", "--value"]);
  if (r.status !== 0) return null;
  const v = r.stdout.trim();
  return v === "yes" ? true : v === "no" ? false : null;
}

/** Why this platform can't host the unit, or null. @param {string} platform */
export function unsupportedReason(platform) {
  return platform === "linux" ? null : `agenthook service needs Linux with systemd (this is ${platform}); start the receiver with \`agenthook start --detach\` and your platform's own login items instead.`;
}
