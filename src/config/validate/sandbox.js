// Structural checks for the profile's `sandbox` block, its `services` catalog, and `egress`
// (shared by `sandbox.egress` and a step's own `egress`).
import { SANDBOX_NAMES, EGRESS_MODES, EGRESS_PROXY_ENV_KEYS } from "../../sandbox/names.js";
import { egressEntryProblem } from "../../sandbox/egress.js";
import { ENV_KEY_RE } from "./common.js";

/**
 * Structural errors in the optional `sandbox` block (src/sandbox/). Pure.
 * @param {any} sb @returns {string[]}
 */
export function sandboxErrors(sb) {
  if (sb == null) return [];
  if (typeof sb !== "object" || Array.isArray(sb)) return [`config: "sandbox" must be an object ({ "type": "docker" | "podman", … }).`];
  /** @type {string[]} */
  const errors = [];
  if (sb.type == null || sb.type === "") errors.push(`config: "sandbox.type" is required when a sandbox block is set (${SANDBOX_NAMES.join(" or ")}).`);
  else if (!(/** @type {readonly unknown[]} */ (SANDBOX_NAMES).includes(sb.type))) errors.push(`config: "sandbox.type" ${JSON.stringify(sb.type)} is not a known sandbox (${SANDBOX_NAMES.join(", ")}).`);
  if (sb.image != null && (typeof sb.image !== "string" || !sb.image.trim())) errors.push(`config: "sandbox.image" must be a non-empty string.`);
  if (sb.memory != null && (typeof sb.memory !== "string" || !/^\d+[kmg]?$/i.test(sb.memory))) errors.push(`config: "sandbox.memory" must be a size like "4g", "512m" or bytes.`);
  if (sb.cpus != null && (typeof sb.cpus !== "number" || !Number.isFinite(sb.cpus) || sb.cpus <= 0)) errors.push(`config: "sandbox.cpus" must be a number > 0.`);
  if (sb.egress != null) errors.push(...egressErrors(sb.egress, `"sandbox.egress"`));
  if (sb.services != null) {
    if (typeof sb.services !== "object" || Array.isArray(sb.services)) errors.push(`config: "sandbox.services" must be an object of name: { "image", … }.`);
    else for (const [name, svc] of Object.entries(sb.services)) errors.push(...serviceErrors(name, svc));
  }
  return errors;
}

/** A Service name: a DNS label, the hostname the agent reaches it at. */
export const SERVICE_NAME_RE = /^[a-z][a-z0-9-]{0,30}$/;

/** Service env names the runtime CLI itself reads: service env values pass by name through the
 * client's own env, so these would redirect or reconfigure the docker/podman call. */
export const RUNTIME_CLIENT_ENV_RE = /^(PATH|HOME|TMPDIR|SHELL|(DOCKER|CONTAINER|CONTAINERS|PODMAN|XDG|LD|DYLD)_.*)$/;

/** The most services one step may use. */
export const MAX_STEP_SERVICES = 8;

/**
 * Why an image reference doesn't pin a version (a bare name or `:latest`), or undefined. A
 * registry port (`host:5000/img`) is not a tag. Pure. @param {string} ref @returns {string|undefined}
 */
export function unpinnedImage(ref) {
  if (/@[a-z0-9]+:[A-Fa-f0-9]+$/.test(ref)) return undefined;
  const last = ref.slice(ref.lastIndexOf("/") + 1);
  const i = last.lastIndexOf(":");
  if (i < 0 || i === last.length - 1) return "has no tag";
  if (last.slice(i + 1) === "latest") return "is :latest";
  return undefined;
}

/**
 * Structural errors in one `sandbox.services.<name>` entry (src/sandbox/container.js). Pure.
 * @param {string} name @param {any} svc @returns {string[]}
 */
export function serviceErrors(name, svc) {
  const at = `"sandbox.services.${name}"`;
  /** @type {string[]} */
  const errors = [];
  if (!SERVICE_NAME_RE.test(name)) errors.push(`config: sandbox service name ${JSON.stringify(name)} must be a DNS label (a-z, 0-9, -; starts with a letter; at most 31 chars).`);
  else if (name === "proxy") errors.push(`config: sandbox service name "proxy" is reserved (the egress proxy).`);
  if (typeof svc !== "object" || svc === null || Array.isArray(svc)) return [...errors, `config: ${at} must be an object ({ "image", … }).`];
  if (typeof svc.image !== "string" || !svc.image.trim()) errors.push(`config: ${at} image is required (a non-empty string with an explicit tag or digest).`);
  else {
    const why = unpinnedImage(svc.image);
    if (why) errors.push(`config: ${at} image ${JSON.stringify(svc.image)} ${why} — pin a tag or digest (e.g. "postgres:16.4"); service images are never pulled.`);
  }
  for (const key of ["env", "agentEnv"]) {
    const env = svc[key];
    if (env == null) continue;
    if (typeof env !== "object" || Array.isArray(env)) {
      errors.push(`config: ${at} ${key} must be an object of NAME: "value" strings.`);
      continue;
    }
    for (const [k, v] of Object.entries(env)) {
      if (!ENV_KEY_RE.test(k)) errors.push(`config: ${at} ${key} key ${JSON.stringify(k)} is not a valid variable name.`);
      else if (key === "agentEnv" && k === "AGENTHOOK_VERDICT_FILE") errors.push(`config: ${at} agentEnv key AGENTHOOK_VERDICT_FILE is reserved (the receiver sets it).`);
      else if (key === "agentEnv" && /** @type {readonly string[]} */ (EGRESS_PROXY_ENV_KEYS).includes(k)) errors.push(`config: ${at} agentEnv key ${k} is reserved (the sandbox's egress proxy sets it).`);
      else if (key === "env" && RUNTIME_CLIENT_ENV_RE.test(k)) errors.push(`config: ${at} env key ${k} is reserved: service env reaches the docker/podman client that starts the service, and ${k} would reconfigure it.`);
      if (typeof v !== "string") errors.push(`config: ${at} ${key}.${k} must be a literal string.`);
    }
  }
  if (svc.wait != null) {
    const w = svc.wait;
    if (typeof w !== "object" || Array.isArray(w)) errors.push(`config: ${at} wait must be an object ({ "cmd": [...], "timeoutS" }).`);
    else {
      if (!Array.isArray(w.cmd) || !w.cmd.length || w.cmd.some((/** @type {unknown} */ c) => typeof c !== "string")) errors.push(`config: ${at} wait.cmd must be a non-empty array of strings (an argv).`);
      if (w.timeoutS != null && (typeof w.timeoutS !== "number" || !Number.isFinite(w.timeoutS) || w.timeoutS <= 0)) errors.push(`config: ${at} wait.timeoutS must be a number > 0.`);
    }
  }
  if (svc.memory != null && (typeof svc.memory !== "string" || !/^\d+[kmg]?$/i.test(svc.memory))) errors.push(`config: ${at} memory must be a size like "1g", "512m" or bytes.`);
  if (svc.cpus != null && (typeof svc.cpus !== "number" || !Number.isFinite(svc.cpus) || svc.cpus <= 0)) errors.push(`config: ${at} cpus must be a number > 0.`);
  return errors;
}

/**
 * Structural errors in an `egress` block (`sandbox.egress` or a step's): the mode, and every
 * `allow`/`deny` entry a valid rule or a known `@preset`. Pure.
 * @param {any} eg @param {string} at  e.g. `"sandbox.egress"` or `pipeline step "code" egress`
 * @returns {string[]}
 */
export function egressErrors(eg, at) {
  if (typeof eg !== "object" || Array.isArray(eg) || eg === null) return [`config: ${at} must be an object ({ "mode", "allow", "deny" }).`];
  /** @type {string[]} */
  const errors = [];
  if (eg.mode != null && !(/** @type {readonly unknown[]} */ (EGRESS_MODES).includes(eg.mode))) errors.push(`config: ${at} mode ${JSON.stringify(eg.mode)} must be one of ${EGRESS_MODES.join(", ")}.`);
  for (const key of ["allow", "deny"]) {
    const list = eg[key];
    if (list == null) continue;
    if (!Array.isArray(list)) {
      errors.push(`config: ${at} ${key} must be a list of host rules or @presets.`);
      continue;
    }
    for (const entry of list) {
      const problem = egressEntryProblem(entry);
      if (problem) errors.push(`config: ${at} ${key} entry ${JSON.stringify(entry)}: ${problem}.`);
    }
  }
  return errors;
}
