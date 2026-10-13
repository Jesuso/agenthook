// `agenthook watch [name] [--event a,b] [--ref r] [--cursor <n>] [--timeout <s>] [--json]` —
// block until the next matching pipeline event, print it, exit 0 (exit 2 on --timeout). Built
// to be the body of a Claude Code `Monitor`/background task or a shell `until` loop: the agent
// sleeps for free and wakes only when something happens (event-driven — fs.watch, no polling).
// With no --cursor it starts from "now"; the printed `cursor` resumes without gaps.
import { defaultProfileKey, pickProfile, waitForEvents, eventsCursor, compactEvent } from "../agent-api.js";

/** @param {any} args */
export async function watch(args) {
  const picked = pickProfile(args._[0], defaultProfileKey(args.config));
  if ("error" in picked) {
    console.error(picked.error);
    process.exitCode = 1;
    return;
  }
  const { entry } = picked;
  const types = args.event ? new Set(String(args.event).split(",").map((s) => s.trim()).filter(Boolean)) : null;
  const cursor = args.cursor !== undefined ? Number(args.cursor) : eventsCursor(entry.dir);
  const timeoutS = args.timeout !== undefined ? Number(args.timeout) : 0;
  const r = await waitForEvents(entry.dir, cursor, {
    types,
    ref: args.ref,
    limit: 100,
    timeoutMs: timeoutS > 0 ? timeoutS * 1000 : 2 ** 31 - 1,
  });
  const events = r.events.map(compactEvent);
  if (args.json) console.log(JSON.stringify({ events, cursor: r.cursor, ...(r.timedOut ? { timedOut: true } : {}) }));
  else {
    for (const e of events) console.log(`${e.ts} ${e.e} ${e.ref}${e.step ? `/${e.step}` : ""}${e.outcome ? ` → ${e.outcome}` : ""}${e.reason ? ` (${e.reason})` : ""}`);
    if (r.timedOut) console.log(`(no event in ${timeoutS}s) cursor ${r.cursor}`);
    else console.log(`cursor ${r.cursor}`);
  }
  if (r.timedOut) process.exitCode = 2;
}
