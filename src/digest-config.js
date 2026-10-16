// Import-free validation for the optional `digest` config block (kept apart from src/digest.js,
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
