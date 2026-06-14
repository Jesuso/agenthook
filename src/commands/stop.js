// `agenthook stop` — signal the running receiver to shut down (its handler tears
// down the ingress tunnel and clears pid/heartbeat). Also deletes the tracker
// webhooks unless --keep-hooks is given.
import fs from "node:fs";
import { loadConfig } from "../config.js";
import { createStore } from "../store.js";
import { createAdapter } from "../trackers/index.js";
import { readProfile } from "../heartbeat.js";

/** @param {any} args */
export async function stop(args) {
  const cfg = loadConfig({ configPath: args.config });
  const { pid, up } = readProfile(cfg.name);

  if (up) {
    process.kill(pid, "SIGTERM");
    console.log(`stopped "${cfg.name}" (pid ${pid})`);
  } else {
    console.log(`"${cfg.name}" not running${pid ? " (stale pidfile)" : ""}`);
    try {
      fs.rmSync(cfg.pidFile, { force: true });
    } catch {
      /* ignore */
    }
  }

  if (!args["keep-hooks"]) {
    try {
      const adapter = createAdapter(cfg, createStore(cfg.dataDir));
      await adapter.unregisterWebhooks();
    } catch (e) {
      console.error("[unregister] failed:", e.message);
    }
  }
}
