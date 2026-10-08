// The per-state-dir `profile.json` marker and the boot-time rename check.
//
// A profile's state dir is ~/.agenthook/<stateKey> (stateKey = stateId ?? name), so renaming
// a profile without a stateId would silently fork it onto an empty dir — no dedup, attempts,
// held items, webhook secrets or logs. Each booted state dir records the config that owns it
// in `profile.json`; on boot, a *fresh* state dir whose config already owns a sibling dir is
// refused loudly instead. `registry` is injectable for tests.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensurePrivateDir, registryDir } from "./config.js";

export const MARKER = "profile.json";

/** @param {string} p */
function canonical(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** `p` with the home dir shown as `~`. @param {string} p */
export function tildify(p) {
  const home = os.homedir();
  return p === home || p.startsWith(home + path.sep) ? "~" + p.slice(home.length) : p;
}

/** A state dir's parsed `profile.json`, or null. @param {string} dir */
export function readMarker(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, MARKER), "utf8"));
  } catch {
    return null;
  }
}

/**
 * Write (or refresh) `<stateDir>/profile.json`, 0600. An existing marker's `createdAt` is kept;
 * an unparsable one gets a fresh `createdAt`.
 * @param {import('./types.js').Config} cfg
 */
export function writeProfileMarker(cfg) {
  const file = path.join(cfg.stateDir, MARKER);
  const now = new Date().toISOString();
  const prev = readMarker(cfg.stateDir);
  const createdAt = typeof prev?.createdAt === "string" ? prev.createdAt : now;
  const marker = { configPath: cfg.configPath, stateKey: cfg.stateKey, name: cfg.name, createdAt, updatedAt: now };
  fs.writeFileSync(file, JSON.stringify(marker, null, 2), { mode: 0o600 });
  if (process.platform !== "win32") fs.chmodSync(file, 0o600);
}

/**
 * Fresh = missing, or no `profile.json` and nothing in the dir but (optionally) an empty `logs/`.
 * That covers a never-started profile (loadConfig creates nothing; claimStateDir creates the dir)
 * and a ghost dir left by an older build, while a legacy pre-marker dir holding real state is
 * never fresh.
 * @param {string} dir
 */
export function isFreshStateDir(dir) {
  /** @type {fs.Dirent[]} */
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return e.code === "ENOENT";
  }
  return entries.every((d) => d.name === "logs" && d.isDirectory() && fs.readdirSync(path.join(dir, "logs")).length === 0);
}

/**
 * The sibling state dir this config already owns, when this one is fresh — i.e. the profile was
 * renamed without a stateId. Only dirs carrying a `profile.json` are considered; null = no conflict.
 * @param {import('./types.js').Config} cfg
 * @param {string} [registry]
 * @returns {string|null}
 */
export function findRenameConflict(cfg, registry = registryDir) {
  if (!isFreshStateDir(cfg.stateDir)) return null;
  const ours = canonical(cfg.configPath);
  /** @type {string[]} */
  let names = [];
  try {
    names = fs
      .readdirSync(registry, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name !== cfg.stateKey)
      .map((d) => d.name)
      .sort();
  } catch {
    return null;
  }
  for (const name of names) {
    const marker = readMarker(path.join(registry, name));
    if (typeof marker?.configPath === "string" && canonical(marker.configPath) === ours) return name;
  }
  return null;
}

/**
 * Boot gate: refuse to start on an empty state dir whose config already owns another one (removing
 * the empty dir again — only if still empty, never recursively), else create the state dir (0700)
 * + `logs/` and stamp the marker. The one place a booting profile's state dir is born.
 * @param {import('./types.js').Config} cfg
 * @param {string} [registry]
 */
export function claimStateDir(cfg, registry = registryDir) {
  const other = findRenameConflict(cfg, registry);
  if (other) {
    for (const dir of [path.join(cfg.stateDir, "logs"), cfg.stateDir]) {
      try {
        fs.rmdirSync(dir);
      } catch {
        /* absent, or no longer empty — leave it */
      }
    }
    throw new Error(
      `profile state for this config already lives in ${tildify(path.join(registry, other))}/ — looks like a rename. ` +
        `Add "stateId": "${other}" to ${cfg.configPath} (or move the dir). Refusing to start on an empty state dir.`,
    );
  }
  ensurePrivateDir(cfg.stateDir);
  ensurePrivateDir(cfg.logDir);
  writeProfileMarker(cfg);
}

/**
 * Guard for commands that write into the state dir but must not *create* it (catchup, reconcile,
 * register, unregister): a profile that was never started has nothing for them to act on, and
 * creating the dir here would leave a ghost profile behind.
 * @param {import('./types.js').Config} cfg
 */
export function requireStarted(cfg) {
  if (fs.existsSync(cfg.stateDir)) return;
  throw new Error(`${neverStarted(cfg)} — run \`agenthook start\` first`);
}

/** The "never started" line read-only commands print for a missing state dir. @param {import('./types.js').Config} cfg */
export function neverStarted(cfg) {
  return `profile "${cfg.name}" has never been started (no state at ${tildify(cfg.stateDir)}/)`;
}
