// Tracker registry. Each adapter implements the same interface (see asana.js for
// the reference doc-comment). Add a platform by dropping a file here and listing
// it below — the engine never changes. The active tracker is `cfg.tracker.type`.
import { createAsanaAdapter, ASANA_AGENT_ENV } from "./asana.js";
import { createJiraAdapter, JIRA_AGENT_ENV } from "./jira.js";
import { createGithubAdapter, GITHUB_AGENT_ENV } from "./github.js";
import { createGithubProjectsAdapter, GITHUB_PROJECTS_AGENT_ENV } from "./github-projects.js";
import { createLocalAdapter, LOCAL_AGENT_ENV } from "./local.js";
import { createLinearAdapter, LINEAR_AGENT_ENV } from "./linear.js";

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
