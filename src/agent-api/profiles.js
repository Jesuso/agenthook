import { registryDir } from "../config/locations.js";
import { peekConfig } from "../config/load.js";
import { listProfiles } from "../heartbeat.js";

/**
 * Pick the profile a tool call targets. An explicit `arg` (state key, else unique label) wins;
 * otherwise `defaultKey` (the profile of the config discovered at startup); otherwise the only
 * profile that is up. Returns `{ entry }` or `{ error }` (never throws on ambiguity).
 * @param {string|undefined} arg @param {string|null} defaultKey @param {string} [registry]
 */
export function pickProfile(arg, defaultKey, registry = registryDir) {
  const all = listProfiles(registry).filter((p) => !p.ghost);
  const names = () => all.map((p) => p.stateKey).join(", ") || "(none)";
  if (arg) {
    const byKey = all.find((p) => p.stateKey === arg);
    if (byKey) return { entry: byKey };
    const byLabel = all.filter((p) => p.name === arg);
    if (byLabel.length === 1) return { entry: byLabel[0] };
    if (!byLabel.length) {
      // Agents type names from memory: fall back to a case-insensitive match, only when unique.
      const lc = arg.toLowerCase();
      const loose = all.filter((p) => p.stateKey.toLowerCase() === lc || p.name.toLowerCase() === lc);
      if (loose.length === 1) return { entry: loose[0] };
    }
    return { error: byLabel.length > 1 ? `profile "${arg}" is ambiguous; use a state key: ${names()}` : `unknown profile "${arg}"; known: ${names()}` };
  }
  const def = defaultKey && all.find((p) => p.stateKey === defaultKey);
  if (def) return { entry: def };
  const up = all.filter((p) => p.up);
  if (up.length === 1) return { entry: up[0] };
  return { error: `profile required; known: ${names()}` };
}

/**
 * Resolve several profiles for a multi-profile call: `all` = every non-ghost profile (up or
 * down — a down profile's events.jsonl is still readable); else each name through
 * `pickProfile`, deduped by state key. The first unresolvable name is the error.
 * @param {string[]} names @param {{all?: boolean}} [o] @param {string} [registry]
 * @returns {{entries: ReturnType<typeof listProfiles>} | {error: string}}
 */
export function pickProfiles(names, { all = false } = {}, registry = registryDir) {
  if (all) {
    const entries = listProfiles(registry).filter((p) => !p.ghost);
    return entries.length ? { entries } : { error: "no profiles" };
  }
  /** @type {ReturnType<typeof listProfiles>} */
  const entries = [];
  for (const name of names) {
    const r = pickProfile(name, null, registry);
    if ("error" in r) return { error: String(r.error) };
    if (!entries.some((e) => e.stateKey === r.entry.stateKey)) entries.push(r.entry);
  }
  return entries.length ? { entries } : { error: "no profiles" };
}

/** The state key of the config discoverable from `cwd`/--config, or null. @param {string} [configPath] */
export function defaultProfileKey(configPath) {
  try {
    return peekConfig({ configPath }).stateKey;
  } catch {
    return null;
  }
}

/** Compact one-line-per-profile listing. @param {string} [registry] */
export function readProfiles(registry = registryDir) {
  return listProfiles(registry)
    .filter((p) => !p.ghost)
    .map((p) => ({
      profile: p.stateKey,
      ...(p.name !== p.stateKey ? { label: p.name } : {}),
      up: p.up,
      tracker: p.heartbeat?.tracker ?? null,
      active: p.up ? p.heartbeat?.queue?.active ?? 0 : null,
      queued: p.up ? p.heartbeat?.queue?.queued ?? 0 : null,
      max: p.heartbeat?.maxConcurrent ?? null,
    }));
}
