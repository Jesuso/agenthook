// The agent adapter names, import-free on purpose: src/config-schema.js (bundled by the
// browser) offers them as options and src/config.js validates against them, neither of
// which may pull the Node-side registry (src/agents/index.js). A test holds the two equal.

/** Every registered agent adapter, default first. */
export const AGENT_NAMES = /** @type {const} */ (["claude", "cursor", "hermes"]);

/** The agent a step runs when neither it nor the profile names one. */
export const DEFAULT_AGENT = "claude";

/** Each agent's default binary (its adapter's `defaults.bin`; claude's is `claudeBin`, default
 * "claude"), import-free so peekConfig can list them for `agents`' ps match. A test holds it
 * equal to the registry. */
export const AGENT_DEFAULT_BINS = /** @type {const} */ ({ claude: "claude", cursor: "agent", hermes: "hermes" });
