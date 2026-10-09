import type { ProfileView, TicketRow } from "./contract";

/** "up" / "down" — the profile row's liveness cell; pid and port only in its tooltip. */
export function formatUp(p: Pick<ProfileView, "up" | "pid" | "port">): { text: string; title?: string } {
  const parts = [p.up && p.pid ? `pid ${p.pid}` : null, p.port ? `port ${p.port}` : null].filter(Boolean);
  return { text: p.up ? "up" : "down", title: parts.length ? parts.join(" · ") : undefined };
}

/** The profile's display name: its label, "label (stateKey)" when they differ. `name` stays the key. */
export function profileLabel(p: Pick<ProfileView, "name" | "label">): string {
  return p.label && p.label !== p.name ? `${p.label} (${p.name})` : p.name;
}

const LAST_EVENT_VERB: Record<string, string> = { pipeline: "picked up", merge: "merged", ci: "CI failed" };

/** Long refs (e.g. a 16-digit Asana gid) shorten to "…" + the last 6 chars, with the full ref as a tooltip. */
export function shortRef(ref: string): { text: string; title?: string } {
  if (ref.length <= 8) return { text: ref };
  return { text: `…${ref.slice(-6)}`, title: ref };
}

/** "<verb> <id> · <step> · <relative>" / "—" — the profile row's last-event cell. */
export function formatLastEvent(e: ProfileView["lastEvent"], displayId: string | null, now: number): { text: string; title?: string } {
  if (!e) return { text: "—" };
  const verb = e.kind ? LAST_EVENT_VERB[e.kind] ?? e.kind : "event";
  let id = "?";
  let title: string | undefined;
  if (e.ref) {
    if (displayId && displayId !== e.ref) {
      id = displayId;
    } else {
      const short = shortRef(e.ref);
      id = short.text;
      title = short.title;
    }
  }
  const step = e.step ? ` · ${e.step}` : "";
  return { text: `${verb} ${id}${step} · ${formatRelative(e.at, now)}`, title };
}

/** The title cell's text + whether it's a placeholder for a title not yet cached. */
export function ticketTitle(t: Pick<TicketRow, "title">): { text: string; unknown: boolean } {
  if (t.title) return { text: t.title, unknown: false };
  return { text: "(title unknown — appears after its next run)", unknown: true };
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
