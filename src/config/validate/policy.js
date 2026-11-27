// Structural checks for a step's `allow`/`deny` policy.

/**
 * Errors in a step's `allow` / `deny` policy (`at` = `config: pipeline step "<id>" allow`). Pure.
 * Entries become claude permission rules (`Bash(<cmd>)`, `Edit(//<cwd>/<path>)`), so `(` `)` `,`
 * and newlines are refused; paths must stay cwd-relative (no leading `/` or `~`, no drive
 * letter, no `..` segment).
 * @param {any} policy @param {string} at @returns {string[]}
 */
export function policyErrors(policy, at) {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) return [`${at} must be an object ({ "commands"?: [...], "paths"?: [...] }).`];
  const unknown = Object.keys(policy).filter((k) => k !== "commands" && k !== "paths");
  if (unknown.length) return [`${at} has unknown key(s) ${unknown.map((k) => JSON.stringify(k)).join(", ")} (only "commands" and "paths").`];
  if (policy.commands == null && policy.paths == null) return [`${at} must set "commands" or "paths".`];
  /** @type {string[]} */
  const errors = [];
  /** @param {unknown} v */
  const ruleSafe = (v) => typeof v === "string" && v !== "" && v.trim() === v && !/[\n\r(),]/.test(v);
  for (const key of /** @type {const} */ (["commands", "paths"])) {
    const list = policy[key];
    if (list == null) continue;
    if (!Array.isArray(list) || !list.length) {
      errors.push(`${at}.${key} must be a non-empty array of strings.`);
      continue;
    }
    for (const v of list) {
      if (!ruleSafe(v)) errors.push(`${at}.${key} entry ${JSON.stringify(v)} must be a non-empty trimmed string with no newline, "(", ")" or ",".`);
      else if (key === "paths" && (/^[/~]/.test(v) || /^[A-Za-z]:/.test(v) || v.split(/[/\\]/).includes(".."))) {
        errors.push(`${at}.paths entry ${JSON.stringify(v)} must be relative to the run's cwd (no leading "/" or "~", no drive letter, no ".." segment).`);
      }
    }
  }
  return errors;
}
