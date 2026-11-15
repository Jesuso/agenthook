// The queue's harnessing shape, derived from `cfg` in one place so boot (`createEngine`) and
// reload (`queue.reconfigure`) cannot drift apart. Pure — no I/O. The health breaker seeding and
// the event/persist callbacks stay in `createEngine`; reload reuses only these shapes.

import { harnessesOf, quotaGroupOf } from "../dispatch/harness.js";
import { DEFAULT_AGENT } from "../agents/names.js";

/**
 * The step caps, harness routing and per-harness slot caps/cooldowns the queue copies at
 * construction (and that `queue.reconfigure` re-applies on a reload). `unharnessedShared` lists
 * the step ids whose unharnessed claude runs share the profile's quota group; `unharnessedAgents`
 * maps every unharnessed step to the agent CLI its runs spawn under (for `state().unharnessed`).
 * @typedef {object} HarnessingShape
 * @property {Record<string, number>} stepCaps
 * @property {Record<string, {harnesses: string[], routing?: 'first-free'|'round-robin'}>} steps
 * @property {Record<string, number|undefined>} caps
 * @property {Record<string, number|undefined>} cooldowns
 * @property {string[]} unharnessedShared
 * @property {Record<string, string>} unharnessedAgents
 */

/**
 * @param {import('../types.js').Config} cfg
 * @returns {HarnessingShape}
 */
export function buildHarnessing(cfg) {
  /** @type {Record<string, number>} */
  const stepCaps = {};
  for (const s of cfg.pipeline || []) if (!s.manual && s.maxConcurrent != null) stepCaps[s.id] = s.maxConcurrent;

  /** @type {Record<string, {harnesses: string[], routing?: 'first-free'|'round-robin'}>} */
  const steps = {};
  /** @type {Record<string, number|undefined>} */
  const caps = {};
  /** @type {Record<string, number|undefined>} */
  const cooldowns = {};
  /** @type {string[]} */
  const unharnessedShared = [];
  /** @type {Record<string, string>} */
  const unharnessedAgents = {};
  if (cfg.harnesses) {
    for (const s of cfg.pipeline || []) {
      if (s.manual || harnessesOf(s).length) continue;
      if (quotaGroupOf(cfg, null, s).unharnessed) unharnessedShared.push(s.id);
      unharnessedAgents[s.id] = s.agent ?? cfg.agent ?? DEFAULT_AGENT;
    }
    for (const s of cfg.pipeline || []) {
      if (!s.manual && harnessesOf(s).length) steps[s.id] = { harnesses: harnessesOf(s), routing: s.routing ?? "first-free" };
    }
    for (const [name, h] of Object.entries(cfg.harnesses)) {
      caps[name] = h.maxConcurrent;
      cooldowns[name] = h.cooldownMinutes;
    }
  }
  return { stepCaps, steps, caps, cooldowns, unharnessedShared, unharnessedAgents };
}
