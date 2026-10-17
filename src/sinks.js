// Human-attention sinks: forward selected lifecycle events (see events.js) to Slack,
// Telegram, or a generic webhook. Best-effort and fire-and-forget — a sink never
// throws into, blocks, or changes the outcome of the pipeline. Delivered in emit
// order per sink via a serial per-sink queue (bounded backlog, oldest dropped
// beyond the cap); no retries.

import { DEFAULT_SINK_EVENTS } from "./sinks-config.js";

const TIMEOUT_MS = 5000;
const MAX_BACKLOG = 100;

/** @param {import('./types.js').Config} cfg @param {Record<string, any>} ev */
function formatText(cfg, ev) {
  let text = `[agenthook:${cfg.name}] ${ev.event} ${ev.ref}`;
  if (ev.name) text += ` "${ev.name}"`;
  if (ev.step) text += ` (step ${ev.step})`;
  if (ev.reason) text += `\n${ev.reason}`;
  if (ev.url) text += `\n${ev.url}`;
  return text;
}

/**
 * @param {import('./types.js').Config} cfg
 * @param {{ timeoutMs?: number, maxBacklog?: number }} [opts]
 * @returns {(ev: Record<string, any>) => void}
 */
export function createSinks(cfg, opts = {}) {
  const sinks = cfg.sinks ?? [];
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  const maxBacklog = opts.maxBacklog ?? MAX_BACKLOG;
  const states = sinks.map(() => ({ pending: /** @type {Array<{url: string, body: any, warn: (why: string) => void}>} */ ([]), busy: false, warnedFull: false }));

  /** @param {import('./types.js').SinkConfig} s @param {Record<string, any>} ev */
  function request(s, ev) {
    if (s.type === "slack") return { url: s.url, body: { text: formatText(cfg, ev) } };
    if (s.type === "telegram") {
      return {
        url: `https://api.telegram.org/bot${s.botToken}/sendMessage`,
        body: { chat_id: s.chatId, text: formatText(cfg, ev), disable_web_page_preview: true },
      };
    }
    return { url: s.url, body: { ...ev, profile: cfg.name } };
  }

  /** @param {{ pending: any[], busy: boolean, warnedFull: boolean }} state */
  function pump(state) {
    if (state.busy) return;
    const entry = state.pending.shift();
    if (!entry) return;
    if (state.pending.length === 0) state.warnedFull = false;
    state.busy = true;
    const { url, body, warn } = entry;
    const settle = () => {
      state.busy = false;
      pump(state);
    };
    let sent;
    try {
      sent = fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      warn("send failed");
      settle();
      return;
    }
    Promise.resolve(sent)
      .then((res) => {
        if (!res.ok) warn(`HTTP ${res.status}`);
      })
      .catch((e) => warn(e?.name === "TimeoutError" ? "timed out" : "request failed"))
      .finally(settle);
  }

  return function onEvent(ev) {
    sinks.forEach((s, i) => {
      if (!(s.events ?? DEFAULT_SINK_EVENTS).includes(ev.event)) return;
      // Never log the URL/token: only the sink type and a sanitized error.
      const warn = (/** @type {string} */ why) => console.warn(`[sinks] ${s.type} "${ev.event}" ${ev.ref}: ${why}`);
      let built;
      try {
        built = request(s, ev);
      } catch {
        warn("send failed");
        return;
      }
      const state = states[i];
      state.pending.push({ url: /** @type {string} */ (built.url), body: built.body, warn });
      if (state.pending.length > maxBacklog) {
        state.pending.shift();
        if (!state.warnedFull) {
          state.warnedFull = true;
          console.warn(`[sinks] ${s.type} backlog full, dropping`);
        }
      }
      pump(state);
    });
  };
}
