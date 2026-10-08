// `rename --move` (epic #196, decision A): move a profile's state dir ~/.agenthook/<from>/ →
// ~/.agenthook/<to>/ and point the config at it. Shared by the engine (a restart's teardown,
// once nothing holds the dir) and the CLI (a stopped receiver). Order: the dir is renamed
// first, then the config's "stateId" rewritten (dropped when `to` is the label); a failed
// config write renames the dir back. A crash between the two leaves a moved dir behind an
// unchanged config — the next `start` then hits the r1 boot check (src/profile.js), which
// names the exact `"stateId": "<to>"` to set. `registry` is injectable for tests.
import fs from "node:fs";
import path from "node:path";
import { registryDir, validName, validateRawConfig } from "./config.js";
import { listProfiles } from "./heartbeat.js";
import { setStateIdInConfigText } from "./json-edit.js";
import { writeProfileMarker } from "./profile.js";
import { atomicSave, readCurrent } from "./ui/save.js";

/**
 * Throw a clear error unless moving `from` → `to` is safe right now: a valid, different name;
 * the config still keys `from`; `<registry>/<from>` exists and `<registry>/<to>` doesn't; no
 * other profile has `to` as its label or state key; and both dirs share a filesystem (a plain
 * rename, never a copy). Touches nothing.
 * @param {{ configPath: string, from: string, to: string, registry?: string }} o
 */
export function checkMove({ configPath, from, to, registry = registryDir }) {
  if (typeof to !== "string" || !validName(to)) throw new Error(`move: "${to}" must match [A-Za-z0-9._-]+.`);
  if (to === from) throw new Error(`move: the state dir is already "${from}".`);
  const raw = readRaw(configPath);
  const key = raw.stateId ?? raw.name;
  if (key !== from) throw new Error(`move: ${configPath} keys state "${key}", not "${from}" — nothing moved.`);
  const fromDir = path.join(registry, from);
  const toDir = path.join(registry, to);
  if (!fs.existsSync(fromDir)) throw new Error(`move: ${fromDir} does not exist.`);
  if (fs.existsSync(toDir)) throw new Error(`move: ${toDir} already exists.`);
  const collision = listProfiles(registry)
    .filter((p) => p.stateKey !== from)
    .find((p) => p.name === to || p.stateKey === to);
  if (collision) throw new Error(`move: "${to}" collides with the existing profile "${collision.name}" (state key "${collision.stateKey}").`);
  if (fs.statSync(fromDir).dev !== fs.statSync(registry).dev) {
    throw new Error(`move: state dir is on a different filesystem than the registry — move by hand.`);
  }
}

/**
 * Move the state dir and rewrite the config's "stateId" (null when `to` is the label, else
 * `to`), saving via atomicSave (backup in `<toDir>/config-bak`, audit `{source, action:'move',
 * from, to}`). The edited text is computed and checked before anything moves; a failed save
 * renames the dir back and rethrows.
 * @param {{ configPath: string, from: string, to: string, registry?: string, source?: string, save?: typeof atomicSave }} o
 * @returns {{ stateDir: string, stateKey: string }}
 */
export function moveStateDir({ configPath, from, to, registry = registryDir, source = "cli", save = atomicSave }) {
  checkMove({ configPath, from, to, registry });
  const cur = readCurrent(configPath);
  if (!cur) throw new Error(`move: could not read ${configPath}.`);
  const name = readRaw(configPath).name;
  const nextText = setStateIdInConfigText(cur.cur.toString("utf8"), to === name ? null : to);
  assertSafeMove(nextText, name, to);

  const fromDir = path.join(registry, from);
  const toDir = path.join(registry, to);
  fs.renameSync(fromDir, toDir);
  /** @type {ReturnType<typeof atomicSave>} */
  let saved;
  try {
    saved = save({
      stateDir: toDir,
      file: configPath,
      cur: cur.cur,
      mode: cur.mode,
      next: Buffer.from(nextText, "utf8"),
      bakSubdir: "config-bak",
      audit: { source, action: "move", from, to },
    });
  } catch {
    saved = { status: 500 };
  }
  if (saved.status !== 200) {
    fs.renameSync(toDir, fromDir);
    throw new Error(`move: failed to save ${configPath} — state dir left at ${fromDir}.`);
  }
  // Refresh profile.json so `ls` shows the new key before the next boot (which re-stamps it anyway).
  try {
    writeProfileMarker(/** @type {any} */ ({ stateDir: toDir, configPath, stateKey: to, name }));
  } catch {
    /* best effort */
  }
  return { stateDir: toDir, stateKey: to };
}

/**
 * Backstop before the dir moves: the edited text must be valid JSON, pass validateRawConfig, keep
 * the label, and key the new state dir (`stateId ?? name === to`). Throws on any mismatch.
 * @param {string} text @param {string} name @param {string} to
 */
export function assertSafeMove(text, name, to) {
  /** @type {any} */
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`move: the edited config is not valid JSON (${e.message}) — nothing moved.`);
  }
  const v = validateRawConfig(raw);
  if (!v.ok) throw new Error(`move: the edited config fails validation (${v.errors[0]}) — nothing moved.`);
  if (raw.name !== name) throw new Error(`move: the edit would change the label — nothing moved.`);
  const key = raw.stateId ?? raw.name;
  if (key !== to) throw new Error(`move: the edited config keys "${key}", not "${to}" — nothing moved.`);
}

/** The config's parsed JSON (uninterpolated). @param {string} configPath @returns {any} */
function readRaw(configPath) {
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (e) {
    throw new Error(`move: could not read ${configPath} (${e.message}).`);
  }
}
