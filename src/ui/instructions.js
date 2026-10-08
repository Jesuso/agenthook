// `ah ui` instructions-editor read side (docs/web-ui.md § v2). Lists the profile's standing
// instruction files — the allowlist the receiver publishes in heartbeat.json, nothing else —
// reads one of them, and splits a step's last real prompt (the `<log>.prompt.md` sidecar
// dispatch.js writes) into its standing and ticket halves. Blind reader: no config load,
// never builds a path from a request param, writes nothing.
import fs from "node:fs";
import path from "node:path";
import { RUN_PREFIX_RE, profileDir } from "./logs.js";
import { instructionEntries, isObj, readEventsTail, readJson, readStateFile, sha256 } from "./rows.js";

/** Largest instruction file the editor reads (and, later, writes). */
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
