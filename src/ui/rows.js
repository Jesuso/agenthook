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
const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);

/** Own-property lookup: refs are arbitrary strings ("constructor" must not hit the prototype).
 * @param {Record<string, any>} o @param {string} k */
const own = (o, k) => (Object.hasOwn(o, k) ? o[k] : undefined);

/** @param {string} f @param {any} fallback @param {(v: any) => boolean} ok */
function readJson(f, fallback, ok) {
  try {
    const v = JSON.parse(fs.readFileSync(f, "utf8"));
    return ok(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Parse the last `maxBytes` of a JSONL file. When the read starts mid-file the first
 * (partial) line is dropped; unparsable lines are skipped. Missing file → [].
 * @param {string} file @param {number} [maxBytes]
 * @returns {Record<string, any>[]}
 */
export function readEventsTail(file, maxBytes = EVENTS_TAIL_BYTES) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return [];
  }
  let text = "";
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
    text = buf.subarray(0, off).toString("utf8");
    if (start > 0) {
      const nl = text.indexOf("\n");
      text = nl === -1 ? "" : text.slice(nl + 1);
    }
  } catch {
    return [];
  } finally {
    fs.closeSync(fd);
  }
  /** @type {Record<string, any>[]} */
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (isObj(e) && typeof e.ref === "string" && e.ref) out.push(e);
    } catch {
      /* torn / garbage line */
    }
  }
  return out;
}

/**
 * @typedef {object} ProfileState
 * @property {Record<string, any>} running   running.json
 * @property {any[]} queue                    queue.json
 * @property {Record<string, any>} held       held.json
 * @property {Record<string, any>} refmeta    refmeta.json
 * @property {Record<string, any>[]} events   events.jsonl tail, oldest first
 */

/** Read a profile's state dir; missing or garbage files read as empty. @param {string} dir
 * @returns {ProfileState} */
export function readProfileState(dir) {
  return {
    running: readJson(path.join(dir, "running.json"), {}, isObj),
    queue: readJson(path.join(dir, "queue.json"), [], Array.isArray).filter(
      (/** @type {any} */ j) => isObj(j) && typeof j.ref === "string" && j.ref,
    ),
    held: readJson(path.join(dir, "held.json"), {}, isObj),
    refmeta: readJson(path.join(dir, "refmeta.json"), {}, isObj),
    events: readEventsTail(path.join(dir, "events.jsonl")),
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
    startedAt: str(hb?.startedAt),
    updatedAt: str(hb?.updatedAt),
    active: num(hb?.queue?.active),
    queued: num(hb?.queue?.queued),
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
