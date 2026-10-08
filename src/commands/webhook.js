// `agenthook register <url>` / `agenthook unregister` — manual webhook escape
// hatches. Normally the server registers/unregisters automatically on boot/exit
// (server-owns-ingress); these exist for hosted setups where you want to wire the
// hook once against a stable URL without running the receiver.
import fs from "node:fs";
import { loadConfig } from "../config.js";
import { requireStarted } from "../profile.js";
import { createStore } from "../store.js";
import { createAdapter } from "../trackers/index.js";
import { createForge } from "../forges/index.js";

/** @param {any} args */
export async function register(args) {
  const cfg = loadConfig({ configPath: args.config });
  requireStarted(cfg);
  const url = args._[0] || cfg.ingress?.url;
  if (!url) throw new Error("usage: agenthook register <https-public-url> (or set ingress.url for hosted)");
  const store = createStore(cfg.dataDir);
  const adapter = createAdapter(cfg, store);
  const forge = createForge(cfg, store); // construct before overwriting public_url.txt — it snapshots the previous URL
  const clean = String(url).replace(/\/$/, "");
  fs.writeFileSync(cfg.publicUrlFile, clean);
  await adapter.registerWebhook(clean);
  await forge?.registerWebhook(clean);
}

/** @param {any} args */
export async function unregister(args) {
  const cfg = loadConfig({ configPath: args.config });
  requireStarted(cfg);
  const store = createStore(cfg.dataDir);
  const adapter = createAdapter(cfg, store);
  await adapter.unregisterWebhooks();
  await createForge(cfg, store)?.unregisterWebhooks();
  console.log("done");
}
