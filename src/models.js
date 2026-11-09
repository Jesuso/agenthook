// Context-window resolution for the live context gauge (#658): how many tokens a model's prompt
// window holds, so a running record's `ctx` (lastContext, #645) can be shown against a `ctxMax`.
// Import-light like src/pricing.js: the one import (readOpencodeConfig) is a file read reused from
// the opencode adapter, not a new dependency surface.
import { readOpencodeConfig } from "./agents/opencode.js";

/**
 * Context windows (tokens) for every Claude family in src/pricing.js's DEFAULT_RATES, plus the
 * CLI aliases the `claude` adapter accepts. A model string ending in `[1m]` (the 1M-context beta
 * header suffix) is handled separately in contextWindowOf, not here.
 * @type {Readonly<Record<string, number>>}
 */
export const CONTEXT_WINDOWS = Object.freeze({
  "claude-fable-5-1*": 200000,
  "claude-mythos-5-1*": 200000,
  "claude-fable-5*": 200000,
  "claude-mythos-5*": 200000,
  "claude-opus-5-5*": 200000,
  "claude-opus-5*": 200000,
  "claude-opus-4-8*": 200000,
  "claude-opus-4-7*": 200000,
  "claude-opus-4-6*": 200000,
  "claude-sonnet-5-5*": 200000,
  "claude-sonnet-5*": 200000,
  "claude-sonnet-4-6*": 200000,
  "claude-haiku-5-5*": 200000,
  "claude-haiku-4-5*": 200000,
  opus: 200000,
  sonnet: 200000,
  haiku: 200000,
  fable: 200000,
});

/** @param {string} pattern @param {string} s — case-insensitive; `*` is the only wildcard */
function globMatch(pattern, s) {
  const re = pattern.toLowerCase().replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${re}$`).test(s);
}

/** The best match in `table` for `s`: exact key beats glob, longer glob beats shorter.
 * @param {Record<string, number>} table @param {string} s @returns {number|null} */
function lookup(table, s) {
  let best = null;
  let bestLen = -1;
  for (const [k, v] of Object.entries(table)) {
    const key = k.toLowerCase();
    if (!key.includes("*")) {
      if (key === s) return v;
    } else if (key.length > bestLen && globMatch(key, s)) {
      best = v;
      bestLen = key.length;
    }
  }
  return best;
}

/**
 * The context window for `model`, matched like src/pricing.js's matchRate (case-insensitive,
 * exact before glob, full string before the part after its last `/` — OpenCode's `provider/model`).
 * A model ending in `[1m]` (any case) is 1,000,000 regardless of the table. Null when nothing matches.
 * @param {string|undefined|null} model @returns {number|null}
 */
export function contextWindowOf(model) {
  if (typeof model !== "string" || !model.trim()) return null;
  const full = model.trim().toLowerCase();
  if (full.endsWith("[1m]")) return 1000000;
  const tail = full.includes("/") ? full.slice(full.lastIndexOf("/") + 1) : null;
  for (const s of tail ? [full, tail] : [full]) {
    const r = lookup(CONTEXT_WINDOWS, s);
    if (r !== null) return r;
  }
  return null;
}

/** @param {unknown} v */
const isPositiveInt = (v) => typeof v === "number" && Number.isInteger(v) && v > 0;

/**
 * The context window a run's `model` should be measured against, in order: an explicit
 * `step.contextTokens` (the effective/harness-merged step, so a harness's value already applies
 * where the step sets none); an opencode step's `opencodeConfig` (`provider[<provider>].models
 * [<model>].limit.context`, model split on the first `/`) when `model` is `provider/model` —
 * any read/parse error or a missing/invalid field falls through rather than throwing; the
 * built-in CONTEXT_WINDOWS table; else null. Pure except for the opencodeConfig file read.
 * @param {{ step?: {contextTokens?: number, opencodeConfig?: string}, model?: string|null, agentName?: string }} o
 * @returns {number|null}
 */
export function resolveContextWindow({ step, model, agentName } = {}) {
  if (isPositiveInt(step?.contextTokens)) return /** @type {number} */ (step?.contextTokens);
  if (agentName === "opencode" && step?.opencodeConfig && typeof model === "string" && model.includes("/")) {
    try {
      const parsed = JSON.parse(readOpencodeConfig(step.opencodeConfig));
      const slash = model.indexOf("/");
      const provider = model.slice(0, slash);
      const modelName = model.slice(slash + 1);
      const ctx = parsed?.provider?.[provider]?.models?.[modelName]?.limit?.context;
      if (isPositiveInt(ctx)) return ctx;
    } catch {
      /* unreadable/invalid opencodeConfig, or no matching entry: fall through to the table */
    }
  }
  return contextWindowOf(model);
}
