// `agenthook recheck <ref>|--all` — ask the live receiver to re-check a Needs-you PR row whose
// done/merge webhook was missed (ops.js `recheck`, src/recheck.js): the receiver asks the tracker
// and forge again and records only the facts it missed. `--all` = every row already flagged with
// a PR reason, never the whole board. Over control.sock like `run`: only the receiver writes
// events and `seen`.
import { loadConfig } from "../config.js";
import { requireStarted } from "../profile.js";
import { controlRequest } from "../ui/control-client.js";

export const RECHECK_USAGE = "usage: agenthook recheck <ref> | --all";

/** The `recheck` op's args from the CLI's, or null for a bad call (no ref, or a ref with --all).
 * @param {{_: string[], [k: string]: any}} args @returns {{ref: string}|{all: true}|null} */
export function recheckRequest(args) {
  const ref = args._[0];
  if (args.all === true) return ref === undefined ? { all: true } : null;
  return typeof ref === "string" && ref ? { ref } : null;
}

/** One printable line per re-checked ref. @param {{ref: string, changed?: string[], unchanged?: boolean, prError?: string, error?: string}} r */
export function recheckLine(r) {
  if (r.error) return `${r.ref}: ${r.error}`;
  const pr = r.prError ? ` (PR lookup failed: ${r.prError})` : "";
  return r.unchanged ? `${r.ref}: nothing new${pr}` : `${r.ref}: recorded ${(r.changed ?? []).join(", ")}${pr}`;
}

/** @param {any} args */
export async function recheck(args) {
  const req = recheckRequest(args);
  if (!req) die(RECHECK_USAGE);
  const cfg = loadConfig({ configPath: args.config });
  requireStarted(cfg);
  let reply;
  try {
    reply = await controlRequest(cfg.controlSock, "recheck", { ...req, actor: "cli" }, { timeoutMs: 120000 });
  } catch (e) {
    die(`recheck: ${e.code === "timeout" ? "timed out waiting for the receiver" : "receiver is down"} — start it (\`agenthook start --detach\`) and retry.`);
  }
  if (!reply.ok) die(`recheck: ${reply.error}`);
  const results = "all" in req ? reply.result.rechecked : [reply.result];
  if (!results.length) console.log("no row is flagged with a PR reason — nothing to re-check.");
  for (const r of results) console.log(recheckLine(r));
}

/** @param {string} msg @returns {never} */
function die(msg) {
  console.error(msg);
  process.exit(1);
}
