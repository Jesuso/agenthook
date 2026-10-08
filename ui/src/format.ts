import type { ProfileView } from "./contract";

/** "up (pid 1234)" / "down" — the profile row's liveness cell. */
export function formatUp(p: Pick<ProfileView, "up" | "pid">): string {
  return p.up ? `up (pid ${p.pid})` : "down";
}

/** "kind ref/step" / "—" — the profile row's last-event cell. */
export function formatLastEvent(e: ProfileView["lastEvent"]): string {
  if (!e) return "—";
  return `${e.kind ?? "?"} ${e.ref ?? "?"}/${e.step ?? "?"}`;
}

/** "active / maxConcurrent" — null on either side renders as "—". */
export function formatAgents(p: Pick<ProfileView, "active" | "maxConcurrent">): string {
  return `${p.active ?? "—"} / ${p.maxConcurrent ?? "—"}`;
}
