// `agenthook reload` — re-read and validate the config, then apply its reloadable keys (harnesses,
// steps' spawn knobs, egress, caps, quota) to runs that start after the reload. Running agents keep
// the config they started with. Sent over the control socket (src/ops.js `reload`); a key that needs
// a restart (or an invalid config) comes back as an error naming every such key and exits 1.
import { peekConfig } from "../config/index.js";
import { readProfile } from "../heartbeat.js";
import { controlSockPath } from "../paths.js";
import { controlRequest } from "../control/client.js";

/** @param {{config?: string}} args */
export async function reload(args) {
  const { name, stateKey, stateDir } = peekConfig({ configPath: args.config });
  const profile = readProfile(stateKey);
  if (!profile.up) {
    console.log(`"${name}" not running`);
    process.exitCode = 1;
    return;
  }

  let reply;
  try {
    // A reload may run a sandbox image check (a newly gained run image), which can take a while.
    reply = await controlRequest(controlSockPath(stateDir, stateKey), "reload", {}, { timeoutMs: 60_000 });
  } catch (e) {
    console.error(`reload: ${e.code === "timeout" ? "timed out waiting for the receiver" : "receiver is down"}`);
    process.exitCode = 1;
    return;
  }

  if (!reply.ok) {
    console.error(`reload: ${reply.error}`);
    process.exitCode = 1;
    return;
  }

  const { changed, note } = reply.result;
  if (!changed.length) {
    console.log(note);
    return;
  }
  for (const key of changed) console.log(key);
  console.log(note);
}
