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
import { controlRequest, resolveProfileSock } from "./ui/control-client.js";
import { listRuns, resolveRunLog } from "./ui/logs.js";
import { readProfileState } from "./ui/rows.js";

const REASON_MAX = 200;
const TITLE_MAX = 80;
const LOG_BYTES_MAX = 24 * 1024;

/** @param {any} v @param {number} n */
const clip = (v, n) => (typeof v === "string" && v.length > n ? v.slice(0, n - 1) + "…" : v);

/** Stable short hash of a payload, ignoring volatile `at`/`etag` keys. @param {any} obj */
export function etagOf(obj) {
  return crypto
    .createHash("sha1")
    .update(JSON.stringify(obj, (k, v) => (k === "at" || k === "etag" || k === "ageS" ? undefined : v)))
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
    return { error: byLabel.length > 1 ? `profile "${arg}" is ambiguous; use a state key: ${names()}` : `unknown profile "${arg}"; known: ${names()}` };
  }
  const def = defaultKey && all.find((p) => p.stateKey === defaultKey);
  if (def) return { entry: def };
  const up = all.filter((p) => p.up);
  if (up.length === 1) return { entry: up[0] };
  return { error: `profile required; known: ${names()}` };
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
 * waiting, can I start more?". `slots.free` already subtracts queued jobs.
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
  const active = entry.up ? running.length : 0;
  const out = {
    profile: entry.stateKey,
    up: entry.up,
    tracker: hb.tracker ?? null,
    slots: { max, active, queued: entry.up ? queue.length : 0, free: max === null ? null : Math.max(0, max - active - (entry.up ? queue.length : 0)) },
    ...(hb.paused ? { paused: true } : {}),
    ...(hb.restartPending ? { restartPending: true } : {}),
    ...(hb.decommissionPending ? { decommissionPending: true } : {}),
    ...(hb.draining ? { draining: true } : {}),
    ...(hb.queueStage ? { backlog: hb.queueStage } : {}),
    running,
    queue,
    held,
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
  for (const k of ["outcome", "reason", "costUsd", "target", "action", "displayId", "moveTo"]) {
    if (rest[k] !== undefined && rest[k] !== null) out[k] = k === "reason" ? clip(rest[k], REASON_MAX) : rest[k];
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
        if (e && typeof e === "object" && (!types || types.has(e.event)) && (!ref || e.ref === ref)) {
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
 * fs.watch on the state dir wakes the read — there is no polling interval.
 * @param {string} dir @param {number} cursor
 * @param {{types?: Set<string>|null, ref?: string, limit?: number, timeoutMs: number, signal?: AbortSignal}} o
 */
export async function waitForEvents(dir, cursor, { timeoutMs, signal, ...filter }) {
  let cur = cursor;
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
        if (!name || name === "events.jsonl") check();
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

// ------------------------------------------------------------------ runs & logs

/**
 * Run history for a ref (newest first) — step, outcome, cost, whether still running.
 * @param {string} profile @param {string} ref @param {string} dir @param {string} [registry]
 */
export function readRuns(profile, ref, dir, registry = registryDir) {
  const events = readProfileState(dir).events;
  return listRuns(registry, profile, ref, events).map((r) => ({
    run: r.run,
    step: r.step,
    at: r.startedAt,
    outcome: r.outcome,
    ...(r.costUsd !== null ? { costUsd: r.costUsd } : {}),
    ...(r.running ? { running: true } : {}),
  }));
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
export async function live(profile, cmd, args, { registry = registryDir, timeoutMs = 20000 } = {}) {
  const target = resolveProfileSock(registry, profile);
  if (!target) throw new Error(`unknown profile "${profile}"`);
  let reply;
  try {
    reply = await controlRequest(target.sockPath, cmd, args, { timeoutMs });
  } catch (e) {
    throw new Error(e.code === "timeout" ? `${cmd}: receiver did not answer in ${timeoutMs / 1000}s` : `receiver for "${profile}" is down — ${cmd} needs a live receiver (agenthook start)`);
  }
  if (!reply.ok) throw new Error(reply.error);
  return reply.result;
}

/**
 * Everything a supervising agent needs per cycle in one object: status + (optionally) board and
 * open agent PRs + the events since `cursor`. Board/PR failures degrade to an `…Error` string
 * instead of failing the tick (no forge, receiver down, rate limit).
 * @param {ReturnType<typeof import('./heartbeat.js').readProfile>} entry
 * @param {{cursor?: number, board?: boolean, prs?: boolean, eventLimit?: number, registry?: string}} [o]
 */
export async function readTick(entry, { cursor, board = true, prs = true, eventLimit = 50, registry = registryDir } = {}) {
  const status = readStatus(entry);
  /** @type {Record<string, any>} */
  const out = { ...status };
  const wantLive = entry.up;
  const [b, p] = await Promise.all([
    board && wantLive ? live(entry.stateKey, "board", {}, { registry }).catch((e) => ({ error: e.message })) : null,
    prs && wantLive ? live(entry.stateKey, "prs", {}, { registry }).catch((e) => ({ error: e.message })) : null,
  ]);
  if (b) {
    if (b.error) out.boardError = b.error;
    else out.board = b.steps;
  }
  if (p) {
    if (p.error) out.prsError = p.error;
    else out.prs = p.prs.map((/** @type {any} */ x) => ({ n: x.number, ref: x.ref, ci: x.ci, ...(x.mergeable === false ? { conflict: true } : {}), ...(x.mergeState && x.mergeState !== "clean" ? { state: x.mergeState } : {}), ...(x.draft ? { draft: true } : {}) }));
  }
  const since = readEventsSince(entry.dir, cursor ?? eventsCursor(entry.dir), { limit: eventLimit });
  out.events = since.events.map(compactEvent);
  out.cursor = since.cursor;
  delete out.etag;
  out.etag = etagOf(out);
  return out;
}
