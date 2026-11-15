// Operator runtime overrides (global pause, global maxConcurrent, per-harness slots) persisted in
// overrides.json. Shared by the engine (seeding at boot) and ops (mutating on pause/resume/
// set_concurrency), so the file shape and the heartbeat shape never drift.

/**
 * The heartbeat `overrides` field (published at seed and after every change): each active override
 * next to its configured value, so a reader sees the override beside what it overrides. `config`
 * null = no cap in the config (unbounded).
 * @typedef {object} HeartbeatOverrides
 * @property {true} [paused]
 * @property {{value: number, config: number}} [maxConcurrent]
 * @property {Record<string, {value: number, config: number|null}>} [harnesses]
 */

/**
 * The file's overrides as the heartbeat `overrides` shape (config values alongside). Returns null
 * when there are no active overrides.
 * @param {import('./types.js').Config} cfg
 * @param {import('./types.js').Overrides} o
 * @returns {HeartbeatOverrides|null}
 */
export function heartbeatOverrides(cfg, o) {
  /** @type {HeartbeatOverrides} */
  const out = {};
  if (o?.paused === true) out.paused = true;
  if (o && typeof o.maxConcurrent === "number" && Number.isInteger(o.maxConcurrent)) out.maxConcurrent = { value: o.maxConcurrent, config: cfg.maxConcurrent };
  if (o?.harnesses && typeof o.harnesses === "object" && !Array.isArray(o.harnesses)) {
    /** @type {Record<string, {value: number, config: number|null}>} */
    const harnesses = {};
    for (const [name, n] of Object.entries(o.harnesses)) {
      if (!cfg.harnesses || !Object.hasOwn(cfg.harnesses, name)) continue;
      if (!Number.isInteger(n) || n < 0 || n > 64) continue;
      harnesses[name] = { value: n, config: cfg.harnesses[name].maxConcurrent ?? null };
    }
    if (Object.keys(harnesses).length) out.harnesses = harnesses;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Drop override entries that no longer apply — a harness not in the config, a global max out of
 * range (not an integer 1..64) — returning the surviving overrides and one log line per drop.
 * The caller rewrites the file and applies what remains.
 * @param {import('./types.js').Config} cfg
 * @param {import('./types.js').Overrides} o
 * @returns {{ overrides: import('./types.js').Overrides, dropped: string[] }}
 */
export function pruneOverrides(cfg, o) {
  /** @type {import('./types.js').Overrides} */
  const overrides = {};
  /** @type {string[]} */
  const dropped = [];
  if (o?.paused === true) overrides.paused = true;
  if (o && o.maxConcurrent !== undefined) {
    if (Number.isInteger(o.maxConcurrent) && o.maxConcurrent >= 1 && o.maxConcurrent <= 64) overrides.maxConcurrent = o.maxConcurrent;
    else dropped.push(`[overrides] dropped global maxConcurrent override: invalid max ${JSON.stringify(o.maxConcurrent)}`);
  }
  if (o?.harnesses && typeof o.harnesses === "object" && !Array.isArray(o.harnesses)) {
    /** @type {Record<string, number>} */
    const kept = {};
    for (const [name, n] of Object.entries(o.harnesses)) {
      if (!cfg.harnesses || !Object.hasOwn(cfg.harnesses, name)) {
        dropped.push(`[overrides] dropped override for harness "${name}": not in the config`);
        continue;
      }
      if (!Number.isInteger(n) || n < 0 || n > 64) {
        dropped.push(`[overrides] dropped override for harness "${name}": invalid max ${JSON.stringify(n)}`);
        continue;
      }
      kept[name] = n;
    }
    if (Object.keys(kept).length) overrides.harnesses = kept;
  }
  return { overrides, dropped };
}

/**
 * One display line per active override, from the heartbeat shape (config value alongside, so a
 * reader sees the override next to what it overrides). "unbounded" = no cap in the config.
 * @param {HeartbeatOverrides|null|undefined} hbOverrides
 * @returns {string[]}
 */
export function overrideEntries(hbOverrides) {
  /** @type {string[]} */
  const lines = [];
  if (hbOverrides?.paused === true) lines.push("paused (override; unpause to clear)");
  if (hbOverrides?.maxConcurrent && typeof hbOverrides.maxConcurrent === "object") {
    lines.push(`maxConcurrent: ${hbOverrides.maxConcurrent.value} (override; config ${hbOverrides.maxConcurrent.config})`);
  }
  for (const [name, h] of Object.entries(hbOverrides?.harnesses ?? {})) {
    if (!h || typeof h !== "object" || !Number.isInteger(h.value)) continue;
    lines.push(`${name}: ${h.value} slots (override; config ${h.config == null ? "unbounded" : h.config})`);
  }
  return lines;
}

/**
 * One display line per active override, from the raw overrides.json shape (no config comparison —
 * used when the receiver is down and the config may not load).
 * @param {import('./types.js').Overrides} o
 * @returns {string[]}
 */
export function fileOverrideEntries(o) {
  /** @type {string[]} */
  const lines = [];
  if (o?.paused === true) lines.push("paused");
  if (o && Number.isInteger(o.maxConcurrent)) lines.push(`maxConcurrent: ${o.maxConcurrent}`);
  for (const [name, n] of Object.entries(o?.harnesses ?? {})) {
    if (Number.isInteger(n)) lines.push(`${name}: ${n} slots`);
  }
  return lines;
}

/**
 * Apply the persisted overrides to a freshly-built engine (before `serve()` → `restoreQueued`),
 * dropping entries that no longer match the config and publishing the survivors to the heartbeat.
 * Must run after `queue` and the quota pacer exist. Returns what was applied.
 * @param {{
 *   cfg: import('./types.js').Config,
 *   store: import('./types.js').Store,
 *   queue: { setMax(n: number): void, setHarnessMax(name: string, n: number|null): void, pause(): void },
 *   quotaPacer: { operatorPause(): void },
 *   heartbeat: { update(p: Record<string, unknown>): void },
 * }} deps
 * @returns {import('./types.js').Overrides}
 */
export function seedOverrides({ cfg, store, queue, quotaPacer, heartbeat }) {
  const { overrides, dropped } = pruneOverrides(cfg, store.getOverrides());
  for (const line of dropped) console.warn(line);
  if (dropped.length) store.setOverrides(overrides);
  const harnesses = Object.entries(overrides.harnesses ?? {});
  const applied = overrides.paused === true || overrides.maxConcurrent !== undefined || harnesses.length > 0;
  if (applied) {
    if (overrides.paused === true) {
      quotaPacer.operatorPause();
      queue.pause();
      heartbeat.update({ paused: true });
    }
    for (const [name, n] of harnesses) queue.setHarnessMax(name, n);
    if (overrides.maxConcurrent !== undefined) {
      queue.setMax(overrides.maxConcurrent);
      heartbeat.update({ maxConcurrent: overrides.maxConcurrent });
    }
    const parts = [];
    if (overrides.paused === true) parts.push("paused");
    if (overrides.maxConcurrent !== undefined) parts.push(`maxConcurrent ${overrides.maxConcurrent}`);
    for (const [name, n] of harnesses) parts.push(`harness ${name} = ${n}`);
    console.log(`[overrides] restored ${parts.join(", ")}`);
  }
  heartbeat.update({ overrides: heartbeatOverrides(cfg, overrides) });
  return overrides;
}
