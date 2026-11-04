// `agenthook watch [name…|--all] [--event a,b] [--ref r] [--cursor <n|json>] [--timeout <s>] [--json]
//   [--follow|--stream [--heartbeat <s>]]` —
// block until the next matching pipeline event, print it, exit 0 (exit 2 on --timeout). Built
// to be the body of a Claude Code `Monitor`/background task or a shell `until` loop: the agent
// sleeps for free and wakes only when something happens (event-driven — fs.watch, no polling).
// With no --cursor it starts from "now"; the printed `cursor` resumes without gaps.
// Multi-profile mode (`--all` or ≥2 names) waits on the union: every event carries its profile's
// state key and the cursor is a JSON object `{stateKey: offset}`. One name / none = one profile.
// `--follow` (alias `--stream`) stays attached instead: one JSON object per line, each event
// carrying the exact cursor just past it (resume from any line with no loss or dupes), an optional
// `{"e":"heartbeat"}` line every --heartbeat seconds, and a final `{"e":"watch_end"}` line. Ends on
// SIGTERM/SIGINT (exit 0), the total --timeout (exit 2, `timedOut`) or every profile gone (exit 1).
// `--actionable` wakes only for events that need a human/supervisor (src/actionable.js), folds the
// rest into a `summary` (counts + refs) printed with the next wake or the timeout, and reports a
// stopped receiver as a `daemon_down` event instead of waiting out the timeout on a dead log.
// `--wake a,b` / `--quiet a,b` add to / remove from the built-in actionable list by event type.
import path from "node:path";
import { defaultProfileKey, pickProfile, pickProfiles, parseCursorMap, waitForEvents, waitForEventsMulti, eventsCursor, compactEvent } from "../agent-api.js";
import { isActionable, createSummary, summaryLine } from "../actionable.js";
import { readProfile } from "../heartbeat.js";
import { readJson, isObj } from "../ui/rows.js";

/** One text line per event. @param {Record<string, any>} e */
const line = (e) =>
  `${e.ts} ${e.e} ${e.ref}${e.step ? `/${e.step}` : ""}${e.outcome ? ` → ${e.outcome}` : ""}${e.reason ? ` (${e.reason})` : ""}${e.pr ? ` PR#${e.pr}` : ""}${e.sha ? ` ${String(e.sha).slice(0, 7)}` : ""}${e.mergeState ? ` ${e.mergeState}` : ""}${e.tier ? ` tier=${e.tier}` : ""}`;

/** @param {any} args */
const types = (args) => (args.event ? new Set(String(args.event).split(",").map((s) => s.trim()).filter(Boolean)) : null);
/** A comma list flag as a Set, or undefined. @param {unknown} v */
const csv = (v) => (v ? new Set(String(v).split(",").map((s) => s.trim()).filter(Boolean)) : undefined);
/** @param {number} timeoutS */
const timeoutMs = (timeoutS) => (timeoutS > 0 ? timeoutS * 1000 : 2 ** 31 - 1);

/** @param {any} args */
const following = (args) => args.follow === true || args.stream === true;
/** One JSON line on stdout. @param {Record<string, any>} o */
const emit = (o) => console.log(JSON.stringify(o));

/**
 * @param {any} args
 * @param {{signal?: AbortSignal}} [opts] `signal` stops a `--follow` stream (tests); the CLI wires SIGTERM/SIGINT instead.
 */
export async function watch(args, opts = {}) {
  if (args.actionable === true) return watchActionable(args, opts);
  if (args.all === true || args._.length >= 2) return watchMulti(args, opts);
  const picked = pickProfile(args._[0], defaultProfileKey(args.config));
  if ("error" in picked) {
    console.error(picked.error);
    process.exitCode = 1;
    return;
  }
  const { entry } = picked;
  const cursor = args.cursor !== undefined ? Number(args.cursor) : eventsCursor(entry.dir);
  if (following(args)) return followOne(entry.dir, Number.isInteger(cursor) && cursor >= 0 ? cursor : eventsCursor(entry.dir), args, opts);
  const timeoutS = args.timeout !== undefined ? Number(args.timeout) : 0;
  const r = await waitForEvents(entry.dir, cursor, { types: types(args), ref: args.ref, limit: 100, timeoutMs: timeoutMs(timeoutS) });
  const events = r.events.map(compactEvent);
  if (args.json) console.log(JSON.stringify({ events, cursor: r.cursor, ...(r.timedOut ? { timedOut: true } : {}) }));
  else {
    for (const e of events) console.log(line(e));
    if (r.timedOut) console.log(`(no event in ${timeoutS}s) cursor ${r.cursor}`);
    else console.log(`cursor ${r.cursor}`);
  }
  if (r.timedOut) process.exitCode = 2;
}

/** @param {any} args @param {{signal?: AbortSignal}} opts */
async function watchMulti(args, opts) {
  const picked = pickProfiles(args._, { all: args.all === true });
  if ("error" in picked) {
    console.error(picked.error);
    process.exitCode = 1;
    return;
  }
  /** @type {Record<string, number>|undefined} */
  let cursors;
  if (args.cursor !== undefined) {
    const parsed = parseCursorMap(args.cursor);
    if ("error" in parsed) {
      console.error(parsed.error);
      process.exitCode = 1;
      return;
    }
    cursors = parsed.cursors;
  }
  if (following(args)) return followMulti(picked.entries, cursors, args, opts);
  const timeoutS = args.timeout !== undefined ? Number(args.timeout) : 0;
  const r = await waitForEventsMulti(picked.entries, cursors, {
    types: types(args),
    ref: args.ref,
    limit: 100,
    timeoutMs: timeoutMs(timeoutS),
    onDrop: (key) => console.error(`profile ${key} disappeared; dropped`),
  });
  if (r.allDropped) {
    console.error("every watched profile disappeared");
    process.exitCode = 1;
    return;
  }
  const events = r.events.map((e) => ({ ...compactEvent(e), profile: e.profile }));
  const cursor = JSON.stringify(r.cursor);
  if (args.json) console.log(JSON.stringify({ events, cursor: r.cursor, ...(r.timedOut ? { timedOut: true } : {}) }));
  else {
    for (const e of events) console.log(`${e.profile} ${line(e)}`);
    if (r.timedOut) console.log(`(no event in ${timeoutS}s) cursor ${cursor}`);
    else console.log(`cursor ${cursor}`);
  }
  if (r.timedOut) process.exitCode = 2;
}

/**
 * The `--follow` loop: run `round` (one wait + print) until the signal aborts (exit 0), the total
 * --timeout deadline passes (exit 2) or `round` returns false (exit 1), with a heartbeat line every
 * --heartbeat seconds (a stdout keepalive; it reads nothing), then a final `watch_end` line.
 * @param {any} args @param {{signal?: AbortSignal}} opts
 * @param {() => number|Record<string, number>} current the cursor a heartbeat/`watch_end` reports
 * @param {(signal: AbortSignal, timeoutMs: number) => Promise<boolean>} round
 */
async function stream(args, opts, current, round) {
  const ac = new AbortController();
  const stop = () => ac.abort();
  if (opts.signal?.aborted) ac.abort();
  else if (opts.signal) opts.signal.addEventListener("abort", stop, { once: true });
  else {
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
  }
  const timeoutS = args.timeout !== undefined ? Number(args.timeout) : 0;
  const deadline = timeoutS > 0 ? Date.now() + timeoutS * 1000 : Infinity;
  const heartbeatS = Number(args.heartbeat);
  const heartbeat = heartbeatS > 0 ? setInterval(() => emit({ e: "heartbeat", cursor: current() }), heartbeatS * 1000) : undefined;
  let timedOut = false;
  let gone = false;
  try {
    while (!ac.signal.aborted) {
      const left = deadline - Date.now();
      if (left <= 0) {
        timedOut = true;
        break;
      }
      if (!(await round(ac.signal, Math.min(left, 2 ** 31 - 1)))) {
        gone = true;
        break;
      }
    }
  } finally {
    clearInterval(heartbeat);
    opts.signal?.removeEventListener("abort", stop);
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
  }
  emit({ e: "watch_end", cursor: current(), ...(timedOut ? { timedOut: true } : {}) });
  process.exitCode = gone ? 1 : timedOut ? 2 : 0;
}

/** @param {string} dir @param {number} start @param {any} args @param {{signal?: AbortSignal}} opts */
async function followOne(dir, start, args, opts) {
  let cursor = start;
  await stream(args, opts, () => cursor, async (signal, ms) => {
    const r = await waitForEvents(dir, cursor, { types: types(args), ref: args.ref, limit: 100, timeoutMs: ms, signal });
    r.events.forEach((/** @type {Record<string, any>} */ e, /** @type {number} */ i) => emit({ ...compactEvent(e), cursor: r.ends[i] }));
    cursor = r.cursor;
    return true;
  });
}

/**
 * Multi-profile `--follow`: each line's cursor is a running map — the round's starting cursors with
 * the printed event's profile moved just past it — so any line resumes exactly.
 * @param {Parameters<typeof waitForEventsMulti>[0]} entries @param {Record<string, number>|undefined} cursors
 * @param {any} args @param {{signal?: AbortSignal}} opts
 */
async function followMulti(entries, cursors, args, opts) {
  let watching = entries;
  /** @type {Record<string, number>} */
  let cursor = {};
  for (const e of watching) cursor[e.stateKey] = cursors && Object.hasOwn(cursors, e.stateKey) ? cursors[e.stateKey] : eventsCursor(e.dir);
  await stream(args, opts, () => cursor, async (signal, ms) => {
    const r = await waitForEventsMulti(watching, cursor, {
      types: types(args),
      ref: args.ref,
      limit: 100,
      timeoutMs: ms,
      signal,
      onDrop: (key) => console.error(`profile ${key} disappeared; dropped`),
    });
    if (r.allDropped) {
      console.error("every watched profile disappeared");
      cursor = r.cursor;
      return false;
    }
    watching = watching.filter((e) => Object.hasOwn(r.cursor, e.stateKey));
    const running = Object.fromEntries(Object.entries(cursor).filter(([k]) => Object.hasOwn(r.cursor, k)));
    r.events.forEach((e, i) => {
      running[e.profile] = r.ends[i];
      emit({ ...compactEvent(e), profile: e.profile, cursor: { ...running } });
    });
    cursor = r.cursor;
    return true;
  });
}

// ---------------------------------------------------------------- --actionable

/** Default seconds between receiver liveness checks while an `--actionable` watch waits. */
const LIVENESS_DEFAULT_S = 60;

/**
 * One profile's liveness, from its pidfile (the heartbeat is only written on change, so its age
 * says nothing about a quiet receiver).
 * @param {{stateKey: string, dir: string}} entry
 * @returns {{up: boolean, lastSeenAt: string|null}}
 */
function liveness(entry) {
  const p = readProfile(entry.stateKey, path.dirname(entry.dir));
  return { up: p.up, lastSeenAt: p.lastSeenAt };
}

/**
 * `--actionable`: wait (in rounds of at most --liveness seconds) until an actionable event lands
 * or a watched receiver is down, then print the actionable events plus the summary of everything
 * else read since the last wake. One-shot exits after the first wake (0) or at --timeout (2, with
 * the summary); `--follow` prints one `{"e":"actionable"}` line per wake and keeps going. A
 * receiver is reported down once per down spell (it must come back up to be reported again).
 * @param {any} args @param {{signal?: AbortSignal}} opts
 */
async function watchActionable(args, opts) {
  const multi = args.all === true || args._.length >= 2;
  /** @type {ReturnType<typeof readProfile>[]} */
  let entries;
  /** @type {number|Record<string, number>} */
  let cursor;
  if (multi) {
    const picked = pickProfiles(args._, { all: args.all === true });
    if ("error" in picked) return fail(picked.error);
    entries = picked.entries;
    /** @type {Record<string, number>} */
    const map = {};
    if (args.cursor !== undefined) {
      const parsed = parseCursorMap(args.cursor);
      if ("error" in parsed) return fail(parsed.error);
      Object.assign(map, parsed.cursors);
    }
    for (const e of entries) if (!Object.hasOwn(map, e.stateKey)) map[e.stateKey] = eventsCursor(e.dir);
    cursor = map;
  } else {
    const picked = pickProfile(args._[0], defaultProfileKey(args.config));
    if ("error" in picked) return fail(String(picked.error));
    entries = [picked.entry];
    const n = args.cursor !== undefined ? Number(args.cursor) : NaN;
    cursor = Number.isInteger(n) && n >= 0 ? n : eventsCursor(picked.entry.dir);
  }

  const summary = createSummary();
  const overrides = { wake: csv(args.wake), quiet: csv(args.quiet) };
  /** @type {Set<string>} */
  const reportedDown = new Set();
  const livenessS = Number(args.liveness);
  const livenessMs = (livenessS > 0 ? livenessS : LIVENESS_DEFAULT_S) * 1000;
  const timeoutS = args.timeout !== undefined ? Number(args.timeout) : 0;
  const deadline = timeoutS > 0 ? Date.now() + timeoutS * 1000 : Infinity;
  const follow = following(args);

  const ac = new AbortController();
  const stop = () => ac.abort();
  if (opts.signal?.aborted) ac.abort();
  else if (opts.signal) opts.signal.addEventListener("abort", stop, { once: true });
  else if (follow) {
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
  }
  const heartbeatS = Number(args.heartbeat);
  const heartbeat = follow && heartbeatS > 0 ? setInterval(() => emit({ e: "heartbeat", cursor }), heartbeatS * 1000) : undefined;

  /** Receivers that went down since the last check, as `daemon_down` events (compact shape). */
  const downEvents = () => {
    /** @type {Record<string, any>[]} */
    const out = [];
    for (const entry of entries) {
      const l = liveness(entry);
      if (l.up) reportedDown.delete(entry.stateKey);
      else if (!reportedDown.has(entry.stateKey)) {
        reportedDown.add(entry.stateKey);
        out.push({
          ts: new Date().toISOString(),
          e: "daemon_down",
          ref: "",
          ...(multi ? { profile: entry.stateKey } : {}),
          reason: `receiver "${entry.name}" is not running`,
          ...(l.lastSeenAt ? { lastSeenAt: l.lastSeenAt } : {}),
        });
      }
    }
    return out;
  };

  /** @param {Record<string, any>[]} events @param {boolean} [timedOut] */
  const report = (events, timedOut = false) => {
    const s = summary.take();
    if (follow) {
      emit({ e: timedOut ? "watch_end" : "actionable", ...(timedOut ? {} : { events }), cursor, ...(s ? { summary: s } : {}), ...(timedOut ? { timedOut: true } : {}) });
      return;
    }
    if (args.json) {
      console.log(JSON.stringify({ events, cursor, ...(s ? { summary: s } : {}), ...(timedOut ? { timedOut: true } : {}) }));
      return;
    }
    for (const e of events) console.log(`${e.profile ? `${e.profile} ` : ""}${line(e)}`);
    if (s) console.log(summaryLine(s));
    const c = typeof cursor === "number" ? cursor : JSON.stringify(cursor);
    console.log(timedOut ? `(nothing actionable in ${timeoutS}s) cursor ${c}` : `cursor ${c}`);
  };

  let timedOut = false;
  let gone = false;
  try {
    while (!ac.signal.aborted) {
      const down = downEvents();
      if (down.length) {
        report(down);
        if (!follow) return;
      }
      const left = deadline - Date.now();
      if (left <= 0) {
        timedOut = true;
        break;
      }
      const filter = { types: types(args), ref: args.ref, limit: 100, timeoutMs: Math.min(left, livenessMs, 2 ** 31 - 1), signal: ac.signal };
      /** @type {Record<string, any>[]} */
      let raw;
      if (multi) {
        const r = await waitForEventsMulti(entries, /** @type {Record<string, number>} */ (cursor), { ...filter, onDrop: (key) => console.error(`profile ${key} disappeared; dropped`) });
        if (r.allDropped) {
          console.error("every watched profile disappeared");
          gone = true;
          break;
        }
        entries = entries.filter((e) => Object.hasOwn(r.cursor, e.stateKey));
        cursor = r.cursor;
        raw = r.events;
      } else {
        const r = await waitForEvents(entries[0].dir, /** @type {number} */ (cursor), filter);
        cursor = r.cursor;
        raw = r.events;
      }
      if (!raw.length) continue;
      /** @type {Map<string, Record<string, any>>} */
      const metas = new Map();
      /** @param {string} key */
      const metaOf = (key) => {
        if (!metas.has(key)) {
          const dir = entries.find((e) => e.stateKey === key)?.dir ?? entries[0].dir;
          metas.set(key, readJson(path.join(dir, "refmeta.json"), {}, isObj));
        }
        return /** @type {Record<string, any>} */ (metas.get(key));
      };
      /** @type {Record<string, any>[]} */
      const hits = [];
      for (const e of raw) {
        const key = multi ? e.profile : entries[0].stateKey;
        if (isActionable(e, metaOf(key), overrides)) hits.push(multi ? { ...compactEvent(e), profile: e.profile } : compactEvent(e));
        else summary.add(e, multi ? e.profile : undefined);
      }
      if (hits.length) {
        report(hits);
        if (!follow) return;
      }
    }
  } finally {
    clearInterval(heartbeat);
    opts.signal?.removeEventListener("abort", stop);
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
  }
  if (gone) {
    process.exitCode = 1;
    if (follow) emit({ e: "watch_end", cursor });
    return;
  }
  if (follow && !timedOut) {
    const s = summary.take();
    emit({ e: "watch_end", cursor, ...(s ? { summary: s } : {}) });
    process.exitCode = 0;
    return;
  }
  report([], true);
  process.exitCode = 2;
}

/** @param {string} msg */
function fail(msg) {
  console.error(msg);
  process.exitCode = 1;
}
