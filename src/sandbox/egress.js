// Which hosts a sandboxed run may reach (docs/sandbox.md#egress). Pure. The policy comes from
// `sandbox.egress` and a step's `egress`; the hosts from whoever dispatch hands in (the agent's
// model API, the tracker's and forge's APIs, the repo's origin) — this file never names a
// tracker, forge or agent. The rule syntax is the proxy's own parser (egress-proxy.mjs), so
// config validation and enforcement can't disagree.
import { parseRule } from "./egress-proxy.mjs";
import { isSandboxed, EGRESS_MODES } from "./names.js";

export { parseRule, EGRESS_MODES };

/** The package-registry hosts an `@name` entry in `allow`/`deny` expands to. None is allowed by default. */
export const REGISTRY_PRESETS = /** @type {Record<string, string[]>} */ ({
  "@npm": ["registry.npmjs.org"],
  "@yarn": ["registry.yarnpkg.com", "repo.yarnpkg.com"],
  "@pypi": ["pypi.org", "files.pythonhosted.org"],
  "@crates": ["crates.io", "index.crates.io", "static.crates.io"],
  "@go": ["proxy.golang.org", "sum.golang.org"],
  "@rubygems": ["rubygems.org", "index.rubygems.org"],
  "@maven": ["repo.maven.apache.org", "repo1.maven.org"],
});

/**
 * The problem with one `allow`/`deny` entry, or undefined when it's a valid rule or a known preset.
 * @param {unknown} entry @returns {string|undefined}
 */
export function egressEntryProblem(entry) {
  if (typeof entry !== "string") return `${JSON.stringify(entry)} is not a string`;
  if (entry.startsWith("@")) return Object.hasOwn(REGISTRY_PRESETS, entry) ? undefined : `unknown preset ${JSON.stringify(entry)} (known: ${Object.keys(REGISTRY_PRESETS).join(" ")})`;
  try {
    parseRule(entry);
    return undefined;
  } catch (e) {
    return e.message;
  }
}

/** A list of rules with every `@preset` expanded. Throws on an unknown preset.
 * @param {string[]} entries @param {Record<string, string[]>} presets */
function expand(entries, presets) {
  return entries.flatMap((e) => {
    if (!e.startsWith("@")) return [e];
    if (!Object.hasOwn(presets, e)) throw new Error(`unknown egress preset ${JSON.stringify(e)} (known: ${Object.keys(presets).join(" ")})`);
    return presets[e];
  });
}

/**
 * The egress rule for a URL's host: `host` for https on 443, else `host:port` (http defaults
 * to 80). undefined for an unparseable URL.
 * @param {string|undefined} url @returns {string|undefined}
 */
export function urlRule(url) {
  if (!url) return undefined;
  let u;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  if (!u.hostname) return undefined;
  const port = u.port ? Number(u.port) : u.protocol === "http:" ? 80 : 443;
  return port === 443 ? u.hostname : `${u.hostname}:${port}`;
}

/**
 * The rule for a git origin: an https URL keeps its explicit port; an SSH origin (scp-style or
 * `ssh://`) is pushed over HTTPS inside the sandbox (gitSandboxEnv), so it gets 443.
 * @param {string|undefined} url @returns {string|undefined}
 */
export function originRule(url) {
  if (!url) return undefined;
  const scp = /^[^@/\s]+@([^:/\s]+):/.exec(url);
  if (scp) return scp[1];
  if (/^https?:\/\//i.test(url)) return urlRule(url);
  try {
    return new URL(url).hostname || undefined;
  } catch {
    return undefined;
  }
}

/** @param {import('./egress-proxy.mjs').EgressRule} r */
const patternOf = (r) => `${r.wildcard ? "*." : ""}${r.host}`;

/**
 * A sandboxed run's allowlist, deduped, in order: the agent's model API, the tracker, the
 * forge, the origin host, then `allow` (rules and `@presets`). `deny` (rules or `@presets`)
 * then drops every rule with the same host pattern — only that port's when the entry names
 * one. `presets` defaults to REGISTRY_PRESETS. Throws on an invalid rule or unknown preset
 * (config validation catches both first).
 * @param {{agentHosts?: string[], trackerHosts?: string[], forgeHosts?: string[], originUrl?: string,
 *   presets?: Record<string, string[]>, allow?: string[], deny?: string[]}} o
 * @returns {string[]}
 */
export function egressRules({ agentHosts = [], trackerHosts = [], forgeHosts = [], originUrl, presets = REGISTRY_PRESETS, allow = [], deny = [] }) {
  const origin = originRule(originUrl);
  const all = [...agentHosts, ...trackerHosts, ...forgeHosts, ...(origin ? [origin] : []), ...expand(allow, presets)];
  const drops = expand(deny, presets).map((d) => ({ rule: parseRule(d), port: /:\d+(?:!private)?$/.test(d.trim()) }));
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {string[]} */
  const out = [];
  for (const r of all) {
    const p = parseRule(r);
    const key = `${patternOf(p)}:${p.port}${p.allowPrivate ? "!private" : ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (drops.some((d) => patternOf(d.rule) === patternOf(p) && (!d.port || d.rule.port === p.port))) continue;
    out.push(r);
  }
  return out;
}

/**
 * A step's effective egress policy: the step's `mode` over the profile's (default allowlist),
 * and the two `allow`/`deny` lists concatenated. Pure.
 * @param {{sandbox?: {egress?: import('../types.js').EgressConfig}}} cfg
 * @param {{egress?: import('../types.js').EgressConfig}|undefined} step
 * @returns {{mode: typeof EGRESS_MODES[number], allow: string[], deny: string[]}}
 */
export function egressPolicy(cfg, step) {
  const p = cfg.sandbox?.egress ?? {};
  const s = step?.egress ?? {};
  return { mode: s.mode ?? p.mode ?? "allowlist", allow: [...(p.allow ?? []), ...(s.allow ?? [])], deny: [...(p.deny ?? []), ...(s.deny ?? [])] };
}

/** Whether any sandboxed step runs in allowlist mode — its proxy needs the built-in image. Pure.
 * @param {Pick<import('../types.js').Config, 'sandbox'|'pipeline'>} cfg */
export const needsEgressProxy = (cfg) => !!cfg.sandbox && (cfg.pipeline ?? []).some((s) => !s.manual && isSandboxed(cfg, s) && egressPolicy(cfg, s).mode === "allowlist");
