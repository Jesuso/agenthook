// `agenthook epics [name] [--ref <epic>] [--fresh] [--json]` — the same payload the MCP `epics`
// tool returns: every epic with its progress, live via the receiver when up else the local
// refmeta-based fallback (`live:false`). --json prints the exact payload.
import { defaultProfileKey, pickProfile, readEpics } from "../agent-api.js";

/** @param {Record<string, any>} e @returns {string} */
function epicLine(e) {
  const done = (e.byStage?.finished ?? 0) + (e.byStage?.merged ?? 0);
  let line = `${e.ref} "${e.name}" ${done}/${e.total}`;
  if (e.needsYou?.length) line += ` needs-you: ${e.needsYou.join(" ")}`;
  if (e.eta) line += ` eta ${e.eta.date}`;
  return line;
}

/** Text digest of an `epics` payload (list, or one epic's detail with `--ref`). @param {Record<string, any>} payload */
export function digest(payload) {
  if (payload.supported === false) return "epics unsupported";
  if (payload.epic) {
    const e = payload.epic;
    const lines = [epicLine(e)];
    for (const t of e.tickets) lines.push(`  ${t.displayId ?? t.ref} ${t.bucket} "${t.name}"`);
    return lines.join("\n");
  }
  const list = payload.epics ?? [];
  const lines = [`${payload.live ? "live" : "local"} ${list.length} epics`];
  for (const e of list) lines.push(epicLine(e));
  return lines.join("\n");
}

/** @param {any} args */
export async function epics(args) {
  const picked = pickProfile(args._[0], defaultProfileKey(args.config));
  if ("error" in picked) {
    console.error(picked.error);
    process.exitCode = 1;
    return;
  }
  try {
    const payload = await readEpics(picked.entry, { ref: args.ref, fresh: args.fresh === true });
    console.log(args.json ? JSON.stringify(payload) : digest(payload));
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}
