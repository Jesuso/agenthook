// Tracker registry. Each adapter implements the same interface (see asana.js for
// the reference doc-comment). Add a platform by dropping a file here and listing
// it below — the engine never changes. The active tracker is `cfg.tracker.type`.
import { createAsanaAdapter } from "./asana.js";
import { createJiraAdapter } from "./jira.js";
import { createGithubAdapter } from "./github.js";

// GitHub has no board sections, so it drives the pipeline off issue LABELS (see github.js).
/** @type {Record<string, import('../types.js').AdapterFactory>} */
export const TRACKERS = {
  asana: createAsanaAdapter,
  jira: createJiraAdapter,
  github: createGithubAdapter,
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
