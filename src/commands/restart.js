// `agenthook restart` — ask the running receiver to restart once idle (src/engine.js
// createRestartRequester, over the control socket). No `--wait`/polling: it reports the
// accepted state and leaves watching to `agenthook status` / `agenthook events --follow`.
import { peekConfig } from "../config.js";
import { readProfile } from "../heartbeat.js";
import { controlSockPath } from "../paths.js";
import { controlRequest } from "../ui/control-client.js";

/** @param {any} args */
export async function restart(args) {
  const { name, stateKey, stateDir } = peekConfig({ configPath: args.config });
  const profile = readProfile(stateKey);
  if (!profile.up) {
    console.log(`"${name}" not running`);
    process.exitCode = 1;
    return;
  }

  let reply;
  try {
    reply = await controlRequest(controlSockPath(stateDir, stateKey), "restart", { when: "idle" }, { timeoutMs: 5000 });
  } catch (e) {
    console.error(`restart: ${e.code === "timeout" ? "timed out waiting for the receiver" : "receiver is down"}`);
    process.exitCode = 1;
    return;
  }

  if (!reply.ok) {
    console.error(`restart: ${reply.error}`);
    process.exitCode = 1;
    return;
  }

  const { alreadyPending, active, queued } = reply.result;
  if (alreadyPending) {
    console.log(`restart already pending (${active} running agent(s), ${queued} queued)`);
  } else if (active === 0) {
    console.log("restarting now (no agents running)");
  } else {
    console.log(`restart requested — restarting once ${active} running agent(s) finish (${queued} queued)`);
  }
  console.log("watch with `agenthook status` or `agenthook events --follow`");
}
