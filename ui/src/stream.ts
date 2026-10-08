import type { UiEvent } from "./contract";

// Typed stub for the realtime SSE feed. `GET /api/stream` doesn't exist yet (#134 —
// the directory-watcher + SSE ticket); opening an EventSource against it would just
// 404-loop. Once #134 lands, this becomes `new EventSource('/api/stream')` wired to
// `onEvent`. Until then, callers get a no-op unsubscribe and rely on `/api/snapshot`.
export function subscribe(_onEvent: (e: UiEvent) => void): () => void {
  return () => {};
}
