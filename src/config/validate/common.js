// Shared validation primitives: name/id regexes and checks, the env-var-name checks, the knob
// format checks a pipeline step and a harness entry share, and the `any`-typed raw-node alias
// used across validate/*.
import { AGENT_NAMES } from "../../agents/names.js";

/** @typedef {any} RawNode */

export const NAME_ERROR = `config: "name" is required and must match [A-Za-z0-9._-]+ (it keys the state dir).`;

/** `branchPrefix` shape: non-empty slash-separated components, ending in "/" (the finer-grained
 * ".."/leading-"."/trailing-".lock" checks run separately — a plain regex can't express them). */
export const BRANCH_PREFIX_RE = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*\/$/;

/** @param {any} name */
export function validName(name) {
  return !!name && typeof name === "string" && /^[A-Za-z0-9._-]+$/.test(name);
}

export const STATE_ID_ERROR = `config: "stateId" must match [A-Za-z0-9._-]+ (it keys the state dir; omit it to key by "name").`;

/** A step `env` key: a portable shell variable name. */
export const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
// An agentEnvPassthrough entry: a variable name, optionally a PREFIX* (src/agent-env.js).
export const ENV_PATTERN_RE = /^[A-Za-z_][A-Za-z0-9_]*\*?$/;

/**
 * `${v}` for a user-supplied value rendered into a message — but an object whose toString is
 * not callable (e.g. `{"toString":1}`) makes String() throw, so fall back to its JSON (a JSON
 * value always stringifies). Identical to `${v}` for every value that doesn't throw.
 * @param {any} v
 */
export function label(v) {
  try {
    return String(v);
  } catch {
    return JSON.stringify(v);
  }
}

/** @param {unknown} v @returns {boolean} */
export const isAgentName = (v) => typeof v === "string" && /** @type {readonly string[]} */ (AGENT_NAMES).includes(v);

/**
 * Format checks for the spawn knobs a pipeline step and a `harnesses` entry share. `where` names
 * the owner (`pipeline step "code"`, `harness "opus"`). Each returns its error, or null for a
 * valid value; callers skip an unset knob.
 * @type {Record<'agent'|'bin'|'provider'|'toolsets', (v: any, where: string) => string|null>}
 */
export const KNOB_ERRORS = {
  agent: (v, where) => (isAgentName(v) ? null : `config: ${where} agent ${JSON.stringify(v)} is not a known agent (${AGENT_NAMES.join(", ")}).`),
  bin: (v, where) => (typeof v === "string" && v.trim() ? null : `config: ${where} bin must be a non-empty string (a name on PATH or an absolute path).`),
  provider: (v, where) => (typeof v === "string" && v.trim() ? null : `config: ${where} provider must be a non-empty string.`),
  toolsets: (v, where) =>
    Array.isArray(v) && v.length && v.every((/** @type {unknown} */ t) => typeof t === "string" && t.trim()) ? null : `config: ${where} toolsets must be a non-empty array of non-empty strings.`,
};

/** Errors in a step's or harness's `env` (see KNOB_ERRORS for `where`). @param {any} env @param {string} where @returns {string[]} */
export function envErrors(env, where) {
  if (typeof env !== "object" || Array.isArray(env)) return [`config: ${where} env must be an object of NAME: "value" strings.`];
  /** @type {string[]} */
  const errors = [];
  for (const [k, v] of Object.entries(env)) {
    if (!ENV_KEY_RE.test(k)) errors.push(`config: ${where} env key ${JSON.stringify(k)} is not a valid variable name.`);
    else if (k === "AGENTHOOK_VERDICT_FILE") errors.push(`config: ${where} env key AGENTHOOK_VERDICT_FILE is reserved (the receiver sets it).`);
    if (typeof v !== "string") errors.push(`config: ${where} env.${k} must be a string.`);
  }
  return errors;
}
