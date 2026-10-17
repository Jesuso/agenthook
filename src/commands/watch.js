// `agenthook watch [name…|--all] [--event a,b] [--ref r] [--cursor <n|json>] [--timeout <s>] [--json]` —
// block until the next matching pipeline event, print it, exit 0 (exit 2 on --timeout). Built
// to be the body of a Claude Code `Monitor`/background task or a shell `until` loop: the agent
// sleeps for free and wakes only when something happens (event-driven — fs.watch, no polling).
// With no --cursor it starts from "now"; the printed `cursor` resumes without gaps.
// Multi-profile mode (`--all` or ≥2 names) waits on the union: every event carries its profile's
// state key and the cursor is a JSON object `{stateKey: offset}`. One name / none = one profile.
import { defaultProfileKey, pickProfile, pickProfiles, parseCursorMap, waitForEvents, waitForEventsMulti, eventsCursor, compactEvent } from "../agent-api.js";

/** One text line per event. @param {Record<string, any>} e */
const line = (e) =>
  `${e.ts} ${e.e} ${e.ref}${e.step ? `/${e.step}` : ""}${e.outcome ? ` → ${e.outcome}` : ""}${e.reason ? ` (${e.reason})` : ""}${e.pr ? ` PR#${e.pr}` : ""}${e.sha ? ` ${String(e.sha).slice(0, 7)}` : ""}${e.mergeState ? ` ${e.mergeState}` : ""}`;

/** @param {any} args */
const types = (args) => (args.event ? new Set(String(args.event).split(",").map((s) => s.trim()).filter(Boolean)) : null);
/** @param {number} timeoutS */
const timeoutMs = (timeoutS) => (timeoutS > 0 ? timeoutS * 1000 : 2 ** 31 - 1);

/** @param {any} args */
export async function watch(args) {
  if (args.all === true || args._.length >= 2) return watchMulti(args);
  const picked = pickProfile(args._[0], defaultProfileKey(args.config));
  if ("error" in picked) {
    console.error(picked.error);
    process.exitCode = 1;
    return;
  }
  const { entry } = picked;
  const cursor = args.cursor !== undefined ? Number(args.cursor) : eventsCursor(entry.dir);
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

/** @param {any} args */
async function watchMulti(args) {
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
