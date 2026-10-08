// `ah ui` instructions-editor read side (docs/web-ui.md § v2). Lists the profile's standing
// instruction files — the allowlist the receiver publishes in heartbeat.json, nothing else —
// reads one of them, and splits a step's last real prompt (the `<log>.prompt.md` sidecar
// dispatch.js writes) into its standing and ticket halves. Blind reader: no config load,
// never builds a path from a request param. The one exception is writeInstructionFile — the
// only code in src/ui that writes: an allowlisted instruction file (atomically), its backup
// under the profile's `instructions-bak/`, and the profile's `ui-audit.jsonl`.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { RUN_PREFIX_RE, profileDir } from "./logs.js";
import { instructionEntries, isObj, readEventsTail, readJson, readStateFile, sha256 } from "./rows.js";

/** Largest instruction file the editor reads or writes (and the PUT body cap). */
export const INSTRUCTIONS_MAX_BYTES = 256 * 1024;

/** dispatch.js's join between the standing instructions and the ticket prompt. */
const MARKER = "\n\n=== TICKET ===\n\n";
const PROMPT_EXT = ".prompt.md";

/** @param {string} dir */
const heartbeatOf = (dir) => readJson(path.join(dir, "heartbeat.json"), null, isObj);

/**
 * The profile's allowlisted instruction files with their current hash/size/mtime and how many
 * agents are running on a step that reads them (`repo` scope: every running agent — its ids
 * are repo ids). Null for an unknown profile.
 * @param {string} registry @param {string} profile
 * @returns {import('./contract.js').InstructionsView|null}
 */
export function listInstructions(registry, profile) {
  const dir = profileDir(registry, profile);
  if (!dir) return null;
  const hb = heartbeatOf(dir);
  const running = Object.values(readStateFile(dir, "running")).filter(isObj);
  /** @type {import('./contract.js').InstructionFileView[]} */
  const files = [];
  for (const e of instructionEntries(hb)) {
    let hash = null;
    let bytes = 0;
    let mtime = null;
    try {
      const st = fs.statSync(e.path);
      if (st.isFile()) {
        const buf = fs.readFileSync(e.path);
        hash = sha256(buf);
        bytes = buf.length;
        mtime = st.mtime.toISOString();
      }
    } catch {
      /* missing / unreadable → exists:false */
    }
    const agentsRunning =
      e.scope === "repo" ? running.length : running.filter((r) => typeof r.stepId === "string" && e.ids.includes(r.stepId)).length;
    files.push({ path: e.path, scope: e.scope, ids: e.ids, hash, bytes, mtime, exists: hash !== null, agentsRunning });
  }
  return { configPath: isObj(hb) && typeof hb.configPath === "string" ? hb.configPath : null, files };
}

/**
 * The absolute path of one allowlisted instruction file, or null unless: the profile is known,
 * `p` is **exactly** (no normalisation) a path in its heartbeat allowlist, it's a regular file
 * (a symlink is rejected), it realpaths to itself, ends in `.md`, and is ≤ INSTRUCTIONS_MAX_BYTES.
 * @param {string} registry @param {string} profile @param {string} p
 * @returns {string|null}
 */
export function resolveInstructionFile(registry, profile, p) {
  const dir = profileDir(registry, profile);
  if (!dir || typeof p !== "string" || !p.endsWith(".md")) return null;
  if (!instructionEntries(heartbeatOf(dir)).some((e) => e.path === p)) return null;
  try {
    const st = fs.lstatSync(p);
    if (!st.isFile() || st.size > INSTRUCTIONS_MAX_BYTES) return null;
    if (fs.realpathSync(p) !== p) return null;
    return p;
  } catch {
    return null;
  }
}

/**
 * Read one allowlisted instruction file (see resolveInstructionFile). The size cap is
 * re-checked on the bytes actually read. Null on any validation or read failure.
 * @param {string} registry @param {string} profile @param {string} p
 * @returns {{ path: string, content: string, hash: string }|null}
 */
export function readInstructionFile(registry, profile, p) {
  const file = resolveInstructionFile(registry, profile, p);
  if (!file) return null;
  try {
    const buf = fs.readFileSync(file);
    if (buf.length > INSTRUCTIONS_MAX_BYTES) return null;
    return { path: file, content: buf.toString("utf8"), hash: sha256(buf) };
  } catch {
    return null;
  }
}

/**
 * Where the one-generation backup of an instruction file lives: the profile's state dir, never
 * beside the file. Instruction files usually sit in the user's repo, and a `<file>.bak` there
 * escapes `INSTRUCTIONS*.md`-style ignore rules — private instructions one `git add -A` from a
 * commit. Keyed by basename + a hash of the absolute path, so same-named files don't collide.
 * @param {string} stateDir @param {string} file
 */
export const backupPathFor = (stateDir, file) =>
  path.join(stateDir, "instructions-bak", `${path.basename(file)}.${sha256(file).slice(0, 12)}.bak`);

/**
 * Save one allowlisted instruction file (`PUT /api/instructions/file`). Fully synchronous on
 * purpose: Node's single thread serialises concurrent saves, so two with the same `baseHash`
 * get exactly one 200 and one 409 with no lock. Sequence: resolve (as readInstructionFile) →
 * size cap → `baseHash` must equal the current sha256 (else 409 with the current file) → temp
 * file in the same dir with the exact original mode → fsync → old content to backupPathFor
 * (state dir, 0600 in a 0700 dir; a symlinked dir or non-regular backup is an error, never
 * followed) → rename over the file. Then one `{ ts, path, oldHash, newHash, bytes }` line is appended to the profile's
 * `ui-audit.jsonl` (0600); an audit failure doesn't undo the save.
 * @param {string} registry @param {string} profile @param {string} p
 * @param {string} baseHash @param {string} content
 * @returns {{ status: 200, hash: string } | { status: 409, content: string, hash: string } | { status: 404|413|500 }}
 */
export function writeInstructionFile(registry, profile, p, baseHash, content) {
  const file = resolveInstructionFile(registry, profile, p);
  const dir = profileDir(registry, profile);
  if (!file || !dir) return { status: 404 };
  const next = Buffer.from(content, "utf8");
  if (next.length > INSTRUCTIONS_MAX_BYTES) return { status: 413 };
  /** @type {Buffer} */
  let cur;
  /** @type {number} */
  let mode;
  try {
    mode = fs.lstatSync(file).mode & 0o7777;
    cur = fs.readFileSync(file);
  } catch {
    return { status: 500 };
  }
  const oldHash = sha256(cur);
  if (oldHash !== baseHash) return { status: 409, content: cur.toString("utf8"), hash: oldHash };

  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomBytes(8).toString("hex")}.tmp`);
  let made = false;
  try {
    const fd = fs.openSync(tmp, "wx", mode);
    made = true;
    writeAll(fd, next, mode);
    const bak = backupPathFor(dir, file);
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
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), path: file, oldHash, newHash: hash, bytes: next.length });
    fs.appendFileSync(path.join(dir, "ui-audit.jsonl"), line + "\n", { mode: 0o600 });
  } catch {
    /* the save happened; a missing audit line doesn't undo it */
  }
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

/**
 * "What the agent sees": the step's newest `.prompt.md` sidecar, split at the first ticket
 * marker. Null for an unknown profile or a step this profile isn't known to run (heartbeat
 * step/default ids ∪ steps in the events tail); `{ run: null }` when it has no prompt yet.
 * Filenames are `<stamp>-step-<step>-<ref>.prompt.md` and step ids may contain "-", so a
 * prompt whose remainder also starts with a longer known step (`code-review-` for `code`)
 * belongs to that step, not this one.
 * @param {string} registry @param {string} profile @param {string} step
 * @returns {import('./contract.js').PromptPreview|null}
 */
export function promptPreview(registry, profile, step) {
  const dir = profileDir(registry, profile);
  if (!dir || typeof step !== "string" || !step) return null;
  const known = new Set();
  for (const e of instructionEntries(heartbeatOf(dir))) if (e.scope !== "repo") for (const id of e.ids) known.add(id);
  for (const e of readEventsTail(path.join(dir, "events.jsonl"))) if (typeof e.step === "string" && e.step) known.add(e.step);
  if (!known.has(step)) return null;
  const longer = [...known].filter((k) => k.startsWith(step + "-"));

  const logs = path.join(dir, "logs");
  /** @type {string[]} */
  let names;
  try {
    names = fs.readdirSync(logs);
  } catch {
    return { run: null };
  }
  const matches = names
    .filter((n) => {
      const m = RUN_PREFIX_RE.exec(n);
      if (!m || !n.endsWith(PROMPT_EXT)) return false;
      const rest = n.slice(m[0].length, -PROMPT_EXT.length);
      return rest.length > step.length + 1 && rest.startsWith(step + "-") && !longer.some((k) => rest.startsWith(k + "-"));
    })
    .sort();
  for (const name of matches.reverse()) {
    const file = path.join(logs, name);
    /** @type {string} */
    let text;
    try {
      if (!fs.lstatSync(file).isFile()) continue; // a symlink is never a prompt
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const run = name.slice(0, -PROMPT_EXT.length) + ".log";
    const i = text.indexOf(MARKER);
    return i === -1 ? { run, standing: "", ticket: text } : { run, standing: text.slice(0, i), ticket: text.slice(i + MARKER.length) };
  }
  return { run: null };
}
