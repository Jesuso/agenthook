// Import-free rules for the optional `sinks` config block (like src/digest-config.js): config.js
// validates with them, src/sinks.js reads the default events, and the browser bundles all three.

/** The required keys per sink type; the keys of this record are the valid types. */
export const SINK_REQUIRED = /** @type {Record<string, string[]>} */ ({ slack: ["url"], webhook: ["url"], telegram: ["botToken", "chatId"] });
export const SINK_TYPES = Object.keys(SINK_REQUIRED);

/** What a sink forwards when it sets no `events`. */
export const DEFAULT_SINK_EVENTS = ["blocked", "failed", "move_refused", "pipeline_done"];

/** Config validation for the optional `sinks` array. @param {any} sinks @returns {string[]} */
export function sinkErrors(sinks) {
  if (sinks == null) return [];
  if (!Array.isArray(sinks)) return [`config: sinks must be an array.`];
  /** @type {string[]} */
  const errors = [];
  sinks.forEach((s, i) => {
    if (!s || typeof s.type !== "string" || !Object.hasOwn(SINK_REQUIRED, s.type)) {
      return void errors.push(`config: sinks[${i}].type must be one of slack, telegram, webhook (got ${JSON.stringify(s?.type)}).`);
    }
    for (const f of SINK_REQUIRED[s.type]) {
      if (s[f] == null || s[f] === "") errors.push(`config: sinks[${i}] (${s.type}) requires "${f}".`);
    }
    if (s.events != null && (!Array.isArray(s.events) || s.events.some((/** @type {any} */ e) => typeof e !== "string"))) {
      errors.push(`config: sinks[${i}].events must be an array of strings.`);
    }
  });
  return errors;
}
