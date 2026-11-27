// Per-pipeline-step structural checks: queue-stage keys and the (large) per-step check,
// extracted verbatim from the old src/config.js forEach body so validateRawConfig stays a
// one-line `.forEach` call over it.
import { HARNESS_ROUTINGS } from "../../shared/config-schema.js";
import { label, KNOB_ERRORS, envErrors } from "./common.js";
import { remoteHarnessErrors } from "./harnesses.js";
import { policyErrors } from "./policy.js";
import { egressErrors, MAX_STEP_SERVICES } from "./sandbox.js";

/** Per-step queue-stage keys, each paired with the source key it must not equal. */
export const QUEUE_KEYS = /** @type {const} */ ([
  ["queueSectionGid", "sourceSectionGid"],
  ["queueStatus", "sourceStatus"],
  ["queueLabel", "sourceLabel"],
]);

/**
 * Structural checks for one pipeline step — the body of validateRawConfig's per-step loop,
 * moved verbatim. Pushes directly into `errors`, in the same order as inline.
 * @param {string[]} errors @param {Set<unknown>} ids @param {import('./common.js').RawNode} cfg
 * @param {import('./common.js').RawNode} harnesses @param {import('./common.js').RawNode} step
 * @param {number} i
 */
export function stepErrors(errors, ids, cfg, harnesses, step, i) {
  if (!step || typeof step !== "object") return void errors.push(`config: tracker.pipeline[${i}] must be an object.`);
  const sid = label(step.id);
  if (!step.id) errors.push(`config: every pipeline step needs an "id".`);
  else if (ids.has(step.id)) errors.push(`config: duplicate pipeline step id "${sid}".`);
  ids.add(step.id);
  if (step.maxAttempts != null && (!Number.isInteger(step.maxAttempts) || step.maxAttempts < 1)) {
    errors.push(`config: pipeline step "${sid}" maxAttempts must be a positive integer.`);
  }
  if (step.maxConcurrent != null) {
    if (!Number.isInteger(step.maxConcurrent) || step.maxConcurrent < 1) {
      errors.push(`config: pipeline step "${sid}" maxConcurrent must be a positive integer.`);
    } else if (step.manual) {
      errors.push(`config: pipeline step "${sid}" maxConcurrent has no effect on a manual step (no agent runs).`);
    }
  }
  if (step.maxMinutes != null && (typeof step.maxMinutes !== "number" || !Number.isFinite(step.maxMinutes) || step.maxMinutes < 0)) {
    errors.push(`config: pipeline step "${sid}" maxMinutes must be a number >= 0 (0 disables the cap).`);
  }
  if (step.idleMinutes != null && (typeof step.idleMinutes !== "number" || !Number.isFinite(step.idleMinutes) || step.idleMinutes <= 0)) {
    errors.push(`config: pipeline step "${sid}" idleMinutes must be a number > 0.`);
  }
  if (step.contextTokens != null && (!Number.isInteger(step.contextTokens) || step.contextTokens < 1)) {
    errors.push(`config: pipeline step "${sid}" contextTokens must be a positive integer.`);
  }
  const where = `pipeline step "${sid}"`;
  for (const k of /** @type {const} */ (["agent", "bin", "provider", "toolsets"])) {
    if (step[k] == null) continue;
    const e = KNOB_ERRORS[k](step[k], where);
    if (e) errors.push(e);
    else if (step.manual && k !== "bin") errors.push(`config: ${where} ${k} has no effect on a manual step (no agent runs).`);
  }
  if (step.harness != null) {
    const h = step.harness;
    const named = (/** @type {unknown} */ n) => typeof n === "string" && n.trim() !== "";
    const isEntry = (/** @type {unknown} */ n) => typeof n === "object" && n !== null && !Array.isArray(n);
    const ref = (/** @type {unknown} */ n) => named(n) || isEntry(n);
    if (!named(h) && !(Array.isArray(h) && h.length && h.every(ref))) {
      errors.push(`config: ${where} harness must be a harness name or a non-empty list of names or {name, model?, effort?} entries.`);
    } else if (step.manual) {
      errors.push(`config: ${where} harness has no effect on a manual step (no agent runs).`);
    } else {
      const list = typeof h === "string" ? [h] : h;
      const known = harnesses && typeof harnesses === "object" && !Array.isArray(harnesses) ? harnesses : {};
      /** @type {string[]} */
      const seen = [];
      for (const [i, e] of list.entries()) {
        if (typeof e === "string") {
          if (seen.includes(e)) errors.push(`config: ${where} harness lists ${JSON.stringify(e)} twice.`);
          else if (!Object.hasOwn(known, e)) errors.push(`config: ${where} harness ${JSON.stringify(e)} is not in "harnesses".`);
          else seen.push(e);
          continue;
        }
        const name = named(e.name) ? e.name : undefined;
        if (name === undefined) errors.push(`config: ${where} harness entry at index ${i} must have a non-empty string "name".`);
        for (const k of Object.keys(e)) {
          if (k !== "name" && k !== "model" && k !== "effort") errors.push(`config: ${where} harness entry ${JSON.stringify(name)} has unknown key ${JSON.stringify(k)} (allowed: name, model, effort).`);
        }
        if (e.model != null && (typeof e.model !== "string" || !e.model.trim())) errors.push(`config: ${where} harness entry ${JSON.stringify(name)} model must be a non-empty string.`);
        if (e.effort != null && (typeof e.effort !== "string" || !e.effort.trim())) errors.push(`config: ${where} harness entry ${JSON.stringify(name)} effort must be a non-empty string.`);
        if (name === undefined) continue;
        if (seen.includes(name)) errors.push(`config: ${where} harness lists ${JSON.stringify(name)} twice.`);
        else if (!Object.hasOwn(known, name)) errors.push(`config: ${where} harness ${JSON.stringify(name)} is not in "harnesses".`);
        else seen.push(name);
      }
      errors.push(...remoteHarnessErrors(cfg, step, known, where));
    }
  }
  if (step.routing != null) {
    if (!(/** @type {readonly unknown[]} */ (HARNESS_ROUTINGS).includes(step.routing))) {
      errors.push(`config: ${where} routing must be ${HARNESS_ROUTINGS.map((r) => JSON.stringify(r)).join(" or ")}.`);
    } else if (!Array.isArray(step.harness)) {
      errors.push(`config: ${where} routing needs a "harness" list (it picks among several harnesses).`);
    }
  }
  for (const key of /** @type {const} */ (["allow", "deny"])) {
    if (step[key] == null) continue;
    if (step.manual) {
      errors.push(`config: pipeline step "${sid}" ${key} has no effect on a manual step (no agent runs).`);
      continue;
    }
    errors.push(...policyErrors(step[key], `config: pipeline step "${sid}" ${key}`));
  }
  if (step.isolated != null) {
    if (typeof step.isolated !== "boolean") {
      errors.push(`config: pipeline step "${sid}" isolated must be true or false.`);
    } else if (step.manual) {
      errors.push(`config: pipeline step "${sid}" isolated has no effect on a manual step (no agent runs).`);
    }
  }
  if (step.energy != null) {
    if (typeof step.energy !== "boolean") {
      errors.push(`config: pipeline step "${sid}" energy must be true or false.`);
    } else if (step.manual) {
      errors.push(`config: pipeline step "${sid}" energy has no effect on a manual step (no agent runs).`);
    } else if (step.energy && cfg.energy == null) {
      errors.push(`config: pipeline step "${sid}" energy:true needs a profile "energy" block ({usdPerKwh, source}).`);
    }
  }
  if (step.sandbox != null) {
    if (typeof step.sandbox !== "boolean") {
      errors.push(`config: pipeline step "${sid}" sandbox must be true or false.`);
    } else if (step.manual) {
      errors.push(`config: pipeline step "${sid}" sandbox has no effect on a manual step (no agent runs).`);
    }
  }
  if (step.egress != null) {
    if (step.manual) errors.push(`config: pipeline step "${sid}" egress has no effect on a manual step (no agent runs).`);
    else if (step.sandbox === false) errors.push(`config: pipeline step "${sid}" egress has no effect: the step runs on the host ("sandbox": false).`);
    else if (cfg.sandbox == null) errors.push(`config: pipeline step "${sid}" egress needs a profile "sandbox" (egress is enforced by the sandbox's network).`);
    errors.push(...egressErrors(step.egress, `pipeline step "${sid}" egress`));
  }
  if (step.services != null) {
    const list = step.services;
    if (!Array.isArray(list) || list.some((/** @type {unknown} */ n) => typeof n !== "string")) errors.push(`config: pipeline step "${sid}" services must be a list of sandbox.services names.`);
    else if (step.manual) errors.push(`config: pipeline step "${sid}" services has no effect on a manual step (no agent runs).`);
    else if (step.sandbox === false) errors.push(`config: pipeline step "${sid}" services needs the sandbox: the step runs on the host ("sandbox": false).`);
    else if (cfg.sandbox == null) errors.push(`config: pipeline step "${sid}" services needs a profile "sandbox" (services run beside the sandboxed agent).`);
    else {
      if (list.length > MAX_STEP_SERVICES) errors.push(`config: pipeline step "${sid}" services lists ${list.length} services (at most ${MAX_STEP_SERVICES}).`);
      const catalog = cfg.sandbox.services;
      for (const [i, n] of list.entries()) {
        if (list.indexOf(n) !== i) errors.push(`config: pipeline step "${sid}" services lists ${JSON.stringify(n)} twice.`);
        else if (!catalog || typeof catalog !== "object" || !Object.hasOwn(catalog, n)) errors.push(`config: pipeline step "${sid}" services ${JSON.stringify(n)} is not in sandbox.services.`);
      }
    }
  }
  if (step.env != null) errors.push(...envErrors(step.env, where));
  if (step.opencodeConfig != null && (typeof step.opencodeConfig !== "string" || !step.opencodeConfig.trim())) {
    errors.push(`config: ${where} opencodeConfig must be a non-empty string.`);
  }
  if (step.piConfigDir != null && (typeof step.piConfigDir !== "string" || !step.piConfigDir.trim())) {
    errors.push(`config: ${where} piConfigDir must be a non-empty string.`);
  }
  if (step.lite != null) {
    const h = step.lite.descriptionHeadings;
    if (!Array.isArray(h) || !h.length || !h.every((x) => typeof x === "string" && x.trim())) {
      errors.push(`config: pipeline step "${sid}" lite.descriptionHeadings must be a non-empty array of strings.`);
    }
  }
  if (step.completeOnMerge && !step.manual) {
    errors.push(`config: pipeline step "${sid}" completeOnMerge requires manual:true (no agent runs on a merge).`);
  }
  if (step.requireVerdict != null) {
    if (typeof step.requireVerdict !== "boolean") {
      errors.push(`config: pipeline step "${sid}" requireVerdict must be a boolean.`);
    } else if (step.manual) {
      errors.push(`config: pipeline step "${sid}" requireVerdict has no effect on a manual step (no agent runs).`);
    }
  }
  if (step.verdictRepairs != null) {
    if (typeof step.verdictRepairs !== "number" || !Number.isInteger(step.verdictRepairs) || step.verdictRepairs < 0) {
      errors.push(`config: pipeline step "${sid}" verdictRepairs must be an integer >= 0.`);
    } else if (step.manual) {
      errors.push(`config: pipeline step "${sid}" verdictRepairs has no effect on a manual step (no agent runs).`);
    }
  }
  if (step.deduceVerdict != null) {
    if (typeof step.deduceVerdict !== "boolean") {
      errors.push(`config: pipeline step "${sid}" deduceVerdict must be a boolean.`);
    } else if (step.manual) {
      errors.push(`config: pipeline step "${sid}" deduceVerdict has no effect on a manual step (no agent runs).`);
    }
  }
  if (step.gate != null) {
    const g = step.gate;
    const validShape = (typeof g === "string" && g.trim() !== "") || (Array.isArray(g) && g.length > 0 && g.every((x) => typeof x === "string" && x.trim() !== ""));
    if (!validShape) {
      errors.push(`config: pipeline step "${sid}" gate must be a non-empty string or a non-empty array of strings.`);
    } else if (step.manual) {
      errors.push(`config: pipeline step "${sid}" gate has no effect on a manual step (no agent runs).`);
    }
  }
  if (step.gateTimeoutMinutes != null) {
    if (typeof step.gateTimeoutMinutes !== "number" || !Number.isFinite(step.gateTimeoutMinutes) || step.gateTimeoutMinutes <= 0) {
      errors.push(`config: pipeline step "${sid}" gateTimeoutMinutes must be a number > 0.`);
    } else if (step.gate == null) {
      errors.push(`config: pipeline step "${sid}" gateTimeoutMinutes has no effect without a "gate".`);
    }
  }
  // Queue stage (opt-in backlog lane the engine pulls from when a slot frees). A manual
  // step runs no agent, so it has nothing to pull into; a queue equal to the step's own
  // source would pull an item into the stage it already rests in (a self-loop).
  for (const [qk, sk] of QUEUE_KEYS) {
    if (step[qk] == null) continue;
    if (step.manual) errors.push(`config: pipeline step "${sid}" ${qk} is not allowed on a manual step (no agent to pull into).`);
    else if (step[sk] != null && label(step[qk]).trim().toLowerCase() === label(step[sk]).trim().toLowerCase()) {
      errors.push(`config: pipeline step "${sid}" ${qk} must differ from its own ${sk} (it would self-loop).`);
    }
  }
}
