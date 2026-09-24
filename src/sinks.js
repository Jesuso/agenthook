// Human-attention sinks: forward selected lifecycle events (see events.js) to Slack,
// Telegram, or a generic webhook. Best-effort and fire-and-forget — a sink never
// throws into, blocks, or changes the outcome of the pipeline. No retries/queuing.

const DEFAULT_EVENTS = ["blocked", "failed", "pipeline_done"];
const TIMEOUT_MS = 5000;

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
 * @returns {(ev: Record<string, any>) => void}
 */
export function createSinks(cfg) {
  const sinks = cfg.sinks ?? [];

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

  return function onEvent(ev) {
    for (const s of sinks) {
      if (!(s.events ?? DEFAULT_EVENTS).includes(ev.event)) continue;
      // Never log the URL/token: only the sink type and a sanitized error.
      const warn = (/** @type {string} */ why) => console.warn(`[sinks] ${s.type} "${ev.event}" ${ev.ref}: ${why}`);
      try {
        const { url, body } = request(s, ev);
        Promise.resolve(
          fetch(/** @type {string} */ (url), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(TIMEOUT_MS),
          }),
        )
          .then((res) => {
            if (!res.ok) warn(`HTTP ${res.status}`);
          })
          .catch((e) => warn(e?.name === "TimeoutError" ? "timed out" : "request failed"));
      } catch {
        warn("send failed");
      }
    }
  };
}
