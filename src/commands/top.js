// `agenthook top [name]` — the operator's live glance of a profile: a header plus the
// needs-you items (held → failed → PR) and the running agents. On a TTY it stays open
// (src/top-loop.js `runTop`): alternate screen, event-bus-driven redraws, 1 s elapsed-time
// repaints, resize-follow, `q`/Ctrl-C to quit. `--lines N` switches the live loop (and the
// one-shot view) to a fixed strip of at most N lines repainted in place on the normal screen
// (src/top.js `renderStrip`) — for a split terminal pane. Without a TTY — or with `--once` —
// it prints the one-shot view (src/top.js `renderTop`, or the strip) and exits. Always local
// state only: no board/PR reads, never through `live(...)` — the no-polling rule.
import { defaultProfileKey, eventsCursor, pickProfile, readTick, waitForEvents } from "../agent-api.js";
import { runTop } from "../top-loop.js";
import { renderStrip, renderTop } from "../top.js";

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
  });
}
