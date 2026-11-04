// `agenthook postdeploy [list] [name…|--all] [--json]` / `agenthook postdeploy done <ref> [name]` —
// the approvals whose remaining checks can only be verified once the change is deployed
// (src/postdeploy.js). `list` reads the state dir (receiver up or not). `done` clears one ref's
// checks: through the live receiver when it is up, else straight on its state dir.
import path from "node:path";
import { defaultProfileKey, pickProfile, pickProfiles, live } from "../agent-api.js";
import { pendingPostDeploy, markPostDeployDone } from "../postdeploy.js";
import { readJson, isObj } from "../ui/rows.js";
import { createStore } from "../store.js";
import { createEmitter } from "../events.js";

const USAGE = "usage: agenthook postdeploy [list] [name…|--all] [--json]  |  agenthook postdeploy done <ref> [name]";

/** @param {any} args */
export async function postdeploy(args) {
  const [sub, ...rest] = args._;
  if (sub === "done") return done(rest, args);
  if (sub === undefined || sub === "list") return list(rest, args);
  return list(args._, args); // `ah postdeploy <name>` = list that profile
}

/** @param {string[]} names @param {any} args */
async function list(names, args) {
  /** @type {{stateKey: string, dir: string}[]} */
  let entries;
  if (args.all === true || names.length >= 2) {
    const picked = pickProfiles(names, { all: args.all === true });
    if ("error" in picked) return fail(picked.error);
    entries = picked.entries;
  } else {
    const picked = pickProfile(names[0], defaultProfileKey(args.config));
    if ("error" in picked) return fail(String(picked.error));
    entries = [picked.entry];
  }
  const multi = entries.length > 1 || args.all === true;
  const rows = entries.flatMap((e) => pendingPostDeploy(readJson(path.join(e.dir, "refmeta.json"), {}, isObj)).map((r) => ({ ...(multi ? { profile: e.stateKey } : {}), ...r })));
  if (args.json) {
    console.log(JSON.stringify(rows));
    return;
  }
  if (!rows.length) {
    console.log("no post-deploy checks pending");
    return;
  }
  for (const r of rows) {
    console.log(`${"profile" in r ? `${r.profile} ` : ""}${r.id ?? r.ref}${r.title ? ` "${r.title}"` : ""}${r.pr ? ` PR#${r.pr}` : ""}${r.tier ? ` tier=${r.tier}` : ""}${r.since ? ` since ${r.since}` : ""}`);
    for (const c of r.checks) console.log(`  - ${c}`);
  }
}

/** @param {string[]} rest @param {any} args */
async function done([ref, name], args) {
  if (!ref) return fail(USAGE);
  const picked = pickProfile(name, defaultProfileKey(args.config));
  if ("error" in picked) return fail(String(picked.error));
  const { entry } = picked;
  let result;
  try {
    result = entry.up
      ? await live(entry.stateKey, "postdeploy_done", { ref, actor: "cli" }, { registry: path.dirname(entry.dir) })
      : markPostDeployDone(createStore(entry.dir), createEmitter(entry.dir), ref);
  } catch (e) {
    return fail(e.message);
  }
  if (args.json) console.log(JSON.stringify(result));
  else console.log(`${ref}: post-deploy checks marked verified (${result.done.length})`);
}

/** @param {string} msg */
function fail(msg) {
  console.error(msg);
  process.exitCode = 1;
}
