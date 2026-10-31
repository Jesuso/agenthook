// `agenthook ticket add|ls` — the local tracker's board from the CLI (local profiles only; on a
// SaaS tracker you add work on its board, then `agenthook run <ref>`).
//
// `ticket add "<title>" [--body <text> | --file <path>] [--step <id>] [--blocked-by <ref,ref>]` puts
// ONE item on the board at the step's source stage (default the first non-manual step) under the
// next numeric ref; `--blocked-by` rests it until every listed ticket reaches a done stage. The
// local adapter pushes the step's job in-process, so with the receiver up the add must happen
// THERE — like `run`, it is sent over control.sock (the `ticket_add` op): that also keeps the
// board write in the one process that serializes them. Receiver down → the adapter writes the
// board directly (no sink, nothing pushed) and the item rests until `reconcile`.
//
// `ticket ls [--json]` reads the board file (read-only) with running/held marks from the store.
import fs from "node:fs";
import { loadConfig } from "../config.js";
import { createStore } from "../store.js";
import { createAdapter } from "../trackers/index.js";
import { localBoardPath, normalizeBlockedBy, openBlockersOf } from "../trackers/local.js";
import { readProfile } from "../heartbeat.js";
import { controlRequest } from "../ui/control-client.js";
import { TICKET_BODY_MAX } from "../ops.js";

/** @param {any} args */
export async function ticket(args) {
  const sub = args._[0];
  if (sub !== "add" && sub !== "ls") die(`usage: agenthook ticket add "<title>" [--body <text> | --file <path>] [--step <id>] [--blocked-by <ref,ref>]\n       agenthook ticket ls [--json]`);
  const cfg = loadConfig({ configPath: args.config });
  if (cfg.provider !== "local") {
    let platform = cfg.provider;
    try {
      platform = createAdapter(cfg, createStore(cfg.dataDir)).describe().platform;
    } catch {}
    die(`ticket ${sub} is for local profiles — add work on your ${platform} board, then \`agenthook run <ref>\``);
  }
  return sub === "add" ? add(cfg, args) : ls(cfg, args);
}

/** @param {import('../types.js').Config} cfg @param {any} args */
async function add(cfg, args) {
  const title = args._.slice(1).join(" ").trim(); // quoted or not
  if (!title) die(`usage: agenthook ticket add "<title>" [--body <text> | --file <path>] [--step <id>] [--blocked-by <ref,ref>]`);
  const body = ticketBody(args);
  if (typeof body !== "string") die(body.error);
  const step = typeof args.step === "string" ? args.step : undefined;
  // `"blocked-by" in args`, not `!== undefined`: a trailing `--blocked-by` with no value parses to
  // undefined and must not silently create an UNblocked ticket.
  const blockedBy = normalizeBlockedBy(args["blocked-by"]);
  if ("blocked-by" in args && (typeof args["blocked-by"] !== "string" || !blockedBy.length)) die("ticket add: --blocked-by needs a comma-separated list of refs (e.g. --blocked-by 3,7)");

  if (readProfile(cfg.stateKey).up) {
    let reply;
    try {
      reply = await controlRequest(cfg.controlSock, "ticket_add", { title, ...(body && { body }), ...(step && { step }), ...(blockedBy.length && { blockedBy }) }, { timeoutMs: 20000 });
    } catch (e) {
      die(`ticket add: ${e.code === "timeout" ? "timed out waiting for the receiver" : "receiver is down"} — retry, or stop it and add the ticket again.`);
    }
    if (!reply.ok) die(`ticket add: ${reply.error}`);
    const r = reply.result;
    if (r.blockedBy?.length) console.log(`#${r.ref} "${title}" -> step "${r.step}", blocked by ${refList(r.blockedBy)} (fires when they reach done)`);
    else console.log(`#${r.ref} "${title}" -> step "${r.step}" (the running receiver fires it now)`);
    return;
  }

  const adapter = createAdapter(cfg, createStore(cfg.dataDir));
  if (typeof adapter.createTask !== "function") die(`tracker "${cfg.provider}" has no ticket add`);
  let r;
  try {
    r = await adapter.createTask({ name: title, description: body, ...(step && { stepId: step }), ...(blockedBy.length && { blockedBy }) });
  } catch (e) {
    die(`ticket add: ${String(e.message).replace(/^local: /, "")}`);
  }
  const blocked = r.blockedBy?.length ? `, blocked by ${refList(r.blockedBy)}` : "";
  console.log(`#${r.ref} "${title}" rests in stage "${r.stage}" (step "${r.stepId}")${blocked}.`);
  console.log(`No receiver running for "${cfg.name}" — start it (\`agenthook start --detach\`), then \`agenthook reconcile\` fires it.`);
}

/**
 * The ticket body from `--body <text>` or `--file <path>` (not both), or an error. Pure apart
 * from reading the file. @param {any} args @returns {string | {error: string}}
 */
export function ticketBody(args) {
  if (args.body !== undefined && args.file !== undefined) return { error: "ticket add: pass --body or --file, not both" };
  let body = "";
  if (args.body !== undefined) {
    if (typeof args.body !== "string") return { error: "ticket add: --body needs a value" };
    body = args.body;
  } else if (args.file !== undefined) {
    if (typeof args.file !== "string") return { error: "ticket add: --file needs a path" };
    try {
      body = fs.readFileSync(args.file, "utf8");
    } catch (e) {
      return { error: `ticket add: cannot read ${args.file} (${e.code || e.message})` };
    }
  }
  // Measure what goes on the wire: control.sock caps the request line in bytes, and JSON
  // escaping (quotes, newlines) plus multi-byte UTF-8 make that larger than body.length.
  const bytes = Buffer.byteLength(JSON.stringify(body), "utf8");
  if (bytes > TICKET_BODY_MAX) return { error: `ticket add: the body is ${bytes} bytes encoded — keep it under ${TICKET_BODY_MAX}` };
  return body;
}

/** `#3, #7` @param {string[]} refs */
const refList = (refs) => refs.map((r) => `#${r}`).join(", ");

/** @typedef {{ ref: string, stage: string, title: string, running?: string, held?: string, blockedBy?: string[] }} TicketRow */

/**
 * Board items as rows, refs ascending (numeric first, then by name), each marked with its running
 * step / held step when the store has one, and with its still-open blockers. Pure.
 * @param {Record<string, {name?: string, stage?: string, blockedBy?: string[]}>} board
 * @param {Record<string, {stepId?: string}>} running
 * @param {Record<string, {stepId?: string}>} held
 * @param {import('../types.js').Config} [cfg]  the pipeline that decides which stages are done (absent: every blocker counts as open)
 * @returns {TicketRow[]}
 */
export function ticketRows(board, running, held, cfg) {
  const order = (/** @type {string} */ a, /** @type {string} */ b) => {
    const [na, nb] = [Number(a), Number(b)];
    if (Number.isInteger(na) && Number.isInteger(nb)) return na - nb;
    if (Number.isInteger(na) !== Number.isInteger(nb)) return Number.isInteger(na) ? -1 : 1;
    return a.localeCompare(b);
  };
  const typed = /** @type {Record<string, import('../trackers/local.js').LocalItem>} */ (board);
  return Object.keys(board)
    .sort(order)
    .map((ref) => {
      const open = openBlockersOf(cfg ?? /** @type {any} */ ({ pipeline: [] }), typed, ref);
      return {
        ref,
        stage: board[ref]?.stage || "",
        title: board[ref]?.name || "",
        ...(running[ref] && { running: running[ref].stepId || "?" }),
        ...(held[ref] && { held: held[ref].stepId || "?" }),
        ...(open.length && { blockedBy: open }),
      };
    });
}

/** @param {import('../types.js').Config} cfg @param {any} args */
function ls(cfg, args) {
  /** @type {Record<string, any>} */
  let board = {};
  try {
    board = JSON.parse(fs.readFileSync(localBoardPath(cfg), "utf8"));
  } catch {}
  const store = createStore(cfg.dataDir);
  /** @type {Record<string, any>} */
  const held = {};
  for (const ref of Object.keys(board)) {
    const h = store.getHeld(ref);
    if (h) held[ref] = h;
  }
  const rows = ticketRows(board, store.listRunning(), held, cfg);
  if (args.json) return console.log(JSON.stringify(rows));
  if (!rows.length) return console.log(`no tickets on the board — add one with \`agenthook ticket add "<title>"\``);
  const w = Math.max(...rows.map((r) => r.ref.length + 1));
  const sw = Math.max(...rows.map((r) => r.stage.length));
  for (const r of rows) {
    const marks = [r.running && `running ${r.running}`, r.held && `held at ${r.held}`, r.blockedBy && `blocked by ${refList(r.blockedBy)}`].filter(Boolean);
    console.log(`${`#${r.ref}`.padEnd(w)}  ${r.stage.padEnd(sw)}  ${r.title}${marks.length ? `  [${marks.join(", ")}]` : ""}`);
  }
}

/** @param {string} msg @returns {never} */
function die(msg) {
  console.error(msg);
  process.exit(1);
}
