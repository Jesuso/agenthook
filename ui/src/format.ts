import type { ProfileView } from "./contract";

/** "up (pid 1234)" / "down" — the profile row's liveness cell. */
export function formatUp(p: Pick<ProfileView, "up" | "pid">): string {
  return p.up ? `up (pid ${p.pid})` : "down";
}

/** The profile's display name: its label, "label (stateKey)" when they differ. `name` stays the key. */
export function profileLabel(p: Pick<ProfileView, "name" | "label">): string {
  return p.label && p.label !== p.name ? `${p.label} (${p.name})` : p.name;
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

/** "5m ago" / "3h ago" / "2d ago" / "—" for null, invalid, or future-skewed timestamps. */
export function formatRelative(iso: string | null, now: number): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const diffMs = now - t;
  if (diffMs < 0) return "—";
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/** "$0.57" / "—" for zero or non-finite. */
export function formatCost(n: number): string {
  if (!Number.isFinite(n) || n === 0) return "—";
  return `$${n.toFixed(2)}`;
}
