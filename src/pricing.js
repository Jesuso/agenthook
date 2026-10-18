// Estimated, API-equivalent spend for runs whose agent reports no real dollars (epic #393).
// `costUsd` keeps meaning "reported by the agent"; an estimate sits beside it as `estUsd` with a
// `costBasis`, and the two are never summed into one number. An unknown model gets no estimate —
// never a guess. Import-free on purpose: src/config.js validates with it, the CLI and the
// `ah ui` readers price with it, and the browser may bundle it (like src/identity.js).

/** The date DEFAULT_RATES were last checked against Anthropic's published API pricing. */
export const PRICING_VERSION = "2026-10-06";

/** $/Mtok. `cacheRead`/`cacheWrite` default to 0.1× / 1.25× `input` when a rate omits them.
 * @typedef {{ input: number, output: number, cacheRead?: number, cacheWrite?: number }} Rate */

/** @param {number} input @param {number} output @param {number} cacheRead @returns {Rate} */
const claude = (input, output, cacheRead) => ({ input, output, cacheRead, cacheWrite: input * 1.25 });

/**
 * Anthropic first-party API rates (5-minute cache writes; Haiku 5.5 at its ≤100K-prompt tier),
 * as of PRICING_VERSION. The Claude family only: other models opt in via the `pricing` config.
 * @type {Readonly<Record<string, Rate>>}
 */
export const DEFAULT_RATES = Object.freeze({
  "claude-fable-5-1*": claude(10, 50, 0.25),
  "claude-mythos-5-1*": claude(10, 50, 0.25),
  "claude-fable-5*": claude(10, 50, 1),
  "claude-mythos-5*": claude(10, 50, 1),
  "claude-opus-5-5*": claude(4, 20, 0.2),
  "claude-opus-5*": claude(5, 25, 0.5),
  "claude-opus-4-8*": claude(5, 25, 0.5),
  "claude-opus-4-7*": claude(5, 25, 0.5),
  "claude-opus-4-6*": claude(5, 25, 0.5),
  "claude-sonnet-5-5*": claude(2, 10, 0.2),
  "claude-sonnet-5*": claude(2, 10, 0.2),
  "claude-sonnet-4-6*": claude(3, 15, 0.3),
  "claude-haiku-5-5*": claude(0.1, 0.5, 0.01),
  "claude-haiku-4-5*": claude(1, 5, 0.1),
});

const RATE_KEYS = ["input", "output", "cacheRead", "cacheWrite"];

/** @param {string} pattern @param {string} s — case-insensitive; `*` is the only wildcard */
function globMatch(pattern, s) {
  const re = pattern.toLowerCase().replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${re}$`).test(s);
}

/** The best rate in one table for one candidate model string: exact key beats glob, longer glob beats shorter.
 * @param {Record<string, Rate>} table @param {string} s @returns {Rate|null} */
function lookup(table, s) {
  let best = null;
  let bestLen = -1;
  for (const [k, rate] of Object.entries(table)) {
    const key = k.toLowerCase();
    if (!key.includes("*")) {
      if (key === s) return rate;
    } else if (key.length > bestLen && globMatch(key, s)) {
      best = rate;
      bestLen = key.length;
    }
  }
  return best;
}

/**
 * The rate for `model`: `overrides` (the profile's `pricing` config) before DEFAULT_RATES, the
 * full model string before the part after its last `/` (OpenCode's `provider/model`). Null when
 * nothing matches or there is no model.
 * @param {string|undefined|null} model @param {Record<string, Rate>|null} [overrides] @returns {Rate|null}
 */
export function matchRate(model, overrides) {
  if (typeof model !== "string" || !model.trim()) return null;
  const full = model.trim().toLowerCase();
  const tail = full.includes("/") ? full.slice(full.lastIndexOf("/") + 1) : null;
  const tables = [isRecord(overrides) ? /** @type {Record<string, Rate>} */ (overrides) : null, DEFAULT_RATES];
  for (const table of tables) {
    if (!table) continue;
    for (const s of tail ? [full, tail] : [full]) {
      const r = lookup(table, s);
      if (r) return r;
    }
  }
  return null;
}

/** @param {unknown} v */
const isRecord = (v) => !!v && typeof v === "object" && !Array.isArray(v);
/** @param {unknown} v */
const num = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

/**
 * A rate-table estimate for one run's tokens. Null when the model has no rate **or** the run
 * has zero tokens (a run that reported none — e.g. Hermes — is "no estimate", not $0).
 * @param {{ model?: string|null, input?: number, output?: number, cacheRead?: number, cacheCreate?: number }} rec
 * @param {Record<string, Rate>|null} [overrides]
 * @returns {{ estUsd: number, basis: "rate-table" }|null}
 */
export function estimate(rec, overrides) {
  const input = num(rec?.input), output = num(rec?.output), cacheRead = num(rec?.cacheRead), cacheCreate = num(rec?.cacheCreate);
  if (input + output + cacheRead + cacheCreate === 0) return null;
  const rate = matchRate(rec?.model, overrides);
  if (!rate) return null;
  const cr = typeof rate.cacheRead === "number" ? rate.cacheRead : rate.input * 0.1;
  const cw = typeof rate.cacheWrite === "number" ? rate.cacheWrite : rate.input * 1.25;
  const estUsd = (input * rate.input + output * rate.output + cacheRead * cr + cacheCreate * cw) / 1e6;
  return { estUsd: Math.round(estUsd * 1e6) / 1e6, basis: "rate-table" };
}

/**
 * The one basis rule every reader uses. A priced run's reported `costUsd` stands alone
 * (`costBasis:"reported"`, no estimate); otherwise a stored finite `estUsd` is used as-is
 * (history is never re-priced once stamped); otherwise the rate table; otherwise `{}` —
 * the run counts toward "no estimate". An `unpriced` run's raw `costUsd` is never "reported".
 * @param {{ costUsd?: unknown, estUsd?: unknown, costBasis?: unknown, unpriced?: unknown, model?: string|null, input?: number, output?: number, cacheRead?: number, cacheCreate?: number }} rec
 * @param {Record<string, Rate>|null} [overrides]
 * @returns {{ costUsd?: number, estUsd?: number, costBasis?: "reported"|"rate-table" }}
 */
export function costOf(rec, overrides) {
  if (!rec) return {};
  if (!rec.unpriced && typeof rec.costUsd === "number" && Number.isFinite(rec.costUsd)) return { costUsd: rec.costUsd, costBasis: "reported" };
  if (typeof rec.estUsd === "number" && Number.isFinite(rec.estUsd)) return { estUsd: rec.estUsd, costBasis: "rate-table" };
  const e = estimate(rec, overrides);
  return e ? { estUsd: e.estUsd, costBasis: e.basis } : {};
}

/**
 * Reported and estimated spend over many records, kept apart. `unestimated` counts the
 * records with neither.
 * @param {Parameters<typeof costOf>[0][]} recs @param {Record<string, Rate>|null} [overrides]
 * @returns {{ reported: number, est: number, unestimated: number }}
 */
export function sumCosts(recs, overrides) {
  let reported = 0, est = 0, unestimated = 0;
  for (const r of recs) {
    const c = costOf(r, overrides);
    if (c.costUsd !== undefined) reported += c.costUsd;
    else if (c.estUsd !== undefined) est += c.estUsd;
    else unestimated++;
  }
  return { reported, est, unestimated };
}

/** @param {number} usd */
const dollars = (usd) => `$${usd.toFixed(2)}`;

/**
 * `"$12.40 + ~$3.10 est."`, `"~$3.10 est."` when nothing was reported, `"$12.40"` when
 * nothing was estimated, `""` when neither. Callers append `(N runs no estimate)` where there's room.
 * @param {{ reported?: number, est?: number }} s
 */
export function formatSpend({ reported = 0, est = 0 }) {
  const r = reported > 0 ? dollars(reported) : "";
  const e = est > 0 ? `~${dollars(est)} est.` : "";
  return r && e ? `${r} + ${e}` : r || e;
}

/**
 * Validation for the `pricing` config block: an object of `pattern → {input, output,
 * cacheRead?, cacheWrite?}`, each a finite number ≥ 0, `input`/`output` required. Pure.
 * @param {unknown} pricing @returns {string[]}
 */
export function pricingErrors(pricing) {
  if (pricing === undefined || pricing === null) return [];
  if (!isRecord(pricing)) return [`config: "pricing" must be an object of model pattern → {input, output, cacheRead?, cacheWrite?} ($/Mtok).`];
  /** @type {string[]} */
  const errors = [];
  for (const [pattern, rate] of Object.entries(/** @type {Record<string, unknown>} */ (pricing))) {
    const at = `config: pricing["${pattern}"]`;
    if (!pattern.trim()) {
      errors.push(`config: a "pricing" key must be a non-empty model name or glob.`);
      continue;
    }
    if (!isRecord(rate)) {
      errors.push(`${at} must be an object {input, output, cacheRead?, cacheWrite?} ($/Mtok).`);
      continue;
    }
    const r = /** @type {Record<string, unknown>} */ (rate);
    for (const k of Object.keys(r)) {
      if (!RATE_KEYS.includes(k)) errors.push(`${at} has unknown key "${k}" (allowed: ${RATE_KEYS.join(", ")}).`);
    }
    for (const k of RATE_KEYS) {
      const v = r[k];
      if (v === undefined) {
        if (k === "input" || k === "output") errors.push(`${at}.${k} is required ($/Mtok).`);
      } else if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
        errors.push(`${at}.${k} must be a finite number ≥ 0 ($/Mtok).`);
      }
    }
  }
  return errors;
}

/**
 * A heartbeat's `pricing` overrides when well-formed, else null — readers that never load a
 * config (`ah ls`, `ah ui`) take the rates from there, and a foreign value prices nothing.
 * @param {any} heartbeat @returns {Record<string, Rate>|null}
 */
export function pricingOf(heartbeat) {
  const p = isRecord(heartbeat) ? heartbeat.pricing : null;
  return isRecord(p) && !pricingErrors(p).length ? p : null;
}
