// Import-free validation for the optional `digest` and `summaries` config blocks (kept apart from src/digest.js,
// which reads state through src/ui/rows.js -> config.js; config.js needs only this).

export const DIGEST_ACCESS = ["snapshot"];

/** Config validation for the optional `digest` block. @param {any} d @returns {string[]} */
export function digestErrors(d) {
  if (d == null) return [];
  if (typeof d !== "object" || Array.isArray(d)) return [`config: "digest" must be an object.`];
  const errors = [];
  if (d.soul != null && (typeof d.soul !== "string" || !d.soul.trim())) errors.push(`config: digest.soul must be a file path string.`);
  if (d.access != null && !DIGEST_ACCESS.includes(d.access)) errors.push(`config: digest.access must be one of ${DIGEST_ACCESS.join(", ")} (got ${JSON.stringify(d.access)}).`);
  if (d.model != null && (typeof d.model !== "string" || !d.model.trim())) errors.push(`config: digest.model must be a model name string.`);
  if (d.maxBudgetUsd != null && !(typeof d.maxBudgetUsd === "number" && d.maxBudgetUsd > 0)) errors.push(`config: digest.maxBudgetUsd must be a number > 0.`);
  return errors;
}

/** The model and per-run budget for the cheap summaries (ticket summaries, and the Digest when `digest.*` is unset). */
export const SUMMARIES_MODEL = "claude-haiku-5-5";
export const SUMMARIES_BUDGET_USD = 0.1;

/** Config validation for the optional `summaries` block. @param {any} s @returns {string[]} */
export function summariesErrors(s) {
  if (s == null) return [];
  if (typeof s !== "object" || Array.isArray(s)) return [`config: "summaries" must be an object.`];
  const errors = [];
  if (s.model != null && (typeof s.model !== "string" || !s.model.trim())) errors.push(`config: summaries.model must be a model name string.`);
  if (s.maxBudgetUsd != null && !(typeof s.maxBudgetUsd === "number" && s.maxBudgetUsd > 0)) errors.push(`config: summaries.maxBudgetUsd must be a number > 0.`);
  return errors;
}

/**
 * A viewer's UI language as a canonical BCP-47 tag ("ES" → "es"), like config.js's `language`
 * check; throws a readable refusal on anything else.
 * @param {any} v @returns {string}
 */
export function canonicalLang(v) {
  const bad = new Error('lang must be a BCP-47 language tag (e.g. "es")');
  if (typeof v !== "string" || !v.trim()) throw bad;
  try {
    return Intl.getCanonicalLocales(v.trim())[0];
  } catch {
    throw bad;
  }
}
