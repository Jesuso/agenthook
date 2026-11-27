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
 * `reserves` is the effective reserve (#745) per EXCLUSIVE harness that keeps one; `exclusive`
 * lists every harness some non-manual step lists as its only harness (whatever its reserve).
 * @typedef {object} HarnessingShape
 * @property {Record<string, number>} stepCaps
 * @property {Record<string, {harnesses: string[], routing?: 'first-free'|'round-robin'}>} steps
 * @property {Record<string, number|undefined>} caps
 * @property {Record<string, number|undefined>} cooldowns
 * @property {string[]} unharnessedShared
 * @property {Record<string, string>} unharnessedAgents
 * @property {Record<string, number>} reserves
 * @property {string[]} exclusive
 */

/**
 * Harnesses used by some non-manual step as its ONLY harness (#745), with the reserve that
 * protects them from a spill. `automatic` is false when `harnesses.<name>.reserve` overrides the
 * default (1 when some OTHER step lists `name` as one option among several, else 0). Pure.
 * @param {Pick<import('../types/index.js').Config, 'pipeline'|'harnesses'>} cfg
 * @returns {Record<string, {reserve: number, automatic: boolean, usedAsAlt: boolean}>}
 */
export function exclusiveHarnesses(cfg) {
  /** @type {string[][]} */
  const lists = [];
  for (const s of cfg.pipeline || []) {
    if (s.manual) continue;
    const names = harnessesOf(s);
    if (names.length) lists.push(names);
  }
  /** @type {Record<string, {reserve: number, automatic: boolean, usedAsAlt: boolean}>} */
  const out = {};
  for (const names of lists) {
    if (names.length !== 1) continue;
    const name = names[0];
    if (Object.hasOwn(out, name)) continue;
    const usedAsAlt = lists.some((l) => l.length > 1 && l.includes(name));
    const override = cfg.harnesses?.[name]?.reserve;
    const automatic = !(typeof override === "number" && Number.isInteger(override) && override >= 0);
    out[name] = { reserve: automatic ? (usedAsAlt ? 1 : 0) : override, automatic, usedAsAlt };
  }
  return out;
}

/**
 * @param {import('../types/index.js').Config} cfg
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
  const ex = exclusiveHarnesses(cfg);
  const exclusive = Object.keys(ex);
  /** @type {Record<string, number>} */
  const reserves = {};
  for (const [name, info] of Object.entries(ex)) if (info.reserve > 0) reserves[name] = info.reserve;
  return { stepCaps, steps, caps, cooldowns, unharnessedShared, unharnessedAgents, reserves, exclusive };
}
