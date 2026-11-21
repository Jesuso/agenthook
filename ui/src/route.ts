/** The views inside one profile; `overview` is the profile's dashboard, `stats` its deeper history. */
export type View = "overview" | "stats" | "epics" | "instructions" | "config";
export const VIEWS: View[] = ["overview", "stats", "epics", "instructions", "config"];

/** Where the app is: the Home grid of profile cards, or one profile's view. `epic` (only with
 * `view:"epics"`) is one epic's page. `ticket` (the `?t=` query) is the profile's open drawer. */
export type Route = { kind: "home" } | { kind: "profile"; profile: string; view: View; epic?: string; ticket?: string };

export const HOME: Route = { kind: "home" };

/** `#/` → Home; `#/p/<stateKey>[/<view>]` → that profile; `#/p/<stateKey>/epics/<ref>` → one epic;
 * a `?t=<ref>` query (any profile view, ignored on Home) → that profile's open ticket. The path is
 * unparseable → Home; an empty or malformed `t` → the route without it, never Home. */
export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#/, "");
  const q = raw.indexOf("?");
  const path = q === -1 ? raw : raw.slice(0, q);
  const parts = path.split("/").filter(Boolean);
  if (parts[0] !== "p" || !parts[1]) return HOME;
  let profile: string;
  let epic: string | undefined;
  try {
    profile = decodeURIComponent(parts[1]);
    if (parts.length === 4 && parts[2] === "epics") epic = decodeURIComponent(parts[3]);
  } catch {
    return HOME;
  }
  const view = (parts[2] ?? "overview") as View;
  if (!VIEWS.includes(view) || parts.length > (epic !== undefined ? 4 : 3)) return HOME;
  const route: Route = epic !== undefined ? { kind: "profile", profile, view, epic } : { kind: "profile", profile, view };
  if (q === -1) return route;
  const t = raw.slice(q + 1).split("&").find((kv) => kv.startsWith("t="));
  if (t === undefined || t.length <= 2) return route; // other keys are ignored; `?t=` is absent
  try {
    route.ticket = decodeURIComponent(t.slice(2));
  } catch {
    /* a malformed `t` parses as if it were absent */
  }
  return route;
}

/** The inverse of parseHash; `overview` has no suffix; an open ticket rides as `?t=<ref>`. */
export function hashFor(route: Route): string {
  if (route.kind === "home") return "#/";
  const base = `#/p/${encodeURIComponent(route.profile)}`;
  const path = route.view === "epics" && route.epic !== undefined ? `${base}/epics/${encodeURIComponent(route.epic)}` : route.view === "overview" ? base : `${base}/${route.view}`;
  return route.ticket !== undefined ? `${path}?t=${encodeURIComponent(route.ticket)}` : path;
}
export function sameRoute(a: Route, b: Route): boolean {
  if (!sameBase(a, b)) return false;
  return (a.kind === "profile" ? a.ticket : undefined) === (b.kind === "profile" ? b.ticket : undefined);
}

/** sameRoute minus the ticket — the compare for "did the page change": a ticket-only hash change
 * is not a view or profile change, so it skips the discard prompt and the filter reset. */
export function sameBase(a: Route, b: Route): boolean {
  if (a.kind === "home" || b.kind === "home") return a.kind === b.kind;
  return a.profile === b.profile && a.view === b.view && a.epic === b.epic;
}

/** `r` with the open ticket dropped (a no-op off a profile or without one). */
export function withoutTicket(r: Route): Route {
  if (r.kind !== "profile" || r.ticket === undefined) return r;
  const { ticket: _ticket, ...rest } = r;
  return rest;
}
