// `ah ui` view-model builders (pure over a state dir, so tests point them at fixtures).
// Blind reader: opens the profile's state files read-only and never writes anything.
// One TicketRow per ref merges running ∪ queue ∪ held ∪ refmeta ∪ the events tail.
import fs from "node:fs";
import path from "node:path";
import { registryDir } from "../config.js";
import { listProfiles } from "../heartbeat.js";

/** Only the last N bytes of events.jsonl are read — the file is append-only and unbounded. */
export const EVENTS_TAIL_BYTES = 256 * 1024;

const REPOSITORY_RE = /^[\w.-]+\/[\w.-]+$/;

/** @param {any} v */
export const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);

/** Own-property lookup: refs are arbitrary strings ("constructor" must not hit the prototype).
 * @param {Record<string, any>} o @param {string} k */
const own = (o, k) => (Object.hasOwn(o, k) ? o[k] : undefined);

/**
 * Missing file → `fallback`. Present but unreadable / unparsable / wrong shape → `prev`
 * (default `fallback`): state files are rewritten non-atomically, so a live reader that
 * passes its last good value never sees a torn write as "empty".
 * @param {string} f @param {any} fallback @param {(v: any) => boolean} ok @param {any} [prev]
 */
export function readJson(f, fallback, ok, prev = fallback) {
  /** @type {string} */
  let text;
  try {
    text = fs.readFileSync(f, "utf8");
  } catch (e) {
    return e.code === "ENOENT" ? fallback : prev;
  }
  try {
    const v = JSON.parse(text);
    return ok(v) ? v : prev;
  } catch {
    return prev;
  }
}

/** One events.jsonl line → the event, or null for garbage / a line without a ref.
 * @param {string} line @returns {Record<string, any>|null} */
export function parseEventLine(line) {
  if (!line.trim()) return null;
  try {
    const e = JSON.parse(line);
    return isObj(e) && typeof e.ref === "string" && e.ref ? e : null;
  } catch {
    return null; /* torn / garbage line */
  }
}

/**
 * Parse the last `maxBytes` of a JSONL file. When the read starts mid-file the first
 * (partial) line is dropped; unparsable lines are skipped. Missing file → [].
 * @param {string} file @param {number} [maxBytes]
 * @returns {Record<string, any>[]}
 */
export function readEventsTail(file, maxBytes = EVENTS_TAIL_BYTES) {
  return tail(file, maxBytes, false).events;
}

/**
 * readEventsTail for a live tailer: parses complete lines only and returns `end`, the byte
 * offset just past the last "\n" — where the next incremental read starts, so a line still
 * being appended is picked up whole later.
 * @param {string} file @param {number} [maxBytes]
 * @returns {{ events: Record<string, any>[], end: number }}
 */
export function seedEventsTail(file, maxBytes = EVENTS_TAIL_BYTES) {
  return tail(file, maxBytes, true);
}

/** @param {string} file @param {number} maxBytes @param {boolean} wholeLines */
function tail(file, maxBytes, wholeLines) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return { events: [], end: 0 };
  }
  let text = "";
  let end = 0;
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    // Read one byte early so a tail that starts exactly on a line boundary keeps that line:
    // everything up to the first "\n" is dropped, and that's just the previous line's end.
    const from = start > 0 ? start - 1 : 0;
    const buf = Buffer.alloc(size - from);
    let off = 0;
    while (off < buf.length) {
      const n = fs.readSync(fd, buf, off, buf.length - off, from + off);
      if (n <= 0) break;
      off += n;
    }
    let bytes = buf.subarray(0, off);
    end = from + off;
    if (wholeLines) {
      const last = bytes.lastIndexOf(0x0a);
      bytes = bytes.subarray(0, last + 1);
      end = from + last + 1;
    }
    text = bytes.toString("utf8");
    if (start > 0) {
      const nl = text.indexOf("\n");
      text = nl === -1 ? "" : text.slice(nl + 1);
    }
  } catch {
    return { events: [], end: 0 };
  } finally {
    fs.closeSync(fd);
  }
  /** @type {Record<string, any>[]} */
  const events = [];
  for (const line of text.split("\n")) {
    const e = parseEventLine(line);
    if (e) events.push(e);
  }
  return { events, end };
}

/**
 * @typedef {object} ProfileState
 * @property {Record<string, any>} running   running.json
 * @property {any[]} queue                    queue.json
 * @property {Record<string, any>} held       held.json
 * @property {Record<string, any>} refmeta    refmeta.json
 * @property {Record<string, any>[]} events   events.jsonl tail, oldest first
 */

/** @typedef {'running'|'queue'|'held'|'refmeta'} StateKey */

/** @type {Record<StateKey, [file: string, empty: () => any, ok: (v: any) => boolean]>} */
export const STATE_FILES = {
  running: ["running.json", () => ({}), isObj],
  queue: ["queue.json", () => [], Array.isArray],
  held: ["held.json", () => ({}), isObj],
  refmeta: ["refmeta.json", () => ({}), isObj],
};

/** Read one state file (see readJson for the `prev` torn-read rule).
 * @param {string} dir @param {StateKey} key @param {any} [prev] */
export function readStateFile(dir, key, prev) {
  const [file, empty, ok] = STATE_FILES[key];
  const fallback = empty();
  const v = readJson(path.join(dir, file), fallback, ok, prev ?? fallback);
  return key === "queue" ? v.filter((/** @type {any} */ j) => isObj(j) && typeof j.ref === "string" && j.ref) : v;
}

/** Read a profile's state dir; missing or garbage files read as empty. `events` (the live
 * watcher's in-memory tail) replaces the events.jsonl read when given.
 * @param {string} dir @param {Record<string, any>[]} [events]
 * @returns {ProfileState} */
export function readProfileState(dir, events) {
  return {
    running: readStateFile(dir, "running"),
    queue: readStateFile(dir, "queue"),
    held: readStateFile(dir, "held"),
    refmeta: readStateFile(dir, "refmeta"),
    events: events ?? readEventsTail(path.join(dir, "events.jsonl")),
  };
}

/** @param {any} v */
const str = (v) => (typeof v === "string" && v ? v : null);

/**
 * One TicketRow per ref. Status precedence: running > queued > held > the last terminal
 * event in the tail (pipeline_done/merged → done, failed → failed) > idle. A terminal event
 * followed by a later `enqueued`/`run_start` for the ref no longer counts (it was re-run).
 * `costUsd` sums `run_end.costUsd` within the tail only — an approximation for old refs.
 * @param {string} profile
 * @param {ProfileState} state
 * @param {{ repository?: string|null }} [opts]
 * @returns {import('./contract.js').TicketRow[]}
 */
export function buildRows(profile, state, { repository = null } = {}) {
  const repo = typeof repository === "string" && REPOSITORY_RE.test(repository) ? repository : null;
  /** @type {Map<string, Record<string, any>[]>} */
  const eventsByRef = new Map();
  for (const e of state.events) {
    const list = eventsByRef.get(e.ref);
    if (list) list.push(e);
    else eventsByRef.set(e.ref, [e]);
  }
  const refs = new Set([
    ...Object.keys(state.running),
    ...state.queue.map((j) => String(j.ref)),
    ...Object.keys(state.held),
    ...Object.keys(state.refmeta),
    ...eventsByRef.keys(),
  ]);

  /** @type {import('./contract.js').TicketRow[]} */
  const rows = [];
  for (const ref of refs) {
    const running = own(state.running, ref);
    const run = isObj(running) ? running : null;
    const queued = state.queue.find((j) => j.ref === ref) || null;
    const heldRaw = own(state.held, ref);
    const held = isObj(heldRaw) ? heldRaw : null;
    const metaRaw = own(state.refmeta, ref);
    const meta = isObj(metaRaw) ? metaRaw : {};
    const events = eventsByRef.get(ref) || [];

    /** @type {'done'|'failed'|null} */
    let terminal = null;
    /** @type {Record<string, any>|null} */
    let lastStart = null;
    /** @type {string|null} */
    let lastStep = null;
    /** @type {string|null} */
    let lastName = null;
    let costUsd = 0;
    for (const e of events) {
      if (e.event === "run_start") lastStart = e;
      if (e.event === "run_start" || e.event === "enqueued") terminal = null;
      else if (e.event === "pipeline_done" || e.event === "merged") terminal = "done";
      else if (e.event === "failed") terminal = "failed";
      if (e.event === "run_end" && typeof e.costUsd === "number" && Number.isFinite(e.costUsd)) costUsd += e.costUsd;
      lastStep = str(e.step) ?? lastStep;
      lastName = str(e.name) ?? lastName;
    }

    /** @type {import('./contract.js').TicketStatus} */
    const status = run ? "running" : queued ? "queued" : held ? "held" : terminal ?? "idle";
    const pr = meta.pr;
    const trackerUrl = str(meta.url);
    rows.push({
      profile,
      ref,
      displayId: str(meta.displayId) ?? ref,
      title: str(meta.title) ?? lastName,
      step: str(run?.stepId) ?? str(queued?.stepId) ?? str(held?.stepId) ?? lastStep,
      status,
      model: run ? str(run.model) : str(lastStart?.model),
      startedAt: run ? str(run.startedAt) : str(lastStart?.ts),
      costUsd,
      trackerUrl: trackerUrl && /^https?:\/\//i.test(trackerUrl) ? trackerUrl : null,
      prUrl: repo && Number.isInteger(pr) && pr > 0 ? `https://github.com/${repo}/pull/${pr}` : null,
      heldReason: str(held?.reason),
    });
  }
  return rows;
}

/**
 * Whitelisted heartbeat projection: no ingress URL, no paths, nothing beyond ProfileView.
 * `active`/`queued` are blanked to null when the profile is down — a dead profile's
 * heartbeat.json keeps the last counts it wrote, which would otherwise read as stale
 * live state. `maxConcurrent`, `lastEvent`, `startedAt`, `updatedAt` are history/config,
 * not live counts, so they survive.
 * @param {{ name: string, pid: number, up: boolean, heartbeat: any }} p
 * @returns {import('./contract.js').ProfileView}
 */
export function profileView(p) {
  const hb = isObj(p.heartbeat) ? p.heartbeat : null;
  /** @param {any} v */
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return {
    name: p.name,
    up: p.up,
    pid: p.pid || null,
    port: num(hb?.port),
    tracker: str(hb?.tracker),
    ingress: str(hb?.ingress),
    fullAuto: typeof hb?.fullAuto === "boolean" ? hb.fullAuto : null,
    maxConcurrent: num(hb?.maxConcurrent),
    startedAt: str(hb?.startedAt),
    updatedAt: str(hb?.updatedAt),
    active: p.up ? num(hb?.queue?.active) : null,
    queued: p.up ? num(hb?.queue?.queued) : null,
    lastEvent: isObj(hb?.lastEvent)
      ? { at: str(hb.lastEvent.at), kind: str(hb.lastEvent.kind), ref: str(hb.lastEvent.ref), step: str(hb.lastEvent.step) }
      : null,
  };
}

/** Every profile under `registry` plus its merged ticket rows. Read-only.
 * @param {string} [registry]
 * @returns {import('./contract.js').Snapshot} */
export function buildSnapshot(registry = registryDir) {
  /** @type {import('./contract.js').Snapshot} */
  const snap = { profiles: [], tickets: [] };
  for (const p of listProfiles(registry)) {
    snap.profiles.push(profileView(p));
    const repository = isObj(p.heartbeat) ? p.heartbeat.repository : null;
    snap.tickets.push(...buildRows(p.name, readProfileState(p.dir), { repository }));
  }
  return snap;
}
