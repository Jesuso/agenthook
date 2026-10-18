// Agent-facing read model, shared by the MCP server (src/mcp/), `agenthook tick` and
// `agenthook watch`. Everything here reads the state dir (heartbeat.json, running.json,
// queue.json, held.json, refmeta.json, events.jsonl, logs/) — never writes it, and works with
// the receiver down. Output is deliberately small: short keys, ids not blobs, truncated reasons,
// an `etag` so an unchanged poll costs ~10 tokens, and byte-offset `cursor`s so event reads are
// incremental. The live-only reads (board, prs) and every write go through the control socket.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { registryDir, peekConfig } from "./config.js";
import { listProfiles } from "./heartbeat.js";
import { HIDDEN_BY_DEFAULT } from "./events.js";
import { EPIC_REF_RE, epicDetail, epicStats, localEpics } from "./epics.js";
import { controlRequest, resolveProfileSock } from "./ui/control-client.js";
import { listRuns, resolveRunLog } from "./ui/logs.js";
import { readProfileState, buildRows, readJson, isObj } from "./ui/rows.js";
import { readHistory } from "./ui/stats.js";
import { pricingOf } from "./pricing.js";
import { normalizeQuota, normalizeTrip } from "./quota.js";

const REASON_MAX = 200;
const FAILED_MAX = 50;
const TITLE_MAX = 80;
const LOG_BYTES_MAX = 24 * 1024;
/** Control-socket call budgets: board/PR reads hit the tracker/forge; reconcile/run/release can walk a whole board. */
const LIVE_TIMEOUT_DEFAULT_MS = 20_000;
const LIVE_TIMEOUT_MS = /** @type {Record<string, number>} */ ({ reconcile: 120_000, run: 60_000, catchup: 60_000, release: 60_000, cancel: 60_000, pull: 60_000 });

/** @param {any} v @param {number} n */
const clip = (v, n) => (typeof v === "string" && v.length > n ? v.slice(0, n - 1) + "…" : v);

/** Keys that drift every call without the underlying state changing — excluded from the etag hash. */
const ETAG_VOLATILE_KEYS = new Set(["at", "etag", "ageS", "outTok"]);

/** Stable short hash of a payload, ignoring volatile keys (`at`, `etag`, `ageS`, `outTok`). @param {any} obj */
export function etagOf(obj) {
  return crypto
    .createHash("sha1")
    .update(JSON.stringify(obj, (k, v) => (ETAG_VOLATILE_KEYS.has(k) ? undefined : v)))
    .digest("hex")
    .slice(0, 12);
}

/**
 * Pick the profile a tool call targets. An explicit `arg` (state key, else unique label) wins;
 * otherwise `defaultKey` (the profile of the config discovered at startup); otherwise the only
 * profile that is up. Returns `{ entry }` or `{ error }` (never throws on ambiguity).
 * @param {string|undefined} arg @param {string|null} defaultKey @param {string} [registry]
 */
export function pickProfile(arg, defaultKey, registry = registryDir) {
  const all = listProfiles(registry).filter((p) => !p.ghost);
  const names = () => all.map((p) => p.stateKey).join(", ") || "(none)";
  if (arg) {
    const byKey = all.find((p) => p.stateKey === arg);
    if (byKey) return { entry: byKey };
    const byLabel = all.filter((p) => p.name === arg);
    if (byLabel.length === 1) return { entry: byLabel[0] };
    if (!byLabel.length) {
      // Agents type names from memory: fall back to a case-insensitive match, only when unique.
      const lc = arg.toLowerCase();
      const loose = all.filter((p) => p.stateKey.toLowerCase() === lc || p.name.toLowerCase() === lc);
      if (loose.length === 1) return { entry: loose[0] };
    }
    return { error: byLabel.length > 1 ? `profile "${arg}" is ambiguous; use a state key: ${names()}` : `unknown profile "${arg}"; known: ${names()}` };
  }
  const def = defaultKey && all.find((p) => p.stateKey === defaultKey);
  if (def) return { entry: def };
  const up = all.filter((p) => p.up);
  if (up.length === 1) return { entry: up[0] };
  return { error: `profile required; known: ${names()}` };
}

/**
 * Resolve several profiles for a multi-profile call: `all` = every non-ghost profile (up or
 * down — a down profile's events.jsonl is still readable); else each name through
 * `pickProfile`, deduped by state key. The first unresolvable name is the error.
 * @param {string[]} names @param {{all?: boolean}} [o] @param {string} [registry]
 * @returns {{entries: ReturnType<typeof listProfiles>} | {error: string}}
 */
export function pickProfiles(names, { all = false } = {}, registry = registryDir) {
  if (all) {
    const entries = listProfiles(registry).filter((p) => !p.ghost);
    return entries.length ? { entries } : { error: "no profiles" };
  }
  /** @type {ReturnType<typeof listProfiles>} */
  const entries = [];
  for (const name of names) {
    const r = pickProfile(name, null, registry);
    if ("error" in r) return { error: String(r.error) };
    if (!entries.some((e) => e.stateKey === r.entry.stateKey)) entries.push(r.entry);
  }
  return entries.length ? { entries } : { error: "no profiles" };
}

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

/** The state key of the config discoverable from `cwd`/--config, or null. @param {string} [configPath] */
export function defaultProfileKey(configPath) {
  try {
    return peekConfig({ configPath }).stateKey;
  } catch {
    return null;
  }
}

/** @param {any} t @param {any} meta */
const label = (t, meta) => ({ ...(meta?.displayId ? { id: String(meta.displayId) } : {}), ...(meta?.title ? { title: clip(String(meta.title), TITLE_MAX) } : {}), ...t });

/**
 * One profile's live picture in the fewest tokens that still answer "what is running, what is
 * waiting, can I start more?". `slots.free` already subtracts queued jobs and is 0 while paused / quota-paused / restarting / draining (nothing can start).
 * `quota` is the last Claude quota reading (quota.json — there with the receiver down too).
 * @param {ReturnType<typeof import('./heartbeat.js').readProfile>} entry
 * @param {{now?: number}} [opts]
 */
export function readStatus(entry, { now = Date.now() } = {}) {
  const hb = entry.heartbeat ?? {};
  const state = readProfileState(entry.dir);
  const max = typeof hb.maxConcurrent === "number" ? hb.maxConcurrent : null;
  const running = Object.entries(state.running).map(([ref, r]) => {
    const started = Date.parse(r?.startedAt);
    return label(
      {
        ref,
        step: r?.stepId,
        ageS: Number.isNaN(started) ? null : Math.max(0, Math.round((now - started) / 1000)),
        ...(r?.model ? { model: r.model } : {}),
        ...(typeof r?.output === "number" ? { outTok: r.output } : {}),
      },
      state.refmeta[ref],
    );
  });
  const queue = state.queue.map((j) => label({ ref: String(j.ref), step: j.stepId, ...(j.kind && j.kind !== "pipeline" ? { kind: j.kind } : {}) }, state.refmeta[j.ref]));
  const held = Object.entries(state.held).map(([ref, h]) =>
    label({ ref, step: h?.stepId, ...(h?.reason ? { why: clip(h.reason, REASON_MAX) } : {}), since: h?.heldAt }, state.refmeta[ref]),
  );
  // Tickets whose last word is a real failure (the dashboard's "needs you" minus held): not an
  // operator cancel, not dismissed, not re-run since. Newest first, from the events tail.
  const lastFailed = new Map();
  for (const e of state.events) if (e.event === "failed") lastFailed.set(e.ref, e);
  const failed = buildRows(entry.stateKey, state, { up: entry.up })
    .filter((r) => r.status === "failed")
    .map((r) => {
      const e = lastFailed.get(r.ref);
      return label({ ref: r.ref, step: e?.step || r.step, ...(e?.reason ? { why: clip(String(e.reason), REASON_MAX) } : {}), at: e?.ts }, state.refmeta[r.ref]);
    })
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))
    .slice(0, FAILED_MAX);
  const active = entry.up ? running.length : 0;
  const queued = entry.up ? queue.length : 0;
  // Queued jobs waiting on their step's own maxConcurrent, not on a slot (heartbeat; only set with step caps).
  const capped = Math.min(queued, Math.max(0, Number(hb.queue?.capped) || 0));
  const quotaPaused = normalizeTrip(hb.quotaPaused);
  const quota = normalizeQuota(state.quota);
  const out = {
    profile: entry.stateKey,
    up: entry.up,
    tracker: hb.tracker ?? null,
    slots: { max, active, queued, ...(capped ? { capped } : {}), free: max === null ? null : hb.paused || quotaPaused || hb.restartPending || hb.decommissionPending || hb.draining ? 0 : Math.max(0, max - active - (queued - capped)) },
    ...(hb.paused ? { paused: true } : {}),
    ...(quotaPaused ? { quotaPaused } : {}),
    ...(quota ? { quota } : {}),
    ...(hb.restartPending ? { restartPending: true } : {}),
    ...(hb.decommissionPending ? { decommissionPending: true } : {}),
    ...(hb.draining ? { draining: true } : {}),
    ...(hb.queueStage ? { backlog: hb.queueStage } : {}),
    running,
    queue,
    held,
    ...(failed.length ? { failed } : {}),
    ...(entry.up ? {} : { note: "receiver down — running/queue are from the last state on disk (interrupted/stalled)" }),
  };
  return { ...out, etag: etagOf(out) };
}

/** Compact one-line-per-profile listing. @param {string} [registry] */
export function readProfiles(registry = registryDir) {
  return listProfiles(registry)
    .filter((p) => !p.ghost)
    .map((p) => ({
      profile: p.stateKey,
      ...(p.name !== p.stateKey ? { label: p.name } : {}),
      up: p.up,
      tracker: p.heartbeat?.tracker ?? null,
      active: p.up ? p.heartbeat?.queue?.active ?? 0 : null,
      queued: p.up ? p.heartbeat?.queue?.queued ?? 0 : null,
      max: p.heartbeat?.maxConcurrent ?? null,
    }));
}

// ---------------------------------------------------------------- events

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
  for (const k of ["outcome", "reason", "detail", "costUsd", "estUsd", "costBasis", "unpriced", "target", "action", "displayId", "moveTo", "pr", "sha", "mergeable", "mergeState"]) {
    if (rest[k] !== undefined && rest[k] !== null) out[k] = k === "reason" || k === "detail" ? clip(rest[k], REASON_MAX) : rest[k];
  }
  return out;
}

/**
 * Events appended after byte `cursor`, filtered. Whole lines only: the returned cursor is the
 * end of the last complete line read, so a half-written line is picked up whole next time. A
 * cursor past EOF (log replaced/truncated) restarts at 0.
 * @param {string} dir @param {number} cursor
 * @param {{types?: Set<string>|null, ref?: string, limit?: number}} [filter]
 * @returns {{events: Record<string, any>[], cursor: number, truncated: boolean}}
 */
export function readEventsSince(dir, cursor, { types = null, ref, limit = 100 } = {}) {
  const file = path.join(dir, "events.jsonl");
  let fd;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return { events: [], cursor: 0, truncated: false };
  }
  try {
    const size = fs.fstatSync(fd).size;
    let from = Number.isInteger(cursor) && cursor >= 0 ? cursor : size;
    if (from > size) from = 0;
    const buf = Buffer.alloc(Math.min(size - from, 1024 * 1024));
    const n = fs.readSync(fd, buf, 0, buf.length, from);
    const text = buf.subarray(0, n);
    const lastNl = text.lastIndexOf(0x0a);
    if (lastNl === -1) return { events: [], cursor: from, truncated: false };
    /** @type {Record<string, any>[]} */
    const events = [];
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
        }
      }
      consumed += lineBytes;
    }
    return { events, cursor: truncated ? from + consumed : from + lastNl + 1, truncated };
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
  if (signal?.aborted) return { events: [], cursor: cur, truncated: false, timedOut: true }; // cancelled before the wait began
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

/** Merge per-profile event lists, each event tagged `profile`, ordered by `ts` (stable; best-effort across profiles). @param {[string, Record<string, any>[]][]} lists */
export function mergeTagged(lists) {
  return lists
    .flatMap(([profile, events]) => events.map((e) => /** @type {Record<string, any>} */ ({ ...e, profile })))
    .map((e, i) => ({ e, i }))
    .sort((a, b) => String(a.e.ts ?? "").localeCompare(String(b.e.ts ?? "")) || a.i - b.i)
    .map((x) => x.e);
}

/**
 * `waitForEvents` over several profiles: block until a matching event lands in any of them (or
 * `timeoutMs`). One wait per profile under a shared AbortController; the first to wake aborts
 * the rest, and an aborted wait re-reads before resolving — so every event read is returned and
 * each profile's cursor advances only past what it returned (no loss, no dupes). A profile with
 * no entry in `cursors` starts from "now". A profile whose dir disappears is dropped
 * (`onDrop(stateKey)`, key removed from the cursor) and the wait goes on over the rest with the
 * remaining budget; all dropped → `allDropped`. Still fs.watch-driven; the only timer is the timeout.
 * @param {ReturnType<typeof listProfiles>} entries @param {Record<string, number>|undefined} cursors
 * @param {{types?: Set<string>|null, ref?: string, limit?: number, timeoutMs: number, signal?: AbortSignal, onDrop?: (stateKey: string) => void}} o
 * @returns {Promise<{events: Record<string, any>[], cursor: Record<string, number>, timedOut: boolean, truncated: boolean, allDropped?: boolean}>}
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
    /** @type {[string, Record<string, any>[]][]} */
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
      if (r.events.length) lists.push([e.stateKey, r.events]);
    }
    if (lists.length) return { events: mergeTagged(lists), cursor, timedOut: false, truncated };
    // Only a disappearing profile ends a round early and re-waits; anything else is the timeout/abort.
    if (!dropped || signal?.aborted || Date.now() >= deadline) break;
  }
  return { events: [], cursor, timedOut: true, truncated: false, ...(watching.length ? {} : { allDropped: true }) };
}

// ------------------------------------------------------------------ runs & logs

/**
 * Run history for a ref (newest first) — step, outcome, cost, whether still running.
 * @param {string} profile @param {string} ref @param {string} dir @param {string} [registry]
 */
export function readRuns(profile, ref, dir, registry = registryDir) {
  const events = readProfileState(dir).events;
  // The step's stored summary (summaries.json) goes on the exact run that wrote it, only.
  const stored = readJson(path.join(dir, "summaries.json"), {}, isObj);
  const mine = Object.hasOwn(stored, ref) && isObj(stored[ref]) ? stored[ref] : {};
  return listRuns(registry, profile, ref, events, pricingOf(readJson(path.join(dir, "heartbeat.json"), null, isObj))).map((r) => {
    const s = Object.hasOwn(mine, r.step) ? mine[r.step] : null;
    return {
      run: r.run,
      step: r.step,
      at: r.startedAt,
      outcome: r.outcome,
      ...(r.costUsd !== null ? { costUsd: r.costUsd } : {}),
      ...(r.estUsd !== null ? { estUsd: r.estUsd } : {}),
      ...(r.costBasis !== null ? { costBasis: r.costBasis } : {}),
      ...(r.running ? { running: true } : {}),
      ...(isObj(s) && s.run === r.run && isObj(s.summary) ? { summary: s.summary } : {}),
    };
  });
}

/**
 * Last `lines` lines of a run log (the ref's newest run, or the named `run` / newest of
 * `step`). Capped at LOG_BYTES_MAX so a chatty agent can't blow the caller's context.
 * @param {string} profile @param {string} ref @param {string} dir
 * @param {{lines?: number, step?: string, run?: string}} [o] @param {string} [registry]
 */
export function readRunLogTail(profile, ref, dir, { lines = 40, step, run } = {}, registry = registryDir) {
  const runs = readRuns(profile, ref, dir, registry);
  const pick = run ? runs.find((r) => r.run === run) : runs.find((r) => !step || r.step === step);
  if (!pick) return { error: `no run log for ${ref}${step ? ` step ${step}` : ""}` };
  const file = resolveRunLog(registry, profile, pick.run);
  if (!file) return { error: "run log not readable" };
  const size = fs.statSync(file).size;
  const fd = fs.openSync(file, "r");
  try {
    const len = Math.min(size, LOG_BYTES_MAX);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    let text = buf.toString("utf8");
    if (size > len) text = text.slice(text.indexOf("\n") + 1);
    const all = text.trimEnd().split("\n");
    const n = Math.max(1, Math.min(lines, 400));
    return { run: pick.run, step: pick.step, running: !!pick.running, totalBytes: size, tail: all.slice(-n).join("\n").trimEnd() };
  } finally {
    fs.closeSync(fd);
  }
}

// ---------------------------------------------------------------- live (control socket)

/**
 * One control-socket request to a profile's live receiver.
 * @param {string} profile state key @param {string} cmd @param {any} args
 * @param {{registry?: string, timeoutMs?: number}} [o]
 * @returns {Promise<any>} the result; throws an Error whose message is agent-readable
 */
export async function live(profile, cmd, args, { registry = registryDir, timeoutMs } = {}) {
  const target = resolveProfileSock(registry, profile);
  if (!target) throw new Error(`unknown profile "${profile}"`);
  const limit = timeoutMs ?? LIVE_TIMEOUT_MS[cmd] ?? LIVE_TIMEOUT_DEFAULT_MS;
  let reply;
  try {
    reply = await controlRequest(target.sockPath, cmd, args, { timeoutMs: limit });
  } catch (e) {
    if (e.code === "timeout") {
      throw new Error(`${cmd}: no reply within ${limit / 1000}s — it may still be running; check status before retrying`);
    }
    const why = e.cause?.code;
    if (why === "ENOENT" || why === "ECONNREFUSED") {
      throw Object.assign(new Error(`receiver for "${profile}" is down — ${cmd} needs a live receiver (agenthook start)`), { code: "down" });
    }
    if (why === "EACCES" || why === "EPERM") throw new Error(`${cmd}: cannot open the control socket (${why}) — run as the user that owns the receiver`);
    throw new Error(`${cmd}: the control socket closed before replying (receiver restarting?) — check status before retrying`);
  }
  if (!reply.ok) throw new Error(reply.error);
  return reply.result;
}

/**
 * The receiver-down view of `epics`: the epics the profile's refmeta names (`epic` per ticket),
 * joined with its local rows and history — no tracker read, `live:false`. Null when `ref` names
 * none of them (an unknown ref down).
 * @param {ReturnType<typeof import('./heartbeat.js').readProfile>} entry
 * @param {{ref?: string|null, tz?: number}} [o]
 */
export function readLocalEpics(entry, { ref = null, tz = 0 } = {}) {
  const hb = entry.heartbeat;
  const state = readProfileState(entry.dir);
  const join = {
    rows: buildRows(entry.stateKey, state, { repository: hb?.repository ?? null, up: false }),
    events: readHistory(path.join(entry.dir, "events.jsonl")).events,
    forge: !!hb?.forge,
    tzOffset: tz,
  };
  const groups = localEpics(state.refmeta);
  const at = new Date().toISOString();
  if (ref === null) return { at, live: false, supported: true, epics: groups.map((g) => epicStats(g.epic, g.tickets, join)) };
  const hit = groups.find((g) => g.epic.ref === ref);
  return hit ? { at, live: false, supported: true, epic: epicDetail(hit.epic, hit.tickets, join) } : null;
}

/**
 * Epics: live via the receiver's `epics` op when it is up, else the local refmeta-based fallback
 * (`live:false`). An unknown ref while down throws naming the fallback explicitly.
 * @param {ReturnType<typeof import('./heartbeat.js').readProfile>} entry
 * @param {{ref?: string, fresh?: boolean, tz?: number, registry?: string}} [o]
 */
export async function readEpics(entry, { ref, fresh, tz, registry = registryDir } = {}) {
  if (ref !== undefined && !EPIC_REF_RE.test(ref)) throw new Error("invalid epic ref");
  const tzOffset = tz ?? new Date().getTimezoneOffset();
  if (entry.up) {
    try {
      return await live(entry.stateKey, "epics", { ...(ref !== undefined ? { ref } : {}), ...(fresh ? { fresh: true } : {}), tz: tzOffset }, { registry });
    } catch (e) {
      if (e.code !== "down") throw e;
    }
  }
  const local = readLocalEpics(entry, { ref: ref ?? null, tz: tzOffset });
  if (local === null) throw new Error(`no epic ${ref} (receiver down: only epics named by local tickets are known)`);
  return local;
}

/**
 * Everything a supervising agent needs per cycle in one object: status + (optionally) board and
 * open agent PRs + the events since `cursor`. Board/PR failures degrade to an `…Error` string
 * instead of failing the tick (no forge, receiver down, rate limit).
 * @param {ReturnType<typeof import('./heartbeat.js').readProfile>} entry
 * @param {{cursor?: number, board?: boolean, prs?: boolean, epics?: boolean, eventLimit?: number, registry?: string}} [o]
 */
export async function readTick(entry, { cursor, board = true, prs = true, epics = false, eventLimit = 50, registry = registryDir } = {}) {
  const status = readStatus(entry);
  /** @type {Record<string, any>} */
  const out = { ...status };
  const wantLive = entry.up;
  const [b, p, ep] = await Promise.all([
    board && wantLive ? live(entry.stateKey, "board", {}, { registry }).catch((e) => ({ error: e.message })) : null,
    prs && wantLive ? live(entry.stateKey, "prs", {}, { registry }).catch((e) => ({ error: e.message })) : null,
    epics ? readEpics(entry, { registry }).catch((e) => ({ error: e.message })) : null,
  ]);
  if (b) {
    if (b.error) out.boardError = b.error;
    else out.board = b.steps;
  }
  if (p) {
    if (p.error) out.prsError = p.error;
    else out.prs = p.prs.map((/** @type {any} */ x) => ({ n: x.number, ref: x.ref, ci: x.ci, ...(x.mergeable === false ? { conflict: true } : {}), ...(x.mergeState && x.mergeState !== "clean" ? { state: x.mergeState } : {}), ...(x.draft ? { draft: true } : {}), ...(typeof x.mine === "boolean" ? { mine: x.mine } : {}), ...(x.review ? { review: x.review } : {}) }));
  }
  if (ep) {
    if (ep.error) out.epicsError = ep.error;
    else if (ep.supported === false) out.epicsError = "tracker has no epic support";
    else {
      out.epicsLive = ep.live;
      out.epics = (ep.epics ?? []).map((/** @type {any} */ e) => {
        const { velocity, ...rest } = e;
        const { days: _days, ...v } = velocity;
        return { ...rest, velocity: v };
      });
    }
  }
  const since = readEventsSince(entry.dir, cursor ?? eventsCursor(entry.dir), { limit: eventLimit });
  out.events = since.events.map(compactEvent);
  out.cursor = since.cursor;
  delete out.etag;
  out.etag = etagOf(out);
  return out;
}
