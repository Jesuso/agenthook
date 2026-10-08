// `agenthook events [options]` — read or tail the profile event bus (events.jsonl).
//
//   events                    print recent events, human-readable, oldest→newest
//   events --follow / -f      tail live: stream new events as they arrive
//   events --event a,b,...    filter to these event types
//   events --ref <ref>        filter to one task: exact ref, else human id (ID-2738), else PR (#N / N)
//   events --json             emit raw JSONL (one line per event), for piping
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../config.js";

const VALID_EVENTS = new Set(["enqueued", "run_start", "run_end", "pipeline_done", "blocked", "failed", "merged", "pulled", "ci_red"]);

/**
 * Parse an event line as JSON; return null on failure.
 * @param {string} line
 * @returns {Record<string,any>|null}
 */
function parseLine(line) {
  try { return JSON.parse(line); } catch { return null; }
}

/** Read the profile's refmeta.json (ref -> {displayId,title,pr,url}); {} if absent/garbage.
 * @param {string} dataDir @returns {Record<string, import('../types.js').RefMeta>} */
function readRefMeta(dataDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, "refmeta.json"), "utf8"));
  } catch {
    return {};
  }
}

/**
 * Resolve `--ref <q>` to the set of refs it names. Order: an exact ref (one seen in the
 * events or refmeta) wins; else a case-insensitive human id; else a PR number (`#N`/`N`)
 * against refmeta's cached `pr`. No match → `{q}` (a ref that may yet appear under
 * --follow). So on GitHub `94` is issue 94, `#94` its display id, never PR 94. Pure.
 * @param {string} q
 * @param {Record<string, import('../types.js').RefMeta>} refmeta
 * @param {Iterable<string>} [knownRefs]  refs present in the event log
 * @returns {Set<string>}
 */
export function resolveRefFilter(q, refmeta, knownRefs = []) {
  const known = new Set([...knownRefs, ...Object.keys(refmeta)]);
  if (known.has(q)) return new Set([q]);
  const lq = q.toLowerCase();
  const byId = Object.keys(refmeta).filter((r) => refmeta[r]?.displayId?.toLowerCase() === lq);
  if (byId.length) return new Set(byId);
  const n = Number(q.replace(/^#/, ""));
  if (Number.isInteger(n) && n > 0) {
    const byPr = Object.keys(refmeta).filter((r) => refmeta[r]?.pr === n);
    if (byPr.length) return new Set(byPr);
  }
  return new Set([q]);
}

/**
 * Human-readable rendering of one event object. The human id (the event's own
 * `displayId`, else refmeta's) prefixes `ref=` when known.
 * @param {Record<string,any>} ev
 * @param {import('../types.js').RefMeta} [meta]  refmeta record for ev.ref
 * @returns {string}
 */
export function renderEvent(ev, meta) {
  const ts = ev.ts ? ev.ts.replace("T", " ").slice(0, 19) + "Z" : "?";
  const tag = String(ev.event ?? "?").padEnd(13);
  const displayId = ev.displayId ?? meta?.displayId;
  const ref = `${displayId ? `${displayId} ` : ""}ref=${ev.ref ?? "?"}`;
  const step = String(ev.step ?? "?");
  let extra = "";
  if (ev.model != null) extra += `  model=${ev.model}`;
  if (ev.outcome != null) extra += `  outcome=${ev.outcome}`;
  if (ev.costUsd != null) extra += `  cost=$${Number(ev.costUsd).toFixed(4)}`;
  if (ev.reason != null) extra += `  reason=${ev.reason}`;
  return `${ts}  ${tag}  ${ref}  step=${step}${extra}`;
}

/**
 * Check that all requested event types are valid; throw a user-facing Error if not.
 * @param {string[]} types
 */
function validateEventTypes(types) {
  const bad = types.filter((t) => !VALID_EVENTS.has(t));
  if (bad.length) {
    throw new Error(
      `unknown event type(s): ${bad.join(", ")}\nvalid: ${[...VALID_EVENTS].join(", ")}`
    );
  }
}

/** @param {any} args */
export async function events(args) {
  const cfg = loadConfig({ configPath: args.config });
  const eventsFile = path.join(cfg.dataDir, "events.jsonl");

  // Parse --event filter (comma-separated; may be repeated, but parse() gives a single string)
  /** @type {Set<string>|null} */
  let filterEvents = null;
  if (args.event) {
    const types = String(args.event).split(",").map((s) => s.trim()).filter(Boolean);
    validateEventTypes(types);
    filterEvents = new Set(types);
  }

  let refmeta = readRefMeta(cfg.dataDir);
  const jsonMode = !!args.json;
  const followMode = !!(args.follow || args.f);

  /**
   * Check whether an event object passes the active filters.
   * @param {Record<string,any>} ev
   * @returns {boolean}
   */
  function passes(ev) {
    if (filterEvents && !filterEvents.has(ev.event)) return false;
    if (filterRefs && !filterRefs.has(String(ev.ref))) return false;
    return true;
  }

  /**
   * Print one event (raw JSONL or human-readable).
   * @param {Record<string,any>} ev
   */
  function print(ev) {
    if (jsonMode) {
      process.stdout.write(JSON.stringify(ev) + "\n");
    } else {
      console.log(renderEvent(ev, refmeta[ev.ref]));
    }
  }

  const fileExists = fs.existsSync(eventsFile);

  // Missing file, no --follow → print nothing, exit 0.
  if (!fileExists && !followMode) {
    if (!jsonMode) console.log("no events yet");
    return;
  }

  // Read and print existing lines (none if the file doesn't exist yet).
  const existing = fileExists
    ? fs.readFileSync(eventsFile, "utf8").split("\n").filter(Boolean).map(parseLine)
    : [];
  /** @type {Set<string>|null} */
  const filterRefs =
    args.ref != null ? resolveRefFilter(String(args.ref), refmeta, existing.map((ev) => String(ev?.ref))) : null;
  for (const ev of existing) {
    if (ev && passes(ev)) print(ev);
  }

  if (!followMode) return;

  if (!fileExists) process.stderr.write("waiting for events...\n");

  // --follow: tail new lines appended to the file, from the directory (covers creation too).
  const startPos = fileExists ? fs.statSync(eventsFile).size : 0;
  tailFile(cfg.dataDir, "events.jsonl", startPos, (line) => {
    refmeta = readRefMeta(cfg.dataDir); // dispatch may have recorded a new id/title/PR
    const ev = parseLine(line);
    if (ev && passes(ev)) print(ev);
  });

  // Keep alive until Ctrl+C.
  await new Promise(() => {});
}

/**
 * Tail `file` under `dir` from `startPos`, calling `onLine` for each complete line as it
 * arrives. Watches the directory (not the file) so it tolerates the file not existing yet —
 * creation, appends, and truncation/rotation (position resets to 0) are all handled. Drains
 * once synchronously before returning, closing the race between an existence check and the
 * watcher attaching.
 * @param {string} dir
 * @param {string} file
 * @param {number} startPos
 * @param {(line: string) => void} onLine
 * @returns {{ close(): void }}
 */
export function tailFile(dir, file, startPos, onLine) {
  const target = path.join(dir, file);
  let pos = startPos;
  let buf = "";

  const drain = () => {
    let size;
    try { size = fs.statSync(target).size; } catch { return; }
    if (size < pos) pos = 0; // file rotated/truncated
    if (size === pos) return;
    const fd = fs.openSync(target, "r");
    const chunk = Buffer.alloc(size - pos);
    fs.readSync(fd, chunk, 0, chunk.length, pos);
    fs.closeSync(fd);
    pos = size;
    buf += chunk.toString("utf8");
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      onLine(line);
    }
  };

  const watcher = fs.watch(dir, { persistent: true }, (_ev, name) => {
    if (!name || name === file) drain();
  });
  drain();

  return { close: () => watcher.close() };
}
