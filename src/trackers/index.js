// Tracker registry. Each adapter implements the same interface (see asana.js for
// the reference doc-comment). Add a platform by dropping a file here and listing
// it below — the engine never changes. The active tracker is `cfg.tracker.type`.
import { createAsanaAdapter } from "./asana.js";

// GitHub (and other section-less trackers) return in P3, mapped to labels/columns.
/** @type {Record<string, import('../types.js').AdapterFactory>} */
export const TRACKERS = {
  asana: createAsanaAdapter,
};

/**
 * @param {import('../types.js').Config} cfg
 * @param {import('../types.js').Store} store
 * @returns {import('../types.js').Adapter}
 */
export function createAdapter(cfg, store) {
  const factory = TRACKERS[cfg.provider];
  if (!factory) {
    throw new Error(`unknown tracker "${cfg.provider}". Known: ${Object.keys(TRACKERS).join(", ")}`);
  }
  return factory(cfg, store);
}
