// The agent adapter names, import-free on purpose: src/config-schema.js (bundled by the
// browser) offers them as options and src/config.js validates against them, neither of
// which may pull the Node-side registry (src/agents/index.js). A test holds the two equal.

/** Every registered agent adapter, default first. */
export const AGENT_NAMES = /** @type {const} */ (["claude"]);

/** The agent a step runs when neither it nor the profile names one. */
export const DEFAULT_AGENT = "claude";
