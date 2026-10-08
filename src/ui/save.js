// `ah ui` shared save path (docs/web-ui.md § v2, § v3) — the only code in src/ui that writes.
// Both editors (instructions.js writeInstructionFile, config.js writeConfigFile) resolve and
// validate their own target, then hand the bytes here: an atomic replace of the file, a
// one-generation backup under the profile's state dir, and a line in its `ui-audit.jsonl` via
// `appendAudit`. `POST /api/restart` (server.js, no file write) uses `appendAudit` directly to
// log its outcome.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { sha256 } from "./rows.js";

/** Largest file either editor reads or writes (and the PUT body cap). */
export const UI_MAX_BYTES = 256 * 1024;

/**
 * Where the one-generation backup of a saved file lives: the profile's state dir, never beside
 * the file. Edited files usually sit in the user's repo, and a `<file>.bak` there escapes
 * `INSTRUCTIONS*.md`-style ignore rules — private content one `git add -A` from a commit. Keyed
 * by basename + a hash of the absolute path, so same-named files don't collide.
 * @param {string} stateDir @param {string} file @param {string} [subdir]
 */
export const backupPathFor = (stateDir, file, subdir = "instructions-bak") =>
  path.join(stateDir, subdir, `${path.basename(file)}.${sha256(file).slice(0, 12)}.bak`);

/**
 * Append one audit line to a profile's `ui-audit.jsonl` (0600), swallowing write failures — an
 * audit line is best-effort and never blocks the action it describes.
 * @param {string} stateDir @param {Record<string, any>} entry
 */
export function appendAudit(stateDir, entry) {
  try {
    fs.appendFileSync(path.join(stateDir, "ui-audit.jsonl"), JSON.stringify(entry) + "\n", { mode: 0o600 });
  } catch {
    /* best effort */
  }
}

/**
 * The current bytes, exact mode and sha256 of a file about to be saved; null if unreadable.
 * @param {string} file @returns {{ cur: Buffer, mode: number, hash: string }|null}
 */
export function readCurrent(file) {
  try {
    const mode = fs.lstatSync(file).mode & 0o7777;
    const cur = fs.readFileSync(file);
    return { cur, mode, hash: sha256(cur) };
  } catch {
    return null;
  }
}

/**
 * Replace `file` (currently `cur`, mode `mode`) with `next`. Fully synchronous on purpose: with
 * the caller's read + baseHash check, Node's single thread serialises concurrent saves, so two
 * with the same `baseHash` get exactly one 200 and one 409 with no lock. Sequence: temp file in
 * the same dir with the exact original mode → fsync → `cur` to backupPathFor(…, bakSubdir) (state
 * dir, 0600 in a 0700 dir; a symlinked dir or non-regular backup is an error, never followed) →
 * rename over the file. Then one `{ ts, path, oldHash, newHash, bytes, ...audit }` line is
 * appended to the profile's `ui-audit.jsonl` (0600); an audit failure doesn't undo the save.
 * @param {{ stateDir: string, file: string, cur: Buffer, mode: number, next: Buffer, bakSubdir: string, audit?: Record<string, any> }} o
 * @returns {{ status: 200, hash: string } | { status: 500 }}
 */
export function atomicSave({ stateDir, file, cur, mode, next, bakSubdir, audit }) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomBytes(8).toString("hex")}.tmp`);
  let made = false;
  try {
    const fd = fs.openSync(tmp, "wx", mode);
    made = true;
    writeAll(fd, next, mode);
    const bak = backupPathFor(stateDir, file, bakSubdir);
    try {
      if (!fs.lstatSync(path.dirname(bak)).isDirectory()) return fail(); // a symlinked dir is never followed
    } catch (e) {
      if (e.code !== "ENOENT") return fail();
      fs.mkdirSync(path.dirname(bak), { mode: 0o700 });
    }
    try {
      if (!fs.lstatSync(bak).isFile()) return fail();
    } catch (e) {
      if (e.code !== "ENOENT") return fail();
    }
    const { O_WRONLY, O_CREAT, O_TRUNC, O_NOFOLLOW } = fs.constants;
    writeAll(fs.openSync(bak, O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW, 0o600), cur, 0o600);
    fs.renameSync(tmp, file);
  } catch {
    return fail();
  }
  const hash = sha256(next);
  appendAudit(stateDir, { ts: new Date().toISOString(), path: file, oldHash: sha256(cur), newHash: hash, bytes: next.length, ...audit });
  return { status: 200, hash };

  /** @returns {{ status: 500 }} */
  function fail() {
    try {
      if (made) fs.unlinkSync(tmp);
    } catch {
      /* best effort */
    }
    return { status: 500 };
  }
}

/** Write all of `buf` to the open `fd` with exactly `mode` (umask would strip bits), fsync,
 * close — closing even on failure. @param {number} fd @param {Buffer} buf @param {number} mode */
function writeAll(fd, buf, mode) {
  try {
    fs.fchmodSync(fd, mode);
    for (let off = 0; off < buf.length; ) off += fs.writeSync(fd, buf, off, buf.length - off);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
