// `agenthook top --once [name]` — one-shot terminal glance of a profile: a header plus the
// needs-you items (held → failed → PR) and the running agents, from a LOCAL-ONLY tick (no
// board/PR reads — the epic's no-polling rule). The live loop is a later ticket; without
// `--once` the command says so and exits 1.
import { defaultProfileKey, pickProfile, readTick } from "../agent-api.js";
import { renderTop } from "../top.js";

/** @param {{once?: boolean, _?: string[], config?: string}} args */
export async function top(args) {
  if (args.once !== true) {
    console.error("agenthook top: the live view is not built yet — use --once");
    process.exitCode = 1;
    return;
  }
  const picked = pickProfile(args._ ? args._[0] : undefined, defaultProfileKey(args.config));
  if ("error" in picked) {
    console.error(picked.error);
    process.exitCode = 1;
    return;
  }
  const t = await readTick(picked.entry, { board: false, prs: false, epics: false });
  console.log(renderTop(t, { width: process.stdout.columns || 80, now: Date.now(), color: !!process.stdout.isTTY && !process.env.NO_COLOR }).join("\n"));
}
