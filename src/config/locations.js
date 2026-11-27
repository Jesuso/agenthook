// Where things live on disk: the install dir, the central registry dir, the config file's
// own discovery, and the "make a private state dir" helper.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The installed package root (this file is src/config/locations.js). Used only to read
// bundled templates — never for runtime state.
export const installDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// Where all profiles keep their runtime state, one subdir per profile name.
// AGENTHOOK_HOME overrides the root (tests use it to stay out of the real ~/.agenthook).
export const registryDir = process.env.AGENTHOOK_HOME
  ? path.resolve(process.env.AGENTHOOK_HOME)
  : path.join(os.homedir(), ".agenthook");

// A config with no `port` binds here. `claimedPorts` (port.js) assumes the same default
// for a registered profile whose config omits the key.
export const DEFAULT_PORT = 4123;

export const CONFIG_NAME = "agenthook.config.json";

/** Expand ~ and resolve a path against a base dir (absolute paths pass through).
 * @param {string} p @param {string} base */
export function resolvePath(p, base) {
  if (p.startsWith("~")) p = path.join(os.homedir(), p.slice(1));
  return path.isAbsolute(p) ? p : path.resolve(base, p);
}

/** Walk up from `start` looking for agenthook.config.json. @param {string} start */
export function discoverConfigPath(start = process.cwd()) {
  let dir = path.resolve(start);
  for (;;) {
    const candidate = path.join(dir, CONFIG_NAME);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null; // hit filesystem root
    dir = parent;
  }
}

/**
 * Ensure `dir` exists, private. A newly created dir is always born 0700 (POSIX);
 * the parent is created first, without a mode, so `recursive` mkdir doesn't also
 * stamp 0700 onto a freshly created `~/.agenthook` or other ancestor.
 *
 * An already-existing dir's mode is only checked/tightened when `tighten` is set
 * (the boot path, which runs once). loadConfig creates nothing — only real writers
 * (claimStateDir on boot, spawnDetached, rename, …) call this, create-only unless booting.
 * @param {string} dir
 * @param {{tighten?: boolean}} [opts]
 * @returns {{tightened: true, from: number} | {tightened: false}}
 */
export function ensurePrivateDir(dir, { tighten = false } = {}) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    fs.mkdirSync(dir, process.platform === "win32" ? undefined : { mode: 0o700 });
    return { tightened: false };
  }
  if (process.platform === "win32" || !tighten) return { tightened: false };
  const from = fs.statSync(dir).mode & 0o777;
  if ((from & 0o077) !== 0) {
    fs.chmodSync(dir, 0o700);
    return { tightened: true, from };
  }
  return { tightened: false };
}
