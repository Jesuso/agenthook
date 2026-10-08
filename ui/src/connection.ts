// The app bar's connection dot, derived from App's two stream flags (stream.ts): `connected`
// (the EventSource is open) and `closed` (it gave up for good, e.g. a 401 — no more retries).
export type ConnectionState = "connected" | "reconnecting" | "closed";

/** Closed wins; otherwise open → connected, and anything else — including before the first open — is reconnecting. */
export function connectionState(connected: boolean, closed: boolean): ConnectionState {
  if (closed) return "closed";
  return connected ? "connected" : "reconnecting";
}

export const CONNECTION_LABEL: Record<ConnectionState, string> = {
  connected: "Live",
  reconnecting: "Reconnecting…",
  closed: "Disconnected — reload",
};
