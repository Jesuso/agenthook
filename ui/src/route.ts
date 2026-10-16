/** The views inside one profile; `overview` is the profile's dashboard, `stats` its deeper history. */
export type View = "overview" | "stats" | "epics" | "instructions" | "config";
export const VIEWS: View[] = ["overview", "stats", "epics", "instructions", "config"];

/** Where the app is: the Home grid of profile cards, or one profile's view. `epic` (only with
 * `view:"epics"`) is one epic's page. */
export type Route = { kind: "home" } | { kind: "profile"; profile: string; view: View; epic?: string };

export const HOME: Route = { kind: "home" };

/** `#/` → Home; `#/p/<stateKey>[/<view>]` → that profile; `#/p/<stateKey>/epics/<ref>` → one epic.
 * Anything unparseable falls back to Home. */
export function parseHash(hash: string): Route {
  const path = hash.replace(/^#/, "");
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
  return epic !== undefined ? { kind: "profile", profile, view, epic } : { kind: "profile", profile, view };
}

/** The inverse of parseHash; `overview` has no suffix. */
export function hashFor(route: Route): string {
  if (route.kind === "home") return "#/";
  const base = `#/p/${encodeURIComponent(route.profile)}`;
  if (route.view === "epics" && route.epic !== undefined) return `${base}/epics/${encodeURIComponent(route.epic)}`;
  return route.view === "overview" ? base : `${base}/${route.view}`;
}

export function sameRoute(a: Route, b: Route): boolean {
  if (a.kind === "home" || b.kind === "home") return a.kind === b.kind;
  return a.profile === b.profile && a.view === b.view && a.epic === b.epic;
}
