// `agenthook ticket add|ls` — the local tracker's board from the CLI (local profiles only; on a
// SaaS tracker you add work on its board, then `agenthook run <ref>`).
//
// `ticket add "<title>" [--body <text> | --file <path>] [--step <id>]` puts ONE item on the board
// at the step's source stage (default the first non-manual step) under the next numeric ref. The
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
import { localBoardPath } from "../trackers/local.js";
import { readProfile } from "../heartbeat.js";
import { controlRequest } from "../ui/control-client.js";
import { TICKET_BODY_MAX } from "../ops.js";

/** @param {any} args */
export async function ticket(args) {
  const sub = args._[0];
  if (sub !== "add" && sub !== "ls") die(`usage: agenthook ticket add "<title>" [--body <text> | --file <path>] [--step <id>]\n       agenthook ticket ls [--json]`);
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
  if (!title) die(`usage: agenthook ticket add "<title>" [--body <text> | --file <path>] [--step <id>]`);
  const body = ticketBody(args);
  if (typeof body !== "string") die(body.error);
  const step = typeof args.step === "string" ? args.step : undefined;

  if (readProfile(cfg.stateKey).up) {
    let reply;
    try {
      reply = await controlRequest(cfg.controlSock, "ticket_add", { title, ...(body && { body }), ...(step && { step }) }, { timeoutMs: 20000 });
    } catch (e) {
      die(`ticket add: ${e.code === "timeout" ? "timed out waiting for the receiver" : "receiver is down"} — retry, or stop it and add the ticket again.`);
    }
    if (!reply.ok) die(`ticket add: ${reply.error}`);
    const r = reply.result;
    console.log(`#${r.ref} "${title}" -> step "${r.step}" (the running receiver fires it now)`);
    return;
  }

  const adapter = createAdapter(cfg, createStore(cfg.dataDir));
  if (typeof adapter.createTask !== "function") die(`tracker "${cfg.provider}" has no ticket add`);
  let r;
  try {
    r = await adapter.createTask({ name: title, description: body, ...(step && { stepId: step }) });
  } catch (e) {
    die(`ticket add: ${String(e.message).replace(/^local: /, "")}`);
  }
  console.log(`#${r.ref} "${title}" rests in stage "${r.stage}" (step "${r.stepId}").`);
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

/** @typedef {{ ref: string, stage: string, title: string, running?: string, held?: string }} TicketRow */

/**
 * Board items as rows, refs ascending (numeric first, then by name), each marked with its running
 * step / held step when the store has one. Pure.
 * @param {Record<string, {name?: string, stage?: string}>} board
 * @param {Record<string, {stepId?: string}>} running
 * @param {Record<string, {stepId?: string}>} held
 * @returns {TicketRow[]}
 */
export function ticketRows(board, running, held) {
  const order = (/** @type {string} */ a, /** @type {string} */ b) => {
    const [na, nb] = [Number(a), Number(b)];
    if (Number.isInteger(na) && Number.isInteger(nb)) return na - nb;
    if (Number.isInteger(na) !== Number.isInteger(nb)) return Number.isInteger(na) ? -1 : 1;
    return a.localeCompare(b);
  };
  return Object.keys(board)
    .sort(order)
    .map((ref) => ({
      ref,
      stage: board[ref]?.stage || "",
      title: board[ref]?.name || "",
      ...(running[ref] && { running: running[ref].stepId || "?" }),
      ...(held[ref] && { held: held[ref].stepId || "?" }),
    }));
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
  const rows = ticketRows(board, store.listRunning(), held);
  if (args.json) return console.log(JSON.stringify(rows));
  if (!rows.length) return console.log(`no tickets on the board — add one with \`agenthook ticket add "<title>"\``);
  const w = Math.max(...rows.map((r) => r.ref.length + 1));
  const sw = Math.max(...rows.map((r) => r.stage.length));
  for (const r of rows) {
    const marks = [r.running && `running ${r.running}`, r.held && `held at ${r.held}`].filter(Boolean);
    console.log(`${`#${r.ref}`.padEnd(w)}  ${r.stage.padEnd(sw)}  ${r.title}${marks.length ? `  [${marks.join(", ")}]` : ""}`);
  }
}

/** @param {string} msg @returns {never} */
function die(msg) {
  console.error(msg);
  process.exit(1);
}
