// `agenthook top [name]` — the operator's live glance of a profile: a header plus the
// needs-you items (held → failed → PR) and the running agents. On a TTY it stays open
// (src/top-loop.js `runTop`): alternate screen, event-bus-driven redraws, 1 s elapsed-time
// repaints, resize-follow, `q`/Ctrl-C to quit — plus row selection (j/k/↑/↓, the `>` prefix,
// a detail line), Enter-to-follow on a running row (this file's `followRunLog` tails that ref's
// run log — the shared `tailFile` from `follow.js` — until the bus's `run_end` for it or q,
// read-only) and an act-on hint for the other rows (`?` toggles the key help). `--lines N`
// switches the live loop (and the one-shot view) to a fixed strip of at most N lines
// repainted in place on the normal screen (src/top.js `renderStrip`) — for a split terminal
// pane, with no keys but q. Without a TTY — or with `--once` — it prints the one-shot view
// (src/top.js `renderTop`, or the strip) and exits. Always local state only: no board/PR
// reads, never through `live(...)` — the no-polling rule.
import { defaultProfileKey, eventsCursor, pickProfile, readRuns, readTick, waitForEvents } from "../agent-api.js";
import { registryDir } from "../config.js";
import { resolveRunLog } from "../ui/logs.js";
import { runTop } from "../top-loop.js";
import { renderStrip, renderTop } from "../top.js";
import { tailFile } from "./follow.js";

/** Bounded wait round for the follow's run_end wait (the same bounded-round pattern the loop uses). */
const FOLLOW_WAIT_MS = 10_000;

/** The run_end types the follow's bus wait filters on. */
const RUN_END_TYPES = new Set(["run_end"]);

/**
 * The live loop's data source: re-resolve the profile (fresh `up` — a long-lived loop must
 * notice the receiver going down or coming back) and read a LOCAL-ONLY tick. `board`/`prs`
 * stay false so the loop never touches the tracker or the forge.
 * @param {string|undefined} name profile name or state key
 * @param {string|undefined} configPath
 */
export async function topReadData(name, configPath) {
  const p = pickProfile(name, defaultProfileKey(configPath));
  if ("error" in p) throw new Error(p.error);
  return readTick(p.entry, { board: false, prs: false, epics: false });
}

/** The one-shot frame (#794): print the tick's rendered lines and stop. @param {ReturnType<typeof import("../heartbeat.js").readProfile>} entry */
async function once(entry, lines = 0) {
  const t = await readTick(entry, { board: false, prs: false, epics: false });
  const o = { width: process.stdout.columns || 80, now: Date.now(), color: !!process.stdout.isTTY && !process.env.NO_COLOR };
  console.log((lines ? renderStrip(t, { ...o, lines }) : renderTop(t, o)).join("\n"));
}

/**
 * Validate `--lines` (#796): present only as a whole number ≥ 2. A missing value (the flag
 * parsed to `undefined`), `"1"`, `"abc"` or `"2.5"` all come back `"bad"` (the caller prints
 * the error and sets the exit code); a valid N comes back as the number.
 * @param {unknown} v the parsed `--lines` value
 * @returns {number|"bad"}
 */
function stripLines(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 2 ? n : "bad";
}

/**
 * Block until a `run_end` for `ref` lands on the profile's bus (or the signal aborts): the
 * same bounded `waitForEvents` round the loop itself uses — fs.watch-driven, no re-read timer
 * for data.
 * @param {string} dir the profile's state dir
 * @param {string} ref
 * @param {AbortSignal} signal
 */
async function waitRunEnd(dir, ref, signal) {
  let cursor = eventsCursor(dir);
  for (;;) {
    const r = await waitForEvents(dir, cursor, { types: RUN_END_TYPES, ref, timeoutMs: FOLLOW_WAIT_MS, signal });
    cursor = r.cursor;
    if (r.events.length) return;
    if (signal.aborted) return;
  }
}

/**
 * The live loop's Enter-follow (#797): tail the ref's current run log — the first `running`
 * run from `readRuns` → `resolveRunLog` — as plain text. It ends when the profile's bus
 * delivers a `run_end` for that ref, or when the user aborts (`signal`). Local state only:
 * no tracker/forge read. Throws (the loop shows the message as the hint) when the ref has
 * no readable run log.
 * @param {string} ref
 * @param {ReturnType<typeof import('../heartbeat.js').readProfile>} entry
 * @param {{signal: AbortSignal, write: (s: string) => unknown}} o
 */
export async function followRunLog(ref, entry, { signal, write }) {
  const runs = readRuns(entry.stateKey, ref, entry.dir);
  const run = runs.find((r) => r.running);
  const file = run ? resolveRunLog(registryDir, entry.stateKey, run.run) : null;
  if (!file) throw new Error(`no run log for ${ref}`);
  const ac = new AbortController(); // ends the tail when the run does (or the user aborts)
  const onAbort = () => ac.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    await Promise.all([
      tailFile(file, { signal: ac.signal, write }),
      // the run's run_end settles the wait — abort the tail with it (the tail is what waits on `ac`).
      waitRunEnd(entry.dir, ref, signal).then(() => ac.abort()),
    ]);
  } finally {
    ac.abort();
    signal.removeEventListener("abort", onAbort);
  }
}

/** @param {{once?: boolean, lines?: unknown, _?: string[], config?: string}} args */
export async function top(args) {
  // `"lines" in args` — not an `undefined` check — is what makes a value-less `--lines` bad:
  // `parse` leaves the key present with an `undefined` value.
  const lines = "lines" in args ? stripLines(args.lines) : 0;
  if (lines === "bad") {
    console.error("agenthook top: --lines needs a whole number ≥ 2");
    process.exitCode = 1;
    return;
  }
  const name = args._ ? args._[0] : undefined;
  const picked = pickProfile(name, defaultProfileKey(args.config));
  if ("error" in picked) {
    console.error(picked.error);
    process.exitCode = 1;
    return;
  }
  if (args.once === true || !process.stdout.isTTY) {
    await once(picked.entry, lines);
    return;
  }
  const entry = picked.entry;
  let cursor = eventsCursor(entry.dir);
  await runTop({
    out: process.stdout,
    input: process.stdin,
    readData: () => topReadData(name, args.config),
    // One bounded wait per round; the cursor advances past every read line (the production
    // shape of `waitForEvents`'s result).
    nextEvent: async (signal, timeoutMs) => {
      const r = await waitForEvents(entry.dir, cursor, { limit: 100, timeoutMs, signal });
      cursor = r.cursor;
      return r;
    },
    ...(lines ? { lines } : {}),
    // Enter on a running row tails that ref's run log (local state only; #797) and returns to
    // the dashboard on the run's run_end or on q.
    follow: (ref, o) => followRunLog(ref, entry, o),
  });
}
