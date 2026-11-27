// `agenthook restart` — ask the running receiver to restart once idle (src/engine.js
// createRestartRequester, over the control socket). No `--wait`/polling: it reports the
// accepted state and leaves watching to `agenthook status` / `agenthook events --follow`.
import { peekConfig } from "../config.js";
import { readProfile } from "../heartbeat.js";
import { controlSockPath } from "../paths.js";
import { controlRequest } from "../control/client.js";

/** @param {any} args */
export async function restart(args) {
  const { name, stateKey, stateDir } = peekConfig({ configPath: args.config });
  const profile = readProfile(stateKey);
  if (!profile.up) {
    console.log(`"${name}" not running`);
    process.exitCode = 1;
    return;
  }

  await sendRestart(controlSockPath(stateDir, stateKey), { when: "idle" });
}

/**
 * Send one `restart` request over `sockPath` and print the outcome (exit code 1 on any
 * failure). Shared with `rename --move`, which adds `moveTo`. Returns whether it was accepted.
 * @param {string} sockPath @param {{when: "idle", moveTo?: string}} req @returns {Promise<boolean>}
 */
export async function sendRestart(sockPath, req) {
  let reply;
  try {
    reply = await controlRequest(sockPath, "restart", req, { timeoutMs: 5000 });
  } catch (e) {
    console.error(`restart: ${e.code === "timeout" ? "timed out waiting for the receiver" : "receiver is down"}`);
    process.exitCode = 1;
    return false;
  }

  if (!reply.ok) {
    // Refusals the receiver itself exposes already start with `restart: ` (src/engine/controllers.js);
    // print them as-is so the prefix is not doubled. Anything else (opaque `restart failed`,
    // `move: …`) keeps the current single prefix.
    const msg = String(reply.error);
    console.error(msg.startsWith("restart:") ? msg : `restart: ${msg}`);
    process.exitCode = 1;
    return false;
  }

  const { alreadyPending, active, queued, harnessesDown } = reply.result;
  if (alreadyPending) {
    console.log(`restart already pending (${active} running agent(s), ${queued} queued)`);
  } else if (active === 0) {
    console.log("restarting now (no agents running)");
  } else {
    console.log(`restart requested — restarting once ${active} running agent(s) finish (${queued} queued)`);
  }
  for (const h of harnessesDown ?? []) {
    console.log(`harness "${h.harness}" is down until ${h.until} (${h.reason}) — the breaker survives the restart; run harness_reset once the cause is fixed`);
  }
  console.log("watch with `agenthook status` or `agenthook events --follow`");
  return true;
}
