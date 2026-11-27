import fs from "node:fs";
import path from "node:path";
import { HIDDEN_BY_DEFAULT } from "../events.js";
import { listProfiles } from "../heartbeat.js";
import { REASON_MAX, clip } from "./common.js";

/** Why `v` is not a multi-profile cursor map (`{stateKey: byteOffset}`), or null. @param {any} v */
export function cursorMapError(v) {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return 'cursor must be a JSON object {"<stateKey>": <offset>}';
  for (const [k, n] of Object.entries(v)) if (!Number.isInteger(n) || n < 0) return `cursor for "${k}" must be a non-negative integer`;
  return null;
}

/**
 * Parse a CLI `--cursor` in multi-profile mode.
 * @param {string} str @returns {{cursors: Record<string, number>} | {error: string}}
 */
export function parseCursorMap(str) {
  let v;
  try {
    v = JSON.parse(String(str));
  } catch {
    return { error: `bad --cursor: not JSON (expected {"<stateKey>": <offset>})` };
  }
  const why = cursorMapError(v);
  return why ? { error: `bad --cursor: ${why}` } : { cursors: v };
}

/** Current end-of-file offset of events.jsonl — the cursor "from now on". @param {string} dir */
export function eventsCursor(dir) {
  try {
    return fs.statSync(path.join(dir, "events.jsonl")).size;
  } catch {
    return 0;
  }
}

/** Squash an event to the keys an agent acts on. @param {Record<string, any>} e */
export function compactEvent(e) {
  const { ts, event, ref, step, ...rest } = e;
  /** @type {Record<string, any>} */
  const out = { ts, e: event, ref, ...(step ? { step } : {}) };
  for (const k of ["outcome", "reason", "detail", "costUsd", "estUsd", "costBasis", "unpriced", "energyKwh", "energyUsd", "energySource", "target", "action", "displayId", "moveTo", "pr", "sha", "mergeable", "mergeState", "tier", "method", "readied", "mergedNow", "awaitingMerge", "plain", "options"]) {
    if (rest[k] !== undefined && rest[k] !== null) out[k] = k === "reason" || k === "detail" || k === "plain" ? clip(rest[k], REASON_MAX) : rest[k];
  }
  return out;
}

/**
 * Events appended after byte `cursor`, filtered. Whole lines only: the returned cursor is the
 * end of the last complete line read, so a half-written line is picked up whole next time. A
 * cursor past EOF (log replaced/truncated) restarts at 0. `ends[i]` is the byte offset just past
 * `events[i]`'s line — an exact per-event cursor (the batch `cursor` may sit past trailing
 * non-matching lines).
 * @param {string} dir @param {number} cursor
 * @param {{types?: Set<string>|null, ref?: string, limit?: number}} [filter]
 * @returns {{events: Record<string, any>[], ends: number[], cursor: number, truncated: boolean}}
 */
export function readEventsSince(dir, cursor, { types = null, ref, limit = 100 } = {}) {
  const file = path.join(dir, "events.jsonl");
  let fd;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return { events: [], ends: [], cursor: 0, truncated: false };
  }
  try {
    const size = fs.fstatSync(fd).size;
    let from = Number.isInteger(cursor) && cursor >= 0 ? cursor : size;
    if (from > size) from = 0;
    const buf = Buffer.alloc(Math.min(size - from, 1024 * 1024));
    const n = fs.readSync(fd, buf, 0, buf.length, from);
    const text = buf.subarray(0, n);
    const lastNl = text.lastIndexOf(0x0a);
    if (lastNl === -1) return { events: [], ends: [], cursor: from, truncated: false };
    /** @type {Record<string, any>[]} */
    const events = [];
    /** @type {number[]} */
    const ends = [];
    let consumed = 0;
    let truncated = false;
    for (const line of text.subarray(0, lastNl + 1).toString("utf8").split("\n")) {
      const lineBytes = Buffer.byteLength(line, "utf8") + 1;
      if (line.trim()) {
        /** @type {any} */
        let e = null;
        try {
          e = JSON.parse(line);
        } catch {
          /* torn/garbage line: skip */
        }
        const passesType = types ? types.has(e?.event) : !HIDDEN_BY_DEFAULT.has(e?.event);
        if (e && typeof e === "object" && passesType && (!ref || e.ref === ref)) {
          if (events.length >= limit) {
            truncated = true;
            break;
          }
          events.push(e);
          ends.push(from + consumed + lineBytes);
        }
      }
      consumed += lineBytes;
    }
    return { events, ends, cursor: truncated ? from + consumed : from + lastNl + 1, truncated };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Block until a matching event lands past `cursor`, or `timeoutMs` passes. Event-driven: an
 * fs.watch on the state dir wakes the read — there is no polling interval. `endIfGone` also
 * ends the wait (empty, `timedOut`) when the dir itself is removed.
 * @param {string} dir @param {number} cursor
 * @param {{types?: Set<string>|null, ref?: string, limit?: number, timeoutMs: number, signal?: AbortSignal, endIfGone?: boolean}} o
 */
export async function waitForEvents(dir, cursor, { timeoutMs, signal, endIfGone = false, ...filter }) {
  let cur = cursor;
  if (signal?.aborted) return { events: [], ends: [], cursor: cur, truncated: false, timedOut: true }; // cancelled before the wait began
  const first = readEventsSince(dir, cur, filter);
  if (first.events.length) return { ...first, timedOut: false };
  cur = first.cursor;
  return new Promise((resolve) => {
    /** @type {fs.FSWatcher|null} */
    let watcher = null;
    /** @type {NodeJS.Timeout|undefined} */
    let timer;
    let done = false;
    /** @param {boolean} timedOut */
    const finish = (timedOut) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      watcher?.close();
      signal?.removeEventListener("abort", onAbort);
      const r = readEventsSince(dir, cur, filter);
      resolve({ ...r, timedOut: timedOut && !r.events.length });
    };
    const onAbort = () => finish(true);
    const check = () => {
      if (done) return;
      const r = readEventsSince(dir, cur, filter);
      if (r.events.length) finish(false);
      else cur = r.cursor; // skip past non-matching lines
    };
    try {
      watcher = fs.watch(dir, (_ev, name) => {
        if (endIfGone && !fs.existsSync(dir)) finish(true);
        else if (!name || name === "events.jsonl") check();
      });
      watcher.on("error", () => finish(true));
    } catch {
      /* no watch support: the timeout still bounds the wait */
    }
    timer = setTimeout(() => finish(true), timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    check(); // close the gap between the first read and the watch starting
  });
}

/**
 * `mergeTagged`'s ordering, keeping each event's optional third-tuple-element offset
 * (`readEventsSince`'s `ends`) alongside it as `end`.
 * @param {([string, Record<string, any>[]] | [string, Record<string, any>[], number[]])[]} lists
 */
function mergeOrder(lists) {
  return lists
    .flatMap(([profile, events, ends]) => events.map((e, j) => ({ e: /** @type {Record<string, any>} */ ({ ...e, profile }), end: ends?.[j] })))
    .map((x, i) => ({ ...x, i }))
    .sort((a, b) => String(a.e.ts ?? "").localeCompare(String(b.e.ts ?? "")) || a.i - b.i);
}

/** Merge per-profile event lists, each event tagged `profile`, ordered by `ts` (stable; best-effort across profiles). @param {[string, Record<string, any>[]][]} lists */
export function mergeTagged(lists) {
  return mergeOrder(lists).map((x) => x.e);
}

/**
 * `waitForEvents` over several profiles: block until a matching event lands in any of them (or
 * `timeoutMs`). One wait per profile under a shared AbortController; the first to wake aborts
 * the rest, and an aborted wait re-reads before resolving — so every event read is returned and
 * each profile's cursor advances only past what it returned (no loss, no dupes). A profile with
 * no entry in `cursors` starts from "now". A profile whose dir disappears is dropped
 * (`onDrop(stateKey)`, key removed from the cursor) and the wait goes on over the rest with the
 * remaining budget; all dropped → `allDropped`. Still fs.watch-driven; the only timer is the timeout.
 * `ends[i]` is the byte offset just past `events[i]` in its own profile's log (see `readEventsSince`).
 * @param {ReturnType<typeof listProfiles>} entries @param {Record<string, number>|undefined} cursors
 * @param {{types?: Set<string>|null, ref?: string, limit?: number, timeoutMs: number, signal?: AbortSignal, onDrop?: (stateKey: string) => void}} o
 * @returns {Promise<{events: Record<string, any>[], ends: number[], cursor: Record<string, number>, timedOut: boolean, truncated: boolean, allDropped?: boolean}>}
 */
export async function waitForEventsMulti(entries, cursors, { timeoutMs, signal, onDrop, ...filter }) {
  const deadline = Date.now() + timeoutMs;
  /** @type {Record<string, number>} */
  const cursor = {};
  for (const e of entries) cursor[e.stateKey] = cursors && Object.hasOwn(cursors, e.stateKey) && Number.isInteger(cursors[e.stateKey]) ? cursors[e.stateKey] : eventsCursor(e.dir);
  let watching = [...entries];
  /** @param {string} key */
  const drop = (key) => {
    delete cursor[key];
    watching = watching.filter((e) => e.stateKey !== key);
    onDrop?.(key);
  };
  for (const e of entries) if (!fs.existsSync(e.dir)) drop(e.stateKey);
  while (watching.length) {
    const ac = new AbortController();
    const chain = () => ac.abort();
    if (signal?.aborted) ac.abort();
    else signal?.addEventListener("abort", chain, { once: true });
    const timeLeft = Math.max(0, deadline - Date.now());
    const results = await Promise.all(
      watching.map((e) =>
        waitForEvents(e.dir, cursor[e.stateKey], { ...filter, timeoutMs: timeLeft, signal: ac.signal, endIfGone: true }).then((r) => {
          ac.abort(); // the first wait to end (event, timeout or gone) ends the round
          return /** @type {const} */ ([e, r]);
        }),
      ),
    );
    signal?.removeEventListener("abort", chain);
    /** @type {[string, Record<string, any>[], number[]][]} */
    const lists = [];
    let truncated = false;
    let dropped = false;
    for (const [e, r] of results) {
      if (!r.events.length && !fs.existsSync(e.dir)) {
        drop(e.stateKey);
        dropped = true;
        continue;
      }
      cursor[e.stateKey] = r.cursor;
      truncated ||= r.truncated;
      if (r.events.length) lists.push([e.stateKey, r.events, r.ends]);
    }
    if (lists.length) {
      const merged = mergeOrder(lists);
      return { events: merged.map((x) => x.e), ends: merged.map((x) => /** @type {number} */ (x.end)), cursor, timedOut: false, truncated };
    }
    // Only a disappearing profile ends a round early and re-waits; anything else is the timeout/abort.
    if (!dropped || signal?.aborted || Date.now() >= deadline) break;
  }
  return { events: [], ends: [], cursor, timedOut: true, truncated: false, ...(watching.length ? {} : { allDropped: true }) };
}
