// Claude subscription quota (#397): the 5-hour and 7-day windows `claude -p` reports in its
// `rate_limit_event` stream line, the human readout, and the opt-in pacer that pauses admission
// above a threshold and resumes by itself at the window reset. Import-free on purpose: config
// validation, the readers and the browser bundle share it (like src/pricing.js). The file I/O
// (`<stateDir>/quota.json`) lives in src/quota-file.js.

/** A reading's windows, in display order (weekly first). */
export const QUOTA_WINDOWS = /** @type {const} */ (["sevenDay", "fiveHour"]);
/** The config key that sets each window's pause threshold. */
export const QUOTA_THRESHOLD_KEYS = /** @type {const} */ ({ sevenDay: "pauseAboveSevenDay", fiveHour: "pauseAboveFiveHour" });
/** Readout labels. */
const LABELS = { sevenDay: "weekly", fiveHour: "5h" };
/** Above this a utilization is garbage, not a reading (overage can push it a little past 1). */
const MAX_UTILIZATION = 1.5;
/** setTimeout's ceiling (~24.8 days); a longer wait re-arms when it fires. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** @typedef {{ utilization: number, resetsAt: string }} QuotaWindow  utilization 0–1, resetsAt ISO */
/** @typedef {{ fiveHour?: QuotaWindow, sevenDay?: QuotaWindow, asOf?: string }} QuotaReading */
/** @typedef {{ pauseAboveSevenDay?: number, pauseAboveFiveHour?: number }} QuotaConfig */
/** @typedef {{ window: 'sevenDay'|'fiveHour', utilization: number, threshold: number, resetsAt: string }} QuotaTrip */

/** @param {any} v @returns {v is Record<string, any>} */
const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);

/** @param {any} v @returns {v is number} */
const isUtilization = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= MAX_UTILIZATION;

/** @param {any} v */
const isIso = (v) => typeof v === "string" && !Number.isNaN(Date.parse(v));

/**
 * A stored or relayed reading, validated: each window kept only with a utilization in
 * [0, 1.5] and a parseable ISO `resetsAt`; `asOf` kept when parseable. No valid window → null.
 * Foreign values never pass through (the UI and the MCP surface read it).
 * @param {any} raw @returns {QuotaReading|null}
 */
export function normalizeQuota(raw) {
  if (!isObj(raw)) return null;
  /** @type {QuotaReading} */
  const out = {};
  for (const k of QUOTA_WINDOWS) {
    const w = raw[k];
    if (isObj(w) && isUtilization(w.utilization) && isIso(w.resetsAt)) out[k] = { utilization: w.utilization, resetsAt: w.resetsAt };
  }
  if (!out.fiveHour && !out.sevenDay) return null;
  if (isIso(raw.asOf)) out.asOf = raw.asOf;
  return out;
}

/**
 * A heartbeat's `quotaPaused` trip, validated; null when absent or foreign.
 * @param {any} raw @returns {QuotaTrip|null}
 */
export function normalizeTrip(raw) {
  if (!isObj(raw) || !(/** @type {readonly string[]} */ (QUOTA_WINDOWS)).includes(raw.window)) return null;
  if (!isUtilization(raw.utilization) || !isIso(raw.resetsAt) || typeof raw.threshold !== "number" || !Number.isFinite(raw.threshold)) return null;
  return { window: raw.window, utilization: raw.utilization, threshold: raw.threshold, resetsAt: raw.resetsAt };
}

/**
 * `claude -p`'s `rate_limit_event` → a reading, or null for any other shape (never throws).
 * `rate_limit_info.unifiedWindows.{five_hour,seven_day}` carry utilization 0–1 and `resetsAt`
 * in epoch **seconds**; a window is kept only when both are finite numbers in range.
 * @param {any} ev @returns {QuotaReading|null}
 */
export function quotaFromRateLimitEvent(ev) {
  const uw = isObj(ev) && isObj(ev.rate_limit_info) ? ev.rate_limit_info.unifiedWindows : null;
  if (!isObj(uw)) return null;
  /** @type {QuotaReading} */
  const out = {};
  for (const [src, k] of /** @type {const} */ ([["five_hour", "fiveHour"], ["seven_day", "sevenDay"]])) {
    const w = uw[src];
    if (!isObj(w) || !isUtilization(w.utilization) || typeof w.resetsAt !== "number" || !Number.isFinite(w.resetsAt)) continue;
    const ms = w.resetsAt * 1000;
    if (Math.abs(ms) > 8.64e15) continue; // outside Date's range
    out[k] = { utilization: w.utilization, resetsAt: new Date(ms).toISOString() };
  }
  return out.fiveHour || out.sevenDay ? out : null;
}

/**
 * The `quota` config block's errors (src/config.js and the config editor run it). Each key is an
 * optional number in (0, 1]; unset = that window never pauses.
 * @param {unknown} quota @returns {string[]}
 */
export function quotaErrors(quota) {
  if (quota === undefined || quota === null) return [];
  if (!isObj(quota)) return [`config: "quota" must be an object {pauseAboveSevenDay?, pauseAboveFiveHour?}.`];
  /** @type {string[]} */
  const errors = [];
  const keys = Object.values(QUOTA_THRESHOLD_KEYS);
  for (const [k, v] of Object.entries(quota)) {
    if (!(/** @type {readonly string[]} */ (keys)).includes(k)) errors.push(`config: quota has unknown key "${k}" (allowed: ${keys.join(", ")}).`);
    else if (v !== undefined && (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v > 1)) {
      errors.push(`config: quota.${k} must be a number in (0, 1] (a utilization fraction, e.g. 0.9).`);
    }
  }
  return errors;
}

/**
 * Should admission pause? A window counts only when its threshold is set, it is present, and its
 * `resetsAt` is still ahead; a missing / stale (reset passed) window or no config fails open.
 * At or above its threshold trips it; with both tripped, the one that resets last wins (the
 * pause must hold until both clear).
 * @param {QuotaReading|null|undefined} reading @param {QuotaConfig|null|undefined} thresholds @param {number} now  epoch ms
 * @returns {{pause: false} | ({pause: true} & QuotaTrip)}
 */
export function evaluateQuota(reading, thresholds, now) {
  /** @type {QuotaTrip|null} */
  let trip = null;
  for (const k of QUOTA_WINDOWS) {
    const t = thresholds?.[QUOTA_THRESHOLD_KEYS[k]];
    const w = reading?.[k];
    if (typeof t !== "number" || !Number.isFinite(t) || t <= 0 || !w) continue;
    const at = Date.parse(w.resetsAt);
    if (!(at > now) || !(w.utilization >= t)) continue;
    if (!trip || at > Date.parse(trip.resetsAt)) trip = { window: k, utilization: w.utilization, threshold: t, resetsAt: w.resetsAt };
  }
  return trip ? { pause: true, ...trip } : { pause: false };
}

/** A duration as `2d 4h` / `3h 10m` / `7m` / `<1m`. @param {number} ms */
export function formatDuration(ms) {
  const m = Math.floor(Math.max(0, ms) / 60000);
  if (m < 1) return "<1m";
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m % 60}m`;
  return `${m}m`;
}

/**
 * One line, e.g. `weekly 65% · resets in 2d 4h · 5h 8% (as of 3m ago)`. The first window shown
 * carries its reset countdown; a window whose `resetsAt` has passed reads as "reset" (its
 * utilization is stale). Empty string when there is no reading.
 * @param {QuotaReading|null|undefined} q @param {number} now  epoch ms
 */
export function formatQuota(q, now) {
  const r = normalizeQuota(q);
  if (!r) return "";
  /** @type {string[]} */
  const parts = [];
  for (const k of QUOTA_WINDOWS) {
    const w = r[k];
    if (!w) continue;
    const at = Date.parse(w.resetsAt);
    if (at <= now) parts.push(`${LABELS[k]} reset`);
    else parts.push(`${LABELS[k]} ${Math.round(w.utilization * 100)}%${parts.length ? "" : ` · resets in ${formatDuration(at - now)}`}`);
  }
  const age = r.asOf ? ` (as of ${formatDuration(now - Date.parse(r.asOf))} ago)` : "";
  return parts.join(" · ") + age;
}

/**
 * The pacer (default off: no thresholds → never pauses). Tracks pause **reasons** apart: an
 * operator pause (`operatorPause`/`operatorResume`, from the `pause`/`resume` ops), its own quota
 * trip, and the engine's lock (`isLocked`: restart/decommission/shutdown). It only ever resumes
 * the queue when no other reason holds, and never touches running agents.
 *
 * - `reading(q)` (each new reading, and once on boot): at/above a threshold → pause the queue +
 *   `onPause(trip)`, and arm one one-shot timer at the trip's `resetsAt` (a deadline, not a poll);
 *   below → release with reason `below`.
 * - The timer re-evaluates the last reading at the reset: still tripped on the other window →
 *   stay paused on that one; else release with reason `reset`.
 * - `operatorResume()` during a trip clears it (reason `operator`) and overrides, until its own
 *   `resetsAt`, every window that is at/above its threshold in the last reading at that moment
 *   (not just the one reported as tripped — with both tripped, only the reported one would
 *   re-pause on the other at the next reading): an above-threshold reading on an overridden
 *   window before its reset does not re-pause. A window not tripped at resume time still pauses
 *   when it later crosses its threshold.
 * @param {{
 *   thresholds?: QuotaConfig|null,
 *   pauseQueue: () => void,
 *   resumeQueue: () => void,
 *   isLocked?: () => boolean,
 *   onPause?: (trip: QuotaTrip) => void,
 *   onResume?: (info: {window: QuotaTrip['window'], reason: 'reset'|'below'|'operator'}) => void,
 *   now?: () => number,
 *   setTimer?: (fn: () => void, ms: number) => any,
 *   clearTimer?: (t: any) => void,
 * }} deps
 */
export function createQuotaPacer(deps) {
  const { thresholds, pauseQueue, resumeQueue, onPause, onResume } = deps;
  const isLocked = deps.isLocked ?? (() => false);
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? setTimeout;
  const clearTimer = deps.clearTimer ?? clearTimeout;
  let operatorPaused = false;
  /** @type {QuotaTrip|null} */
  let tripped = null;
  /** Per-window override end (epoch ms), set by operatorResume. @type {Partial<Record<QuotaTrip['window'], number>>} */
  let overrides = {};
  /** @type {QuotaReading|null} */
  let last = null;
  /** @type {any} */
  let timer;

  /** `thresholds` with an overridden-and-still-active window's key removed. */
  const effectiveThresholds = () => {
    let out = thresholds;
    for (const k of QUOTA_WINDOWS) {
      if (overrides[k] !== undefined && now() < /** @type {number} */ (overrides[k])) {
        if (out === thresholds) out = { ...thresholds };
        delete /** @type {NonNullable<typeof out>} */ (out)[QUOTA_THRESHOLD_KEYS[k]];
      }
    }
    return out;
  };

  const disarm = () => {
    if (timer !== undefined) clearTimer(timer);
    timer = undefined;
  };
  const arm = () => {
    disarm();
    if (!tripped) return;
    const ms = Math.max(0, Date.parse(tripped.resetsAt) - now());
    timer = setTimer(onTimer, Math.min(ms, MAX_TIMER_MS));
    timer?.unref?.();
  };
  function onTimer() {
    timer = undefined;
    if (!tripped) return;
    if (Date.parse(tripped.resetsAt) > now()) return arm(); // a clamped long wait: not there yet
    evaluate("reset");
  }
  /** @param {'reset'|'below'} why */
  function evaluate(why) {
    const ev = evaluateQuota(last, effectiveThresholds(), now());
    if (ev.pause) {
      const { pause, ...trip } = ev;
      const changed = !tripped || tripped.window !== trip.window;
      tripped = trip;
      if (changed) {
        pauseQueue();
        onPause?.(trip);
      }
      arm();
      return;
    }
    if (!tripped) return;
    const window = tripped.window;
    tripped = null;
    disarm();
    onResume?.({ window, reason: why });
    if (!operatorPaused && !isLocked()) resumeQueue();
  }

  return {
    /** A new reading (or the persisted one on boot). @param {QuotaReading|null} q */
    reading(q) {
      last = q;
      evaluate("below");
    },
    /** The operator paused the queue (ops `pause`): a quota release must not undo it. */
    operatorPause() {
      operatorPaused = true;
    },
    /**
     * The operator resumed (ops `resume`, which resumes the queue itself). During a trip: clear it
     * and override every window at/above its threshold in the last reading, each until its own
     * reset. Returns the (reported) trip's `resetsAt`, if any.
     * @returns {string|null}
     */
    operatorResume() {
      operatorPaused = false;
      if (!tripped) return null;
      for (const k of QUOTA_WINDOWS) {
        const t = thresholds?.[QUOTA_THRESHOLD_KEYS[k]];
        const w = last?.[k];
        if (typeof t !== "number" || !Number.isFinite(t) || t <= 0 || !w || !(w.utilization >= t)) continue;
        overrides[k] = Date.parse(w.resetsAt);
      }
      const { window, resetsAt } = tripped;
      tripped = null;
      disarm();
      onResume?.({ window, reason: "operator" });
      return resetsAt;
    },
    /** The current trip, or null. */
    state: () => tripped,
    /** Drop the reset timer (shutdown). */
    stop: disarm,
  };
}
