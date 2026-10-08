import type { UiEvent } from "./contract";

const EVENT_TYPES: UiEvent["type"][] = ["profile", "profile_removed", "ticket", "ticket_removed", "event", "instructions", "config"];

/**
 * Realtime SSE feed off `GET /api/stream` (same-origin, so the auth cookie rides
 * along automatically). Reconnection is the browser's built-in EventSource retry —
 * no setInterval/setTimeout polling here.
 */
export function subscribe(opts: {
  onOpen?: () => void;
  onError?: () => void;
  onClosed?: () => void;
  onEvent: (e: UiEvent) => void;
}): () => void {
  const es = new EventSource("/api/stream");
  if (opts.onOpen) es.addEventListener("open", opts.onOpen);
  es.addEventListener("error", () => {
    // readyState CLOSED means the browser gave up (e.g. a 401) — it will not retry.
    if (es.readyState === EventSource.CLOSED) opts.onClosed?.();
    else opts.onError?.();
  });
  for (const type of EVENT_TYPES) {
    es.addEventListener(type, (ev: MessageEvent) => {
      try {
        opts.onEvent(JSON.parse(ev.data));
      } catch {
        /* ignore an unparseable frame */
      }
    });
  }
  return () => es.close();
}
