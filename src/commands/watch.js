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
import { defaultProfileKey, pickProfile, pickProfiles, parseCursorMap, waitForEvents, waitForEventsMulti, eventsCursor, compactEvent } from "../agent-api.js";

/** One text line per event. @param {Record<string, any>} e */
const line = (e) =>
  `${e.ts} ${e.e} ${e.ref}${e.step ? `/${e.step}` : ""}${e.outcome ? ` → ${e.outcome}` : ""}${e.reason ? ` (${e.reason})` : ""}${e.pr ? ` PR#${e.pr}` : ""}${e.sha ? ` ${String(e.sha).slice(0, 7)}` : ""}${e.mergeState ? ` ${e.mergeState}` : ""}`;

/** @param {any} args */
const types = (args) => (args.event ? new Set(String(args.event).split(",").map((s) => s.trim()).filter(Boolean)) : null);
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
