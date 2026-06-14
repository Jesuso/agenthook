// Ingress registry — the second blind axis (see docs/agenthook-v2.md). A tracker
// answers "where does work come from"; an ingress answers "how is the receiver
// reachable from the internet". The engine calls up()/down() and reads the
// ephemeral flag to decide whether to scrub stale webhooks on boot.
import { createNgrokIngress } from "./ngrok.js";
import { createManualIngress } from "./manual.js";

/** @type {Record<string, import('../types.js').IngressFactory>} */
export const INGRESS = {
  ngrok: createNgrokIngress,
  manual: createManualIngress,
  hosted: createManualIngress, // alias: a static, externally-managed URL
};

/**
 * @param {import('../types.js').Config} cfg
 * @returns {import('../types.js').Ingress}
 */
export function createIngress(cfg) {
  const type = cfg.ingress?.type || "manual";
  const factory = INGRESS[type];
  if (!factory) throw new Error(`unknown ingress "${type}". Known: ${Object.keys(INGRESS).join(", ")}`);
  return factory(cfg);
}
