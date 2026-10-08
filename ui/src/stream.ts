import type { UiEvent } from "./contract";

const EVENT_TYPES: UiEvent["type"][] = ["profile", "profile_removed", "ticket", "ticket_removed", "event"];

/**
 * Realtime SSE feed off `GET /api/stream` (same-origin, so the auth cookie rides
 * along automatically). Reconnection is the browser's built-in EventSource retry —
 * no setInterval/setTimeout polling here.
 */
export function subscribe(opts: { onOpen?: () => void; onError?: () => void; onEvent: (e: UiEvent) => void }): () => void {
  const es = new EventSource("/api/stream");
  if (opts.onOpen) es.addEventListener("open", opts.onOpen);
  if (opts.onError) es.addEventListener("error", opts.onError);
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
