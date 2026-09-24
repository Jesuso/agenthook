// Multi-repo routing: map a task's opaque route keys (Task.routeKeys, adapter-supplied)
// to one of the profile's checkouts (cfg.repos). Pure, no I/O. The adapter never learns
// about repos and the engine never learns what a route key means — config joins them.
//
// A profile without a `repos` block gets one synthesized `default` repo (config.js), so
// every task resolves to it and nothing changes. Ambiguity never guesses: two matching
// repos is a `conflict`, no match and no default is `unroutable` — both hold the task.

/** @typedef {import('./types.js').RepoConfig} RepoConfig */

/**
 * The profile's repos. Falls back to one synthesized from `repoPath` when `cfg.repos` is
 * absent (hand-built configs in tests / ops callers), mirroring config.js's synthesis.
 * @param {import('./types.js').Config} cfg @returns {RepoConfig[]}
 */
export function reposOf(cfg) {
  return cfg.repos?.length ? cfg.repos : [{ id: "default", path: cfg.repoPath, match: [], default: true }];
}

/** The `default:true` repo, if any. @param {import('./types.js').Config} cfg */
export function defaultRepo(cfg) {
  return reposOf(cfg).find((r) => r.default);
}

/** The default repo, else the first declared — what repo-less callers (ops) fall back to.
 * @param {import('./types.js').Config} cfg @returns {RepoConfig} */
export function primaryRepo(cfg) {
  return defaultRepo(cfg) ?? reposOf(cfg)[0];
}

/** @param {import('./types.js').Config} cfg @param {string|undefined} id */
export function repoById(cfg, id) {
  return id == null ? undefined : reposOf(cfg).find((r) => r.id === id);
}

/** Route keys normalized the way config.js normalizes `match`: trimmed, lowercased, deduped.
 * @param {unknown[]|undefined} keys @returns {string[]} */
export function normalizeKeys(keys) {
  if (!Array.isArray(keys)) return [];
  return [...new Set(keys.filter((k) => typeof k === "string").map((k) => k.trim().toLowerCase()).filter(Boolean))];
}

/**
 * Resolve a task's route keys to exactly one repo. One match → it; none → the default
 * repo (else `unroutable`); more than one → `conflict`. Both errors fail closed.
 * @param {import('./types.js').Config} cfg
 * @param {string[]|undefined} routeKeys
 * @returns {{ repo: RepoConfig } | { error: "unroutable"|"conflict", message: string }}
 */
export function resolveRepo(cfg, routeKeys) {
  const keys = normalizeKeys(routeKeys);
  const repos = reposOf(cfg);
  const hits = repos.filter((r) => r.match.some((m) => keys.includes(m)));
  if (hits.length === 1) return { repo: hits[0] };
  const shown = keys.length ? keys.map((k) => `"${k}"`).join(", ") : "(none)";
  if (hits.length > 1) {
    return { error: "conflict", message: `route keys ${shown} match more than one repo (${hits.map((r) => r.id).join(", ")}) — narrow the routing field to one` };
  }
  const def = defaultRepo(cfg);
  if (def) return { repo: def };
  return {
    error: "unroutable",
    message: `route keys ${shown} match no repo and none is default (repos: ${repos.map((r) => r.id).join(", ")}) — set the routing field`,
  };
}
