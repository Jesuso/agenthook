// `agenthook top [name]` — the operator's full-screen live glance of a profile: a header plus
// the needs-you items (held → failed → PR) and the running agents. On a TTY it stays open
// (src/top-loop.js `runTop`): alternate screen, event-bus-driven redraws, 1 s elapsed-time
// repaints, resize-follow, `q`/Ctrl-C to quit. Without a TTY — or with `--once` — it prints the
// one-shot view (src/top.js `renderTop`) and exits. Always local state only: no board/PR reads,
// never through `live(...)` — the no-polling rule.
import { defaultProfileKey, eventsCursor, pickProfile, readTick, waitForEvents } from "../agent-api.js";
import { runTop } from "../top-loop.js";
import { renderTop } from "../top.js";

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
async function once(entry) {
  const t = await readTick(entry, { board: false, prs: false, epics: false });
  console.log(renderTop(t, { width: process.stdout.columns || 80, now: Date.now(), color: !!process.stdout.isTTY && !process.env.NO_COLOR }).join("\n"));
}

/** @param {{once?: boolean, _?: string[], config?: string}} args */
export async function top(args) {
  const name = args._ ? args._[0] : undefined;
  const picked = pickProfile(name, defaultProfileKey(args.config));
  if ("error" in picked) {
    console.error(picked.error);
    process.exitCode = 1;
    return;
  }
  if (args.once === true || !process.stdout.isTTY) {
    await once(picked.entry);
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
  });
}
