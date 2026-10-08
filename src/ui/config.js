// `ah ui` config editor, server side (docs/web-ui.md § v3). Reads and saves the profile's raw
// `agenthook.config.json` — exactly the file at the receiver-published heartbeat.configPath; no
// request param ever names a path. Validation is src/config.js's pure validateRawConfig over the
// raw text (`${VAR}` refs stay opaque, env is never read); `ah ui` still loads no config. A save
// goes through save.js (backup under the profile's `config-bak/`) and its audit line also names
// the SENSITIVE_FIELDS paths that changed. The receiver reads config at boot, so a save always
// answers `restartNeeded: true`.
import fs from "node:fs";
import path from "node:path";
import { literalSecrets, validateRawConfig } from "../config.js";
import { profileDir } from "./logs.js";
import { isObj, readJson, sha256 } from "./rows.js";
import { UI_MAX_BYTES, atomicSave, readCurrent } from "./save.js";
import { sensitiveChanges } from "./sensitive.js";

// Re-exported so existing importers keep working; the implementation lives in sensitive.js.
export { sensitiveChanges };

/**
 * The profile's config file, or null unless: the profile is known, its heartbeat publishes a
 * string `configPath`, that is a regular file (a symlink is rejected), it realpaths to itself,
 * and it is ≤ UI_MAX_BYTES.
 * @param {string} registry @param {string} profile
 * @returns {string|null}
 */
export function resolveConfigFile(registry, profile) {
  const dir = profileDir(registry, profile);
  if (!dir) return null;
  const hb = readJson(path.join(dir, "heartbeat.json"), null, isObj);
  const p = isObj(hb) && typeof hb.configPath === "string" && hb.configPath ? hb.configPath : null;
  if (!p) return null;
  try {
    const st = fs.lstatSync(p);
    if (!st.isFile() || st.size > UI_MAX_BYTES) return null;
    if (fs.realpathSync(p) !== p) return null;
    return p;
  } catch {
    return null;
  }
}

/** The config text parsed, or `{ error }` with the parse message.
 * @param {string} text @returns {{ raw: any } | { error: string }} */
function parse(text) {
  try {
    return { raw: JSON.parse(text) };
  } catch (e) {
    return { error: `invalid JSON: ${e.message}` };
  }
}

/** validateRawConfig's errors ([] when valid), or the parse error. @param {{ raw: any } | { error: string }} r */
function errorsOf(r) {
  if ("error" in r) return [r.error];
  const v = validateRawConfig(r.raw);
  return v.ok ? [] : v.errors;
}

/**
 * `GET /api/config`: the profile's raw config with its hash, validation errors and literal-secret
 * warnings. The size cap is re-checked on the bytes actually read. Null on any resolve or read
 * failure.
 * @param {string} registry @param {string} profile
 * @returns {import('./contract.js').ConfigView|null}
 */
export function readConfigFile(registry, profile) {
  const file = resolveConfigFile(registry, profile);
  if (!file) return null;
  /** @type {Buffer} */
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch {
    return null;
  }
  if (buf.length > UI_MAX_BYTES) return null;
  const text = buf.toString("utf8");
  const r = parse(text);
  return { path: file, text, hash: sha256(buf), errors: errorsOf(r), literalSecrets: "raw" in r ? literalSecrets(r.raw) : [] };
}

/**
 * Save the profile's config (`PUT /api/config`). Sequence: resolve (as readConfigFile) → 404;
 * size cap → 413; `baseHash` must equal the current sha256 → else 409 with the current text;
 * the new text must parse and pass validateRawConfig → else 422 `{ errors }` with nothing written
 * (no temp, no backup, no audit); then save.js atomicSave with the backup under `config-bak/`
 * and the audit line's `sensitive` = sensitiveChanges(old, new). Fully synchronous, so
 * concurrent saves with one `baseHash` get exactly one 200 and one 409.
 * @param {string} registry @param {string} profile @param {string} baseHash @param {string} text
 * @returns {{ status: 200, path: string, hash: string, restartNeeded: true } | { status: 409, text: string, hash: string }
 *   | { status: 422, errors: string[] } | { status: 404|413|500 }}
 */
export function writeConfigFile(registry, profile, baseHash, text) {
  const file = resolveConfigFile(registry, profile);
  const dir = profileDir(registry, profile);
  if (!file || !dir) return { status: 404 };
  const next = Buffer.from(text, "utf8");
  if (next.length > UI_MAX_BYTES) return { status: 413 };
  const cur = readCurrent(file);
  if (!cur) return { status: 500 };
  if (cur.hash !== baseHash) return { status: 409, text: cur.cur.toString("utf8"), hash: cur.hash };
  const r = parse(text);
  const errors = errorsOf(r);
  if (errors.length || !("raw" in r)) return { status: 422, errors };
  const old = parse(cur.cur.toString("utf8"));
  const sensitive = sensitiveChanges("raw" in old ? old.raw : undefined, r.raw);
  const saved = atomicSave({ stateDir: dir, file, cur: cur.cur, mode: cur.mode, next, bakSubdir: "config-bak", audit: { sensitive } });
  return saved.status === 200 ? { status: 200, path: file, hash: saved.hash, restartNeeded: true } : saved;
}
