// Provider registry. Each adapter implements the same interface (see asana.js
// for the reference doc-comment). Add a new platform by dropping a file here
// and registering it below — the engine never changes.
import { createAsanaAdapter } from "./asana.js";
import { createGithubAdapter } from "./github.js";

/** @type {Record<string, import('../types.js').AdapterFactory>} */
const REGISTRY = {
  asana: createAsanaAdapter,
  github: createGithubAdapter,
};

/**
 * @param {import('../types.js').Config} cfg
 * @param {import('../types.js').Store} store
 * @returns {import('../types.js').Adapter}
 */
export function createAdapter(cfg, store) {
  const factory = REGISTRY[cfg.provider];
  if (!factory) {
    throw new Error(`unknown provider "${cfg.provider}". Known: ${Object.keys(REGISTRY).join(", ")}`);
  }
  return factory(cfg, store);
}
