// `agenthook cancel` / `release` / `dismiss` / `retry` / `pull` / `harness-reset` — run control
// from a shell: the same control-socket ops (src/ops.js) the MCP tools reach, so an operator
// without an MCP client can act. Each command is a thin caller of the op of the same name — no
// second implementation, and no check beyond argument shape (a missing <ref>/<name> prints a
// usage line and sends nothing). Profile selection (--config, as for `pause`), the "not running"
// check, the per-op timeout (liveTimeoutMs, same as the MCP path) and the error/exit handling
// all live in the shared sender (src/commands/pause.js `send`).
import { send } from "./pause.js";
import { liveTimeoutMs } from "../agent-api.js";

/** The CLI args these commands read: the parsed positional/flag map from bin/agenthook.js. */
/** @typedef {{_: string[], config?: string, json?: boolean}} OpArgs */

/** Print a usage line on stderr and mark exit 1 (always called before anything is sent). @param {string} line */
function usage(line) {
  console.error(`usage: ${line}`);
  process.exitCode = 1;
}

/** `agenthook cancel <ref>` — abandon a running, queued or held task. @param {OpArgs} args */
export async function cancel(args) {
  const ref = args._[0];
  if (!ref) {
    usage("agenthook cancel <ref>");
    return;
  }
  await send(args, "cancel", { ref }, { timeoutMs: liveTimeoutMs("cancel"), plain: cancelPlain });
}

/** @param {Record<string, unknown>} r */
function cancelPlain(r) {
  const parts = [];
  if (r.killed) parts.push("killed its run");
  if (Array.isArray(r.dequeued) && r.dequeued.length) parts.push(`dequeued ${r.dequeued.join(", ")}`);
  if (r.releasedHold) parts.push("released its hold");
  console.log(`${r.ref}: ${parts.join(", ") || "nothing to do"}`);
  if (r.moved === false) console.log(`moving it to the failure lane failed: ${r.moveError ?? "unknown error"}`);
}

/** `agenthook release <ref> [comment…]` — answer a held task and re-run its step; the remaining
 * positionals are the comment (omitted when none — the op accepts that). @param {OpArgs} args */
export async function release(args) {
  const ref = args._[0];
  if (!ref) {
    usage("agenthook release <ref> [comment…]");
    return;
  }
  const payload = { ref, ...(args._.length > 1 ? { comment: args._.slice(1).join(" ") } : {}) };
  await send(args, "release", payload, { timeoutMs: liveTimeoutMs("release"), plain: (r) => console.log(`${r.ref}: queued for step "${r.step}"`) });
}

/** `agenthook dismiss <ref>` — mark a failed/cancelled task or PR row dismissed. @param {OpArgs} args */
export async function dismiss(args) {
  const ref = args._[0];
  if (!ref) {
    usage("agenthook dismiss <ref>");
    return;
  }
  await send(args, "dismiss", { ref }, { timeoutMs: liveTimeoutMs("dismiss"), plain: (r) => console.log(`${r.ref} dismissed`) });
}

/** `agenthook retry <ref>` — re-run a failed task's failed step. @param {OpArgs} args */
export async function retry(args) {
  const ref = args._[0];
  if (!ref) {
    usage("agenthook retry <ref>");
    return;
  }
  await send(args, "retry", { ref }, { timeoutMs: liveTimeoutMs("retry"), plain: retryPlain });
}

/** @param {Record<string, unknown>} r */
function retryPlain(r) {
  if (r.queued) {
    console.log(`${r.ref}: step "${r.step}" queued`);
  } else {
    console.log(`${r.ref}: step "${r.step}" re-entered stage "${r.stage}"`);
    if (typeof r.note === "string") console.log(r.note);
  }
}

/** `agenthook pull` — pull the backlog (queue stage) into free slots. @param {OpArgs} args */
export async function pull(args) {
  await send(args, "pull", {}, { timeoutMs: liveTimeoutMs("pull"), plain: pullPlain });
}

/** @param {Record<string, unknown>} r */
function pullPlain(r) {
  console.log(`slots: ${r.active ?? 0} active, ${r.queued ?? 0} queued`);
  if (typeof r.capped === "number") console.log(`${r.capped} capped`);
}

/** `agenthook harness-reset <name>` — reset a harness's health breaker. @param {OpArgs} args */
export async function harnessReset(args) {
  const name = args._[0];
  if (!name) {
    usage("agenthook harness-reset <name>");
    return;
  }
  await send(args, "harness_reset", { harness: name }, {
    timeoutMs: liveTimeoutMs("harness_reset"),
    plain: (r) => console.log(`harness "${r.harness}": ${r.reset ? "reset" : "already up"}`),
  });
}
