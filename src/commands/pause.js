// `agenthook pause` / `unpause` / `concurrency` — operator runtime overrides (global pause, a
// per-harness drain, the global concurrency cap, per-harness slots) against the live receiver over
// the control socket (src/ops.js). They persist in overrides.json and survive a restart. `unpause`
// (not `resume`) because `agenthook resume` already means agent-session resume.
import { peekConfig } from "../config/index.js";
import { readProfile } from "../heartbeat.js";
import { controlSockPath } from "../paths.js";
import { controlRequest } from "../control/client.js";
import { liveTimeoutMs } from "../agent-api/index.js";

/** The CLI args these commands read: the parsed positional/flag map from bin/agenthook.js. */
/** @typedef {{_: string[], config?: string, harness?: string, json?: boolean, reset?: boolean}} OverrideArgs */

/** The control-request function `send` uses — swapped by tests to observe the per-op timeoutMs.
 * @type {(sockPath: string, cmd: string, args: Record<string, unknown>, opts: { timeoutMs: number }) =>
 *   Promise<{ ok: true, result: Record<string, unknown> } | { ok: false, error: string }>} */
let request = controlRequest;

/** Swap the control-request function (tests only).
 * @param {(sockPath: string, cmd: string, args: Record<string, unknown>, opts: { timeoutMs: number }) =>
 *   Promise<{ ok: true, result: Record<string, unknown> } | { ok: false, error: string }>} fn */
export function setControlRequest(fn) {
  request = fn;
}

/**
 * Send one control op over the control socket and print its reply. Exits 1 when the receiver is
 * down or the op failed; prints the reply as JSON with `--json`, else `plain`'s lines. Shared by
 * the override ops (this file) and the run-control ops (control-ops.js). @param {OverrideArgs} args
 * @param {string} cmd @param {Record<string, unknown>} payload
 * @param {{ timeoutMs?: number, plain?: (r: Record<string, unknown>) => void }} [opts]
 */
export async function send(args, cmd, payload, opts = {}) {
  const { timeoutMs = 5000, plain = printReply } = opts;
  const { name, stateKey, stateDir } = peekConfig({ configPath: args.config });
  const profile = readProfile(stateKey);
  if (!profile.up) {
    console.log(`"${name}" not running`);
    process.exitCode = 1;
    return;
  }
  let reply;
  try {
    reply = await request(controlSockPath(stateDir, stateKey), cmd, payload, { timeoutMs });
  } catch (e) {
    console.error(`${cmd}: ${e.code === "timeout" ? "timed out waiting for the receiver" : "receiver is down"}`);
    process.exitCode = 1;
    return;
  }
  if (!reply.ok) {
    console.error(`${cmd}: ${reply.error}`);
    process.exitCode = 1;
    return;
  }
  if (args.json) console.log(JSON.stringify(reply.result, null, 2));
  else plain(reply.result);
}

/** @param {Record<string, unknown>} r */
function printReply(r) {
  const summary =
    typeof r.note === "string"
      ? r.note
      : typeof r.harness === "string" && typeof r.maxConcurrent === "number"
        ? `harness "${r.harness}": ${r.maxConcurrent}`
        : typeof r.maxConcurrent === "number"
          ? `maxConcurrent: ${r.maxConcurrent}`
          : r.paused !== undefined
            ? (r.paused ? "paused" : "resumed")
            : "ok";
  console.log(summary);
}

/** @param {OverrideArgs} args */
const harnessArg = (args) => (typeof args.harness === "string" && args.harness ? args.harness : undefined);

/** `agenthook pause [--harness <name>]` — pause the whole profile, or drain one harness. @param {OverrideArgs} args */
export async function pause(args) {
  const harness = harnessArg(args);
  await send(args, "pause", harness ? { harness } : {});
}

/** `agenthook unpause [--harness <name>]` — clear the pause, or a harness's drain. @param {OverrideArgs} args */
export async function unpause(args) {
  const harness = harnessArg(args);
  await send(args, "resume", harness ? { harness } : {});
}

/** `agenthook concurrency <n|reset> [--reset] [--harness <name>] [--json]` (alias `set-concurrency`) —
 * set (or reset) a cap. @param {OverrideArgs} args */
export async function concurrency(args) {
  const value = args._[0];
  const harness = harnessArg(args);
  const wantReset = value === "reset" || args.reset === true;
  const wantMax = value !== undefined && value !== "reset";
  // Exactly one of a number and a reset — like the `set_concurrency` op itself.
  if (wantReset === wantMax) {
    console.error(`usage: agenthook concurrency <n|reset> [--reset] [--harness <name>] [--json]`);
    process.exitCode = 1;
    return;
  }
  if (wantReset) {
    await send(args, "set_concurrency", harness ? { reset: true, harness } : { reset: true }, { timeoutMs: liveTimeoutMs("set_concurrency") });
    return;
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 64) {
    console.error(`usage: agenthook concurrency <n|reset> [--reset] [--harness <name>] [--json]`);
    process.exitCode = 1;
    return;
  }
  await send(args, "set_concurrency", harness ? { max: n, harness } : { max: n }, { timeoutMs: liveTimeoutMs("set_concurrency") });
}
