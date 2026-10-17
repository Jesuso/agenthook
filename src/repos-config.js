// Import-free validation for the optional `repos` config block (like src/sinks-config.js): config.js
// validates with it, the UI's Repos tab (ui/src/configEdit.ts) reuses it for inline card errors, and
// the browser bundles it.

/** Config validation for the optional `repos` array (the per-card checks; "repoPath required
 * unless repos is set" is a cross-field rule and stays in src/config.js). @param {any} repos @returns {string[]} */
export function reposErrors(repos) {
  if (repos == null) return [];
  if (!Array.isArray(repos) || !repos.length) return [`config: "repos" must be a non-empty array.`];
  /** @type {string[]} */
  const errors = [];
  const ids = new Set();
  /** @type {Map<string, string>} route key → repo id */
  const keys = new Map();
  /** @type {string[]} */
  const defaults = [];
  repos.forEach((/** @type {any} */ r, /** @type {number} */ i) => {
    if (!r || typeof r !== "object") return void errors.push(`config: repos[${i}] must be an object.`);
    if (typeof r.id !== "string" || !/^[A-Za-z0-9._-]+$/.test(r.id)) {
      // Later messages name the repo by id; without a usable one, stop at this repo.
      return void errors.push(`config: repos[${i}].id is required and must match [A-Za-z0-9._-]+ (got ${JSON.stringify(r.id)}).`);
    }
    if (ids.has(r.id)) errors.push(`config: duplicate repos id "${r.id}".`);
    ids.add(r.id);
    if (typeof r.path !== "string" || !r.path) errors.push(`config: repos "${r.id}" requires a "path".`);
    if (r.match != null && !Array.isArray(r.match)) {
      errors.push(`config: repos "${r.id}".match must be an array of strings.`);
    } else {
      for (const m of r.match ?? []) {
        if (typeof m !== "string" || !m.trim()) {
          errors.push(`config: repos "${r.id}".match entries must be non-empty strings (got ${JSON.stringify(m)}).`);
          continue;
        }
        const k = m.trim().toLowerCase();
        if (keys.has(k) && keys.get(k) !== r.id) errors.push(`config: route key "${k}" is claimed by both repos "${keys.get(k)}" and "${r.id}".`);
        else keys.set(k, r.id);
      }
    }
    if (r.default != null && typeof r.default !== "boolean") errors.push(`config: repos "${r.id}".default must be a boolean.`);
    if (r.instructionsFile != null && typeof r.instructionsFile !== "string") errors.push(`config: repos "${r.id}".instructionsFile must be a string.`);
    if (r.worktreePrefix != null && typeof r.worktreePrefix !== "string") errors.push(`config: repos "${r.id}".worktreePrefix must be a string.`);
    if (r.default === true) defaults.push(r.id);
  });
  if (defaults.length > 1) errors.push(`config: at most one repo may set default:true (found ${defaults.map((id) => `"${id}"`).join(", ")}).`);
  return errors;
}
