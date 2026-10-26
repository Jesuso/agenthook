// The app bar's connection dot, derived from App's two stream flags (stream.ts): `connected`
// (the EventSource is open) and `closed` (it gave up for good, e.g. a 401 — no more retries).
import { translate } from "./i18n";
import type { MessageKey } from "./i18n";

export type ConnectionState = "connected" | "reconnecting" | "closed";

/** Closed wins; otherwise open → connected, and anything else — including before the first open — is reconnecting. */
export function connectionState(connected: boolean, closed: boolean): ConnectionState {
  if (closed) return "closed";
  return connected ? "connected" : "reconnecting";
}

const CONNECTION_KEY: Record<ConnectionState, MessageKey> = {
  connected: "connection.connected",
  reconnecting: "connection.reconnecting",
  closed: "connection.closed",
};

/** The dot's words in `lang` (#561). */
export const connectionLabel = (state: ConnectionState, lang = "en"): string => translate(lang, CONNECTION_KEY[state]);

/** The English labels. */
export const CONNECTION_LABEL: Record<ConnectionState, string> = {
  connected: connectionLabel("connected"),
  reconnecting: connectionLabel("reconnecting"),
  closed: connectionLabel("closed"),
};
