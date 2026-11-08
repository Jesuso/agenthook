// Named harnesses (`harnesses` in the profile): a step's `harness` list, and the effective step
// a run spawns with once the queue picked one. Pure — no I/O.

/** Spawn knobs a harness supplies where the step sets none of its own. */
const HARNESS_KNOBS = /** @type {const} */ (["agent", "model", "bin", "provider", "toolsets"]);

/**
 * The harness names a step routes through, in order (a string is a one-element list); [] when
 * the step names none.
 * @param {Pick<import('../types.js').Step, 'harness'>} step
 * @returns {string[]}
 */
export function harnessesOf(step) {
  const h = step.harness;
  return h == null ? [] : typeof h === "string" ? [h] : [...h];
}

/**
 * The step a run on `harnessName` spawns with: the step's inline agent/model/bin/provider/
 * toolsets, else the harness's, else unset (the profile and adapter defaults apply as without a
 * harness). `env` is the harness's under the step's. effort/escalate/lite stay the step's own.
 * A null or unknown name returns the step unchanged with `harness: null`.
 * @param {Pick<import('../types.js').Config, 'harnesses'>} cfg
 * @param {import('../types.js').Step} step
 * @param {string|null|undefined} harnessName
 * @returns {{step: import('../types.js').Step, harness: string|null, sandboxImage: string|undefined}}
 */
export function resolveHarness(cfg, step, harnessName) {
  const h = harnessName && cfg.harnesses && Object.hasOwn(cfg.harnesses, harnessName) ? cfg.harnesses[harnessName] : undefined;
  if (!harnessName || !h) return { step, harness: null, sandboxImage: undefined };
  /** @type {import('../types.js').Step} */
  const eff = { ...step };
  for (const k of HARNESS_KNOBS) {
    if (eff[k] == null && h[k] != null) Object.assign(eff, { [k]: h[k] });
  }
  const env = { ...h.env, ...step.env };
  if (Object.keys(env).length) eff.env = env;
  else delete eff.env;
  return { step: eff, harness: harnessName, sandboxImage: h.sandbox?.image };
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
 * and why; undefined when it doesn't. Trips on an `agent.preflight` refusal, a spawn error, a
 * fast non-zero exit (inside `downGraceSeconds`, not a timeout or cancel) with no model output,
 * or — with no output, non-zero, not a timeout or cancel, at ANY wall time — a connection-level
 * model-API failure: a sandbox's `upstreamFailures` entry for the run's `baseUrl` host:port
 * (preferred), else a scanned `apiDown` line. Any other refusal (policy, sandbox, credentials)
 * and a run that produced output never trip.
 * @param {{preflight?: string, spawnError?: string, code: number, timedOut?: string, cancelled: boolean, noOutput?: boolean, wallMs: number, downGraceSeconds?: number, apiDown?: string, upstreamFailures?: {host: string, port: number, error: string}[], baseUrl?: string}} r
 * @returns {string|undefined}
 */
export function healthTrip(r) {
  if (r.preflight) return r.preflight;
  if (r.spawnError) return `spawn failed: ${r.spawnError}`;
  const grace = (r.downGraceSeconds ?? DEFAULT_DOWN_GRACE_SECONDS) * 1000;
  if (r.code !== 0 && !r.timedOut && !r.cancelled && r.noOutput) {
    if (r.wallMs < grace) return `exited ${r.code} with no output after ${Math.round(r.wallMs / 1000)}s`;
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
