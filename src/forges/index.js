// Forge registry — the third blind axis, optional. A tracker answers "where does work
// come from", an ingress "how is the receiver reachable", a forge "what happened to
// the code" (e.g. a PR merged). The active forge is `cfg.forge.type`; no `forge`
// block = no forge, and the engine behaves exactly as without one.
import { createGithubForge, GITHUB_FORGE_AGENT_ENV, githubForgeEgressHosts } from "./github.js";
import { createGitlabForge, GITLAB_FORGE_AGENT_ENV, gitlabForgeEgressHosts } from "./gitlab.js";

export { isForgePath } from "./github.js";

/** @type {Record<string, import('../types.js').ForgeFactory>} */
export const FORGES = {
  github: createGithubForge,
  gitlab: createGitlabForge,
};

/** Each forge's `describe().agentEnv`, keyed like FORGES (doctor reads it without building one). */
/** @type {Record<string, string[]>} */
export const FORGE_AGENT_ENV = {
  github: GITHUB_FORGE_AGENT_ENV,
  gitlab: GITLAB_FORGE_AGENT_ENV,
};

/** Each forge's `describe().egressHosts` from its config, keyed like FORGES (doctor reads it without building one). */
/** @type {Record<string, (fc: import('../types.js').ForgeConfig) => string[]>} */
export const FORGE_EGRESS_HOSTS = {
  github: githubForgeEgressHosts,
  gitlab: gitlabForgeEgressHosts,
};

/**
 * @param {import('../types.js').Config} cfg
 * @param {import('../types.js').Store} store
 * @returns {import('../types.js').Forge|null}  null when no forge is configured
 */
export function createForge(cfg, store) {
  if (!cfg.forge) return null;
  const factory = FORGES[cfg.forge.type];
  if (!factory) throw new Error(`unknown forge "${cfg.forge.type}". Known: ${Object.keys(FORGES).join(", ")}`);
  return factory(cfg, store);
}
