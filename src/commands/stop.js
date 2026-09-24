// `agenthook stop` — signal the running receiver to shut down (its handler tears
// down the ingress tunnel and clears pid/heartbeat). Also deletes the tracker
// webhooks (and the forge's, when one is configured) unless --keep-hooks is given.
import fs from "node:fs";
import { loadConfig } from "../config.js";
import { createStore } from "../store.js";
import { createAdapter } from "../trackers/index.js";
import { createForge } from "../forges/index.js";
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
    const store = createStore(cfg.dataDir);
    try {
      const adapter = createAdapter(cfg, store);
      await adapter.unregisterWebhooks();
    } catch (e) {
      console.error("[unregister] failed:", e.message);
    }
    try {
      await createForge(cfg, store)?.unregisterWebhooks();
    } catch (e) {
      console.error("[unregister] forge failed:", e.message);
    }
  }
}
