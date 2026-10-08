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

/** "2026-10-08" / "?" — the date part of an ISO timestamp. */
export function formatDate(iso: string | null): string {
  if (!iso || Number.isNaN(Date.parse(iso))) return "?";
  return new Date(iso).toISOString().slice(0, 10);
}

/** The provenance badge under a profile's name: a ghost wins over a missing config; else none. */
export function profileBadge(
  p: Pick<ProfileView, "name" | "label" | "ghost" | "configMissing" | "configPath" | "createdAt">,
): { kind: "ghost" | "missing"; text: string; title: string } | null {
  if (p.ghost) {
    return {
      kind: "ghost",
      text: "never ran",
      title: `created ${formatDate(p.createdAt)} by a command that read a config named ${p.label || p.name}; safe to remove`,
    };
  }
  if (p.configMissing) return { kind: "missing", text: "config missing", title: `${p.configPath ?? "the config file"} no longer exists` };
  return null;
}

/** "45s" / "3m 12s" / "1h 04m" / "—" for null, negative, or non-finite. */
export function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return "—";
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${String(secs % 60).padStart(2, "0")}s`;
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, "0")}m`;
}
