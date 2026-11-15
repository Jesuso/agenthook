// `agenthook pause` / `unpause` / `concurrency` — operator runtime overrides (global pause, a
// per-harness drain, the global concurrency cap, per-harness slots) against the live receiver over
// the control socket (src/ops.js). They persist in overrides.json and survive a restart. `unpause`
// (not `resume`) because `agenthook resume` already means agent-session resume.
import { peekConfig } from "../config.js";
import { readProfile } from "../heartbeat.js";
import { controlSockPath } from "../paths.js";
import { controlRequest } from "../ui/control-client.js";

/** The CLI args these commands read: the parsed positional/flag map from bin/agenthook.js. */
/** @typedef {{_: string[], config?: string, harness?: string}} OverrideArgs */

/**
 * Send one override op and print its reply (including its note). Exits 1 when the receiver is down
 * or the op failed. @param {OverrideArgs} args @param {string} cmd @param {Record<string, unknown>} payload
 */
async function send(args, cmd, payload) {
  const { name, stateKey, stateDir } = peekConfig({ configPath: args.config });
  const profile = readProfile(stateKey);
  if (!profile.up) {
    console.log(`"${name}" not running`);
    process.exitCode = 1;
    return;
  }
  let reply;
  try {
    reply = await controlRequest(controlSockPath(stateDir, stateKey), cmd, payload, { timeoutMs: 5000 });
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
  printReply(reply.result);
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

/** `agenthook concurrency <n|reset> [--harness <name>]` — set (or reset) a cap. @param {OverrideArgs} args */
export async function concurrency(args) {
  const value = args._[0];
  const harness = harnessArg(args);
  if (value === "reset") {
    await send(args, "set_concurrency", harness ? { reset: true, harness } : { reset: true });
    return;
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 64) {
    console.error(`usage: agenthook concurrency <n|reset> [--harness <name>]`);
    process.exitCode = 1;
    return;
  }
  await send(args, "set_concurrency", harness ? { max: n, harness } : { max: n });
}
