// Structural checks for the `harnesses` record and the remote-harness (#689, experimental)
// refusals a step's resolved harnesses must pass.
import { DEFAULT_AGENT, REMOTE_AGENTS } from "../../agents/names.js";
import { isSandboxed } from "../../sandbox/names.js";
import { harnessesOf } from "../../dispatch/harness.js";
import { KNOB_ERRORS, envErrors } from "./common.js";

/**
 * Structural errors in the optional `harnesses` record (named agent backends). Pure.
 * @param {any} hs @returns {string[]}
 */
export function harnessesErrors(hs) {
  if (hs == null) return [];
  if (typeof hs !== "object" || Array.isArray(hs)) return [`config: "harnesses" must be an object of name: { agent?, model?, effort?, bin?, env?, provider?, toolsets?, maxConcurrent?, sandbox?, cooldownMinutes?, downGraceSeconds?, opencodeConfig?, piConfigDir?, contextTokens?, reserve? }.`];
  /** @type {string[]} */
  const errors = [];
  for (const [name, h] of Object.entries(hs)) {
    const where = `harness ${JSON.stringify(name)}`;
    if (!h || typeof h !== "object" || Array.isArray(h)) {
      errors.push(`config: ${where} must be an object.`);
      continue;
    }
    for (const k of /** @type {const} */ (["agent", "bin", "provider", "toolsets"])) {
      const e = h[k] != null ? KNOB_ERRORS[k](h[k], where) : null;
      if (e) errors.push(e);
    }
    if (h.model != null && (typeof h.model !== "string" || !h.model.trim())) errors.push(`config: ${where} model must be a non-empty string.`);
    if (h.effort != null && (typeof h.effort !== "string" || !h.effort.trim())) errors.push(`config: ${where} effort must be a non-empty string.`);
    if (h.opencodeConfig != null && (typeof h.opencodeConfig !== "string" || !h.opencodeConfig.trim())) errors.push(`config: ${where} opencodeConfig must be a non-empty string.`);
    if (h.piConfigDir != null && (typeof h.piConfigDir !== "string" || !h.piConfigDir.trim())) errors.push(`config: ${where} piConfigDir must be a non-empty string.`);
    if (h.env != null) errors.push(...envErrors(h.env, where));
    if (h.maxConcurrent != null && (!Number.isInteger(h.maxConcurrent) || h.maxConcurrent < 1)) errors.push(`config: ${where} maxConcurrent must be a positive integer.`);
    if (h.cooldownMinutes != null && (!Number.isInteger(h.cooldownMinutes) || h.cooldownMinutes < 1 || h.cooldownMinutes > 60)) errors.push(`config: ${where} cooldownMinutes must be an integer 1-60.`);
    if (h.downGraceSeconds != null && (!Number.isInteger(h.downGraceSeconds) || h.downGraceSeconds < 1)) errors.push(`config: ${where} downGraceSeconds must be a positive integer.`);
    if (h.contextTokens != null && (!Number.isInteger(h.contextTokens) || h.contextTokens < 1)) errors.push(`config: ${where} contextTokens must be a positive integer.`);
    if (h.reserve != null && (!Number.isInteger(h.reserve) || h.reserve < 0)) errors.push(`config: ${where} reserve must be an integer >= 0.`);
    if (h.sandbox != null) {
      if (typeof h.sandbox !== "object" || Array.isArray(h.sandbox)) errors.push(`config: ${where} sandbox must be an object ({ "image": "…" }).`);
      else if (h.sandbox.image != null && (typeof h.sandbox.image !== "string" || !h.sandbox.image.trim())) errors.push(`config: ${where} sandbox.image must be a non-empty string.`);
    }
    // Remote harness (#689, experimental): this harness's runs go over ssh to a worker instead
    // of the host/sandbox. Code transport is a later ticket — workDir is an existing dir on the
    // worker, not something agenthook creates.
    if (h.remote != null) {
      if (typeof h.remote !== "object" || Array.isArray(h.remote)) {
        errors.push(`config: ${where} remote must be an object ({ host, workDir, … }).`);
      } else {
        const r = h.remote;
        if (typeof r.host !== "string" || !r.host.trim()) errors.push(`config: ${where} remote.host is required and must be a non-empty string.`);
        if (typeof r.workDir !== "string" || !r.workDir.trim() || !r.workDir.startsWith("/")) errors.push(`config: ${where} remote.workDir is required and must be an absolute path on the worker.`);
        if (r.user != null && (typeof r.user !== "string" || !r.user.trim())) errors.push(`config: ${where} remote.user must be a non-empty string.`);
        if (r.port != null && (!Number.isInteger(r.port) || r.port < 1 || r.port > 65535)) errors.push(`config: ${where} remote.port must be an integer 1-65535.`);
        if (r.identityFile != null && (typeof r.identityFile !== "string" || !r.identityFile.trim())) errors.push(`config: ${where} remote.identityFile must be a non-empty string.`);
        if (r.bin != null && (typeof r.bin !== "string" || !r.bin.trim())) errors.push(`config: ${where} remote.bin must be a non-empty string.`);
      }
    }
  }
  return errors;
}

/** The tracker types a remote (ssh) worker can work from (#826): `local` (no tracker
 * channel at all) plus the ones whose adapters serve ticket comments to the hub
 * (`fetchComments`, so the worker's prompt carries the thread instead of the agent
 * reading it with `gh`). Anything else is refused by `remoteHarnessErrors` — and a
 * test ties every non-local entry to an adapter that actually has `fetchComments`.
 */
export const REMOTE_TRACKERS = new Set(["local", "github", "github-projects"]);

/**
 * Refusals for a step whose harness (named directly, or in a routing list) has a `remote` block
 * (#689, experimental): a remote worker can't run the profile's sandbox or a non-claude agent.
 * A non-local tracker is fine as long as it can serve the ticket's comments (#826 — the worker
 * holds no credentials, so the prompt embeds them; `REMOTE_TRACKERS` gates it), and GitHub App
 * auth is fine too: a remote run mints no per-run credentials (src/dispatch/step.js skips
 * `runCredentials`). Pure.
 * @param {any} cfg  the raw (uninterpolated) config
 * @param {any} step
 * @param {Record<string, any>} harnesses
 * @param {string} where
 * @returns {string[]}
 */
export function remoteHarnessErrors(cfg, step, harnesses, where) {
  const names = harnessesOf(step).filter((n) => harnesses?.[n]?.remote);
  if (!names.length) return [];
  /** @type {string[]} */
  const errors = [];
  if (isSandboxed(cfg, step)) {
    errors.push(`config: ${where} uses remote harness ${names.map((n) => JSON.stringify(n)).join("/")} but the step is sandboxed — a remote worker can't run the profile's sandbox (set "sandbox": false on the step).`);
  }
  for (const n of names) {
    const agent = step.agent ?? harnesses[n]?.agent ?? cfg.agent ?? DEFAULT_AGENT;
    if (!REMOTE_AGENTS.includes(agent)) errors.push(`config: ${where} remote harness ${JSON.stringify(n)} resolves to agent ${JSON.stringify(agent)} — supported on a remote worker: ${REMOTE_AGENTS.join(", ")}.`);
  }
  const trackerType = cfg.tracker?.type;
  if (trackerType != null && !REMOTE_TRACKERS.has(trackerType)) {
    errors.push(`config: ${where} uses remote harness ${names.map((n) => JSON.stringify(n)).join("/")} but "tracker.type" is ${JSON.stringify(trackerType)} — a remote worker needs the tracker to serve the ticket's comments to the hub (the adapter's fetchComments), which ${JSON.stringify(trackerType)} doesn't yet.`);
  }
  return errors;
}
