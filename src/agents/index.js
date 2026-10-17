// Agent registry — the axis that names the coding-agent CLI a step spawns (Claude Code,
// Cursor, Hermes). dispatch builds argv / parses stdout / records usage through the
// adapter; follow and resume find transcripts through its `sessions`. Keys must equal the
// import-free AGENT_NAMES (src/agents/names.js) the config schema + validation use.
import { claude } from "./claude.js";
import { cursor } from "./cursor.js";
import { hermes } from "./hermes.js";
import { DEFAULT_AGENT } from "./names.js";

/** @type {Record<string, import('../types.js').AgentAdapter>} */
export const AGENTS = {
  claude,
  cursor,
  hermes,
};

/**
 * The adapter registered under `name` (unset → the default agent). Throws on an unknown
 * name — config validation rejects one at load, so this only fires on a hand-built cfg.
 * @param {string} [name]
 * @returns {import('../types.js').AgentAdapter}
 */
export function getAgent(name = DEFAULT_AGENT) {
  const agent = Object.hasOwn(AGENTS, name) ? AGENTS[name] : undefined;
  if (!agent) throw new Error(`unknown agent "${name}". Known: ${Object.keys(AGENTS).join(", ")}`);
  return agent;
}

/**
 * The adapter a step runs: the step's `agent`, else the profile's, else the default.
 * @param {Pick<import('../types.js').Config, 'agent'>} cfg @param {Pick<import('../types.js').Step, 'agent'>} [step]
 */
export const agentFor = (cfg, step) => getAgent(step?.agent ?? cfg.agent ?? DEFAULT_AGENT);
