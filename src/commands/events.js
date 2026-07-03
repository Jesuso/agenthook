// `agenthook events [options]` — read or tail the profile event bus (events.jsonl).
//
//   events                    print recent events, human-readable, oldest→newest
//   events --follow / -f      tail live: stream new events as they arrive
//   events --event a,b,...    filter to these event types
//   events --ref <ref>        filter to one task ref
//   events --json             emit raw JSONL (one line per event), for piping
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../config.js";

const VALID_EVENTS = new Set(["enqueued", "run_start", "run_end", "pipeline_done", "blocked", "failed"]);

/**
 * Parse an event line as JSON; return null on failure.
 * @param {string} line
 * @returns {Record<string,any>|null}
 */
function parseLine(line) {
  try { return JSON.parse(line); } catch { return null; }
}

/**
 * Human-readable rendering of one event object.
 * @param {Record<string,any>} ev
 * @returns {string}
 */
export function renderEvent(ev) {
  const ts = ev.ts ? ev.ts.replace("T", " ").slice(0, 19) + "Z" : "?";
  const tag = String(ev.event ?? "?").padEnd(13);
  const ref = String(ev.ref ?? "?");
  const step = String(ev.step ?? "?");
  let extra = "";
  if (ev.model != null) extra += `  model=${ev.model}`;
  if (ev.outcome != null) extra += `  outcome=${ev.outcome}`;
  if (ev.costUsd != null) extra += `  cost=$${Number(ev.costUsd).toFixed(4)}`;
  if (ev.reason != null) extra += `  reason=${ev.reason}`;
  return `${ts}  ${tag}  ref=${ref}  step=${step}${extra}`;
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

  const filterRef = args.ref != null ? String(args.ref) : null;
  const jsonMode = !!args.json;
  const followMode = !!(args.follow || args.f);

  /**
   * Check whether an event object passes the active filters.
   * @param {Record<string,any>} ev
   * @returns {boolean}
   */
  function passes(ev) {
    if (filterEvents && !filterEvents.has(ev.event)) return false;
    if (filterRef && ev.ref !== filterRef) return false;
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
      console.log(renderEvent(ev));
    }
  }

  // Missing file → print nothing, exit 0.
  if (!fs.existsSync(eventsFile)) {
    if (!jsonMode) console.log("no events yet");
    return;
  }

  // Read and print existing lines.
  const raw = fs.readFileSync(eventsFile, "utf8");
  const existing = raw.split("\n").filter(Boolean);
  for (const line of existing) {
    const ev = parseLine(line);
    if (ev && passes(ev)) print(ev);
  }

  if (!followMode) return;

  // --follow: tail new lines appended to the file.
  let pos = fs.statSync(eventsFile).size;
  let buf = "";

  const drain = () => {
    let size;
    try { size = fs.statSync(eventsFile).size; } catch { return; }
    if (size < pos) pos = 0; // file rotated/truncated
    if (size === pos) return;
    const fd = fs.openSync(eventsFile, "r");
    const chunk = Buffer.alloc(size - pos);
    fs.readSync(fd, chunk, 0, chunk.length, pos);
    fs.closeSync(fd);
    pos = size;
    buf += chunk.toString("utf8");
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      const ev = parseLine(line);
      if (ev && passes(ev)) print(ev);
    }
  };

  fs.watch(eventsFile, { persistent: true }, drain);
  // Keep alive until Ctrl+C.
  await new Promise(() => {});
}
