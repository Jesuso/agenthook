// Retiring a profile (epic #209): move a stopped profile's state dir ~/.agenthook/<key>/ into
// the sibling archive root ~/.agenthook-archive/<key>-<stamp>/. A plain rename — reversible by
// moving the dir back. Shared by the engine (a decommission's teardown, once the pidfile, control
// socket and listener are released) and the CLI/UI for a stopped receiver. Never touches the
// config file or any worktree. `registry` is injectable for tests.
import fs from "node:fs";
import path from "node:path";
import { ensurePrivateDir, registryDir, validName } from "./config.js";
import { readProfile } from "./heartbeat.js";
import { appendAudit } from "./ui/save.js";

/** The archive root beside a registry: `~/.agenthook` → `~/.agenthook-archive`. @param {string} [registry] */
export const archiveRoot = (registry = registryDir) => `${registry}-archive`;

/** UTC `YYYY-MM-DDTHH-MM-SS` (filename-safe). @param {Date} [date] */
export const archiveStamp = (date = new Date()) => date.toISOString().slice(0, 19).replace(/:/g, "-");

/**
 * Move `<registry>/<stateKey>` to `<archiveRoot>/<stateKey>-<stamp>` and append a
 * `{ts, action:'remove', stateKey, reason, source}` line to the archived `ui-audit.jsonl`.
 * Throws a clear error, touching nothing, on an invalid key (incl. `.`/`..`, which validName
 * accepts), a missing dir, a live receiver, an existing target, or a cross-filesystem move.
 * @param {{ stateKey: string, registry?: string, reason?: string, source?: string, now?: Date }} o
 * @returns {{ archivedTo: string }}
 */
export function archiveStateDir({ stateKey, registry = registryDir, reason, source, now = new Date() }) {
  if (!validName(stateKey) || stateKey === "." || stateKey === "..") {
    throw new Error(`archive: "${stateKey}" is not a valid state key (must match [A-Za-z0-9._-]+, not "." or "..").`);
  }
  const fromDir = path.join(registry, stateKey);
  let st;
  try {
    st = fs.statSync(fromDir);
  } catch {
    throw new Error(`archive: ${fromDir} does not exist.`);
  }
  if (!st.isDirectory()) throw new Error(`archive: ${fromDir} is not a directory.`);
  if (readProfile(stateKey, registry).up) throw new Error(`archive: "${stateKey}" is running — stop it or use decommission.`);
  const root = archiveRoot(registry);
  const archivedTo = path.join(root, `${stateKey}-${archiveStamp(now)}`);
  if (fs.existsSync(archivedTo)) throw new Error(`archive: ${archivedTo} already exists.`);
  ensurePrivateDir(root);
  if (fs.statSync(fromDir).dev !== fs.statSync(root).dev) {
    throw new Error(`archive: state dir is on a different filesystem than ${root} — move by hand.`);
  }
  fs.renameSync(fromDir, archivedTo);
  appendAudit(archivedTo, { ts: new Date().toISOString(), action: "remove", stateKey, reason, source });
  return { archivedTo };
}
