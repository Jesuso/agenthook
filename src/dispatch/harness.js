// Named harnesses (`harnesses` in the profile): a step's `harness` list, and the effective step
// a run spawns with once the queue picked one. Pure — no I/O.

/** Spawn knobs a harness supplies where the step sets none of its own. */
const HARNESS_KNOBS = /** @type {const} */ (["agent", "model", "effort", "bin", "provider", "toolsets", "opencodeConfig", "piConfigDir", "contextTokens"]);

/**
 * The harness names a step routes through, in order (a string is a one-element list); [] when
 * the step names none. An object entry (`{name, model?, effort?}`) contributes its `name`.
 * @param {Pick<import('../types/pipeline.js').Step, 'harness'>} step
 * @returns {string[]}
 */
export function harnessesOf(step) {
  const h = step.harness;
  if (h == null) return [];
  if (typeof h === "string") return [h];
  return h.map((e) => (typeof e === "string" ? e : e.name));
}

/**
 * The object entry a step's `harness` list carries for `name`, or undefined (a string step
 * `harness` has none). Pure.
 * @param {Pick<import('../types/pipeline.js').Step, 'harness'>} step
 * @param {string} name
 * @returns {import('../types/pipeline.js').HarnessEntry|undefined}
 */
export function harnessEntryOf(step, name) {
  const h = step.harness;
  if (h == null || typeof h === "string") return undefined;
  return /** @type {import('../types/pipeline.js').HarnessEntry|undefined} */ (h.find((e) => typeof e === "object" && e !== null && e.name === name));
}

/**
 * The step a run on `harnessName` spawns with: the step's inline agent/model/effort/bin/provider/
 * toolsets, else the harness's, else unset (the profile and adapter defaults apply as without a
 * harness). `env` is the harness's under the step's. An object entry for `harnessName` in the
 * step's `harness` list pins its `model`/`effort` over everything else (escalate/lite included)
 * for runs routed to that harness alone. A null or unknown name returns the step unchanged with
 * `harness: null`. The input step is never mutated.
 * @param {Pick<import('../types/config.js').Config, 'harnesses'>} cfg
 * @param {import('../types/pipeline.js').Step} step
 * @param {string|null|undefined} harnessName
 * @returns {{step: import('../types/pipeline.js').Step, harness: string|null, sandboxImage: string|undefined}}
 */
export function resolveHarness(cfg, step, harnessName) {
  const h = harnessName && cfg.harnesses && Object.hasOwn(cfg.harnesses, harnessName) ? cfg.harnesses[harnessName] : undefined;
  if (!harnessName || !h) return { step, harness: null, sandboxImage: undefined };
  /** @type {import('../types/pipeline.js').Step} */
  const eff = { ...step };
  for (const k of HARNESS_KNOBS) {
    if (eff[k] == null && h[k] != null) Object.assign(eff, { [k]: h[k] });
  }
  const env = { ...h.env, ...step.env };
  if (Object.keys(env).length) eff.env = env;
  else delete eff.env;
  // A per-entry pin beats everything the step/harness/escalate/lite set for this harness only.
  const entry = harnessEntryOf(step, harnessName);
  if (entry) {
    for (const k of /** @type {const} */ (["model", "effort"])) {
      const v = entry[k];
      if (v == null) continue;
      Object.assign(eff, { [k]: v });
      if (eff.lite && eff.lite[k] != null) eff.lite = { ...eff.lite, [k]: v };
      if (eff.escalate) {
        const esc = { ...eff.escalate };
        for (const [tier, t] of Object.entries(esc)) {
          if (t && t[k] != null) esc[tier] = { ...t, [k]: v };
        }
        eff.escalate = esc;
      }
    }
  }
  return { step: eff, harness: harnessName, sandboxImage: h.sandbox?.image };
}

/** The env vars that give a claude run its own subscription — a base URL, or a credential of its
 * own — so its quota reading belongs to a group of one instead of the profile's shared login. */
export const QUOTA_CREDENTIAL_VARS = /** @type {const} */ (["ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"]);

/** @param {Record<string, string|undefined>|undefined} env  true when the env sets any own-subscription var. */
const ownSubscription = (env) => QUOTA_CREDENTIAL_VARS.some((k) => env?.[k]);

/** The named harnesses in the profile's shared (default-login) claude group: effective agent
 * claude and no own-subscription env. @param {Pick<import('../types/config.js').Config, 'agent'|'harnesses'>} cfg */
const sharedQuotaHarnesses = (cfg) =>
  Object.entries(cfg.harnesses ?? {})
    .filter(([, h]) => (h.agent ?? cfg.agent ?? "claude") === "claude" && !ownSubscription(h.env))
    .map(([name]) => name);

/**
 * The subscription group a claude run shares its quota with (src/engine `createHarnessQuota`):
 * a run on `harnessName`, or an unharnessed run (`harnessName` null/undefined) of `step`. `harnesses`
 * lists the named harnesses to close when the run reports an above-threshold reading; `unharnessed`
 * says whether unharnessed claude steps (no `harness`, effective agent claude, no own-subscription
 * env) are in the group too, so their waiting jobs must also be gated. A non-claude run, or one on
 * its own credentials/base-URL, closes at most itself (a named harness's group of one), or nothing
 * (an unharnessed non-shared step). Pure.
 * @param {Pick<import('../types/config.js').Config, 'agent'|'harnesses'>} cfg
 * @param {string|null|undefined} harnessName
 * @param {Pick<import('../types/pipeline.js').Step, 'agent'|'env'>|null|undefined} step
 * @returns {{harnesses: string[], unharnessed: boolean}}
 */
export function quotaGroupOf(cfg, harnessName, step) {
  if (harnessName) {
    const h = cfg.harnesses?.[harnessName];
    if ((h?.agent ?? cfg.agent ?? "claude") !== "claude") return { harnesses: [], unharnessed: false };
    if (ownSubscription(h?.env)) return { harnesses: [harnessName], unharnessed: false };
    return { harnesses: sharedQuotaHarnesses(cfg), unharnessed: true };
  }
  if ((step?.agent ?? cfg.agent ?? "claude") !== "claude" || ownSubscription(step?.env)) return { harnesses: [], unharnessed: false };
  return { harnesses: sharedQuotaHarnesses(cfg), unharnessed: true };
}

/** Breaker defaults (`harnesses.<name>.cooldownMinutes` / `.downGraceSeconds`) and the backoff ceiling. */
export const DEFAULT_COOLDOWN_MINUTES = 10;
export const DEFAULT_DOWN_GRACE_SECONDS = 30;
export const MAX_COOLDOWN_MINUTES = 60;

/** Clip a reason string to a bounded length, so a trip reason never bloats a log/event. @param {string} s @param {number} [n] */
const clip = (s, n = 200) => (s.length > n ? s.slice(0, n) : s);

/** A line's connection-level model-API failure tokens — never matched on a line whose `API
 * Error:` status is 4xx (checked separately, first). */
const API_FAILURE_RE = /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT|ECONNRESET|agenthook egress: (?:upstream )?\S+ failed:|agenthook egress: cannot resolve/;

/**
 * The first line of `text` that reports a connection-level model-API failure (clipped to ~200
 * chars), or undefined. A line matches on `ECONNREFUSED`/`ENOTFOUND`/`EHOSTUNREACH`/`ETIMEDOUT`/
 * `ECONNRESET`, either the egress proxy's `egress: … failed` form (the plain-HTTP and CONNECT proxy
 * texts), the egress proxy's `egress: cannot resolve` (a DNS failure), or `API Error: 502|503|504`. A
 * line whose `API Error:` status is 4xx never matches, even if it also contains one of those
 * tokens — a 4xx (or any other client error) is the model API answering, not a connection
 * failure. Pure.
 * @param {string|undefined} text @returns {string|undefined}
 */
export function modelApiFailure(text) {
  if (!text) return undefined;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const apiError = /API Error: (\d{3})/.exec(line);
    if (apiError && apiError[1][0] === "4") continue;
    if (API_FAILURE_RE.test(line) || (apiError && ["502", "503", "504"].includes(apiError[1]))) return clip(line);
  }
  return undefined;
}

/** `baseUrl`'s host:port, normalized like the egress proxy compares hosts (lower-case, no IPv6
 * brackets; port defaulted from the scheme). Undefined on a missing/unparseable URL.
 * @param {string|undefined} baseUrl @returns {{host: string, port: number}|undefined} */
function baseUrlHostPort(baseUrl) {
  if (!baseUrl) return undefined;
  try {
    const u = new URL(baseUrl);
    return { host: u.hostname.toLowerCase().replace(/^\[|\]$/g, ""), port: u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80 };
  } catch {
    return undefined;
  }
}

/** The `upstreamFailures` entry whose host:port matches `baseUrl`'s, or undefined.
 * @param {{host: string, port: number, error: string}[]|undefined} upstreamFailures @param {string|undefined} baseUrl */
function matchingUpstreamFailure(upstreamFailures, baseUrl) {
  const target = baseUrlHostPort(baseUrl);
  if (!target || !upstreamFailures?.length) return undefined;
  return upstreamFailures.find((f) => f.host.toLowerCase().replace(/^\[|\]$/g, "") === target.host && f.port === target.port);
}

/**
 * Whether a finished run on a harness says its backend is unhealthy (the breaker's trip signal),
 * and why; undefined when it doesn't. Trips on the ssh executor's `unreachable` marker (#828) —
 * returned verbatim, no prefix —, an `agent.preflight` refusal, a spawn error, a fast non-zero
 * exit (inside `downGraceSeconds`, not a timeout or cancel) with no model output, or — with no
 * output, non-zero, not a timeout or cancel, at ANY wall time — a connection-level model-API
 * failure: a sandbox's `upstreamFailures` entry for the run's `baseUrl` host:port (preferred),
 * else a scanned `apiDown` line. A classified ssh auth/host-key config failure
 * (`sshConfigFailure`, #828) is the worker being misconfigured, not down: it never trips, even
 * when the exit looks exactly like the fast-exit trip. Any other refusal (policy, sandbox,
 * credentials) and a run that produced output never trip. A cancelled run never trips the
 * exit/API branches, but the marker signals (unreachable, preflight, spawnError) still report
 * it — the caller then marks the harness down without a requeue, as before #828.
 * `errorLine` (#688), when present, is appended to the fast-exit reason — the agent's own last
 * error line (e.g. an auth failure), not just the receiver's own "no output" observation; the
 * other branches already carry a specific reason and ignore it.
 * @param {{unreachable?: string, sshConfigFailure?: string, preflight?: string, spawnError?: string, code: number, timedOut?: string, cancelled: boolean, noOutput?: boolean, wallMs: number, downGraceSeconds?: number, apiDown?: string, upstreamFailures?: {host: string, port: number, error: string}[], baseUrl?: string, errorLine?: string}} r
 * @returns {string|undefined}
 */
export function healthTrip(r) {
  if (r.unreachable) return r.unreachable;
  if (r.sshConfigFailure) return undefined;
  if (r.preflight) return r.preflight;
  if (r.spawnError) return `spawn failed: ${r.spawnError}`;
  const grace = (r.downGraceSeconds ?? DEFAULT_DOWN_GRACE_SECONDS) * 1000;
  if (r.code !== 0 && !r.timedOut && !r.cancelled && r.noOutput) {
    if (r.wallMs < grace) {
      const base = `exited ${r.code} with no output after ${Math.round(r.wallMs / 1000)}s`;
      return r.errorLine ? clip(`${base}: ${r.errorLine}`, 300) : base;
    }
    const upstream = matchingUpstreamFailure(r.upstreamFailures, r.baseUrl);
    if (upstream) return `model API unreachable: ${clip(`${upstream.host}:${upstream.port} ${upstream.error}`)}`;
    if (r.apiDown) return `model API unreachable: ${clip(r.apiDown)}`;
  }
  return undefined;
}

/**
 * The cooldown a trip opens: `cooldownMinutes` on the first strike, doubled per strike after
 * that, never past MAX_COOLDOWN_MINUTES. Pure. @param {number} cooldownMinutes @param {number} strikes
 */
export function cooldownFor(cooldownMinutes, strikes) {
  return Math.min(cooldownMinutes * 2 ** (strikes - 1), MAX_COOLDOWN_MINUTES);
}
