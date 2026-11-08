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
