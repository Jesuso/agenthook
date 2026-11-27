// Spawned by test/top-loop.test.js ("the child exits by itself on q"): the REAL runTop wired the
// way src/commands/top.js wires it, but with piped stdin as the loop's input. A resumed stdin
// keeps the event loop alive, so this child only exits on its own if the quit path pauses it —
// the pty repro from the #795 rework without needing a pty.
import { defaultProfileKey, pickProfile } from "../src/agent-api/profiles.js";
import { eventsCursor, waitForEvents } from "../src/agent-api/events.js";
import { readTick } from "../src/agent-api/tick.js";
import { runTop } from "../src/top-loop.js";

const name = process.argv[2];
const p = pickProfile(name, defaultProfileKey(process.argv[3]));
if ("error" in p) {
  console.error(p.error);
  process.exit(2);
}
const entry = p.entry;
let cursor = eventsCursor(entry.dir);
await runTop({
  out: process.stdout,
  input: process.stdin,
  readData: () => readTick(entry, { board: false, prs: false, epics: false }),
  nextEvent: async (signal, timeoutMs) => {
    const r = await waitForEvents(entry.dir, cursor, { limit: 100, timeoutMs, signal });
    cursor = r.cursor;
    return r;
  },
});
process.exitCode = 0;
