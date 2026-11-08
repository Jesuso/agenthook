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

/**
 * Whether a finished run on a harness says its backend is unhealthy (the breaker's trip signal),
 * and why; undefined when it doesn't. Trips on an `agent.preflight` refusal, a spawn error, or a
 * fast non-zero exit (inside `downGraceSeconds`, not a timeout or cancel) with no model output.
 * Any other refusal (policy, sandbox, credentials) and a run that produced output never trip.
 * @param {{preflight?: string, spawnError?: string, code: number, timedOut?: string, cancelled: boolean, noOutput?: boolean, wallMs: number, downGraceSeconds?: number}} r
 * @returns {string|undefined}
 */
export function healthTrip(r) {
  if (r.preflight) return r.preflight;
  if (r.spawnError) return `spawn failed: ${r.spawnError}`;
  const grace = (r.downGraceSeconds ?? DEFAULT_DOWN_GRACE_SECONDS) * 1000;
  if (r.code !== 0 && !r.timedOut && !r.cancelled && r.noOutput && r.wallMs < grace) return `exited ${r.code} with no output after ${Math.round(r.wallMs / 1000)}s`;
  return undefined;
}

/**
 * The cooldown a trip opens: `cooldownMinutes` on the first strike, doubled per strike after
 * that, never past MAX_COOLDOWN_MINUTES. Pure. @param {number} cooldownMinutes @param {number} strikes
 */
export function cooldownFor(cooldownMinutes, strikes) {
  return Math.min(cooldownMinutes * 2 ** (strikes - 1), MAX_COOLDOWN_MINUTES);
}
