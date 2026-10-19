// Tracker registry. Each adapter implements the same interface (see asana.js for
// the reference doc-comment). Add a platform by dropping a file here and listing
// it below — the engine never changes. The active tracker is `cfg.tracker.type`.
import { createAsanaAdapter, ASANA_AGENT_ENV, asanaEgressHosts } from "./asana.js";
import { createJiraAdapter, JIRA_AGENT_ENV, jiraEgressHosts } from "./jira.js";
import { createGithubAdapter, GITHUB_AGENT_ENV, githubEgressHosts } from "./github.js";
import { createGithubProjectsAdapter, GITHUB_PROJECTS_AGENT_ENV, githubProjectsEgressHosts } from "./github-projects.js";
import { createLocalAdapter, LOCAL_AGENT_ENV } from "./local.js";
import { createLinearAdapter, LINEAR_AGENT_ENV, linearEgressHosts } from "./linear.js";

// GitHub has no board sections, so it drives the pipeline off issue LABELS (see github.js).
// github-projects instead drives off a Projects v2 board's Status field (see that file);
// linear off one team's workflow states (see linear.js).
/** @type {Record<string, import('../types.js').AdapterFactory>} */
export const TRACKERS = {
  asana: createAsanaAdapter,
  jira: createJiraAdapter,
  github: createGithubAdapter,
  "github-projects": createGithubProjectsAdapter,
  local: createLocalAdapter,
  linear: createLinearAdapter,
};

/** Each tracker's `describe().agentEnv` (the env vars its prompt tells an agent to use), keyed
 * like TRACKERS, so doctor can read it without building an adapter. */
/** @type {Record<string, string[]>} */
export const TRACKER_AGENT_ENV = {
  asana: ASANA_AGENT_ENV,
  jira: JIRA_AGENT_ENV,
  github: GITHUB_AGENT_ENV,
  "github-projects": GITHUB_PROJECTS_AGENT_ENV,
  local: LOCAL_AGENT_ENV,
  linear: LINEAR_AGENT_ENV,
};

/** Each tracker's `describe().egressHosts` from its provider config, keyed like TRACKERS, so
 * doctor can show a sandboxed step's allowlist without building an adapter (local: none). */
/** @type {Record<string, (pc: import('../types.js').ProviderConfig) => string[]>} */
export const TRACKER_EGRESS_HOSTS = {
  asana: asanaEgressHosts,
  jira: jiraEgressHosts,
  github: githubEgressHosts,
  "github-projects": githubProjectsEgressHosts,
  local: () => [],
  linear: linearEgressHosts,
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
