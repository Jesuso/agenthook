import type { ProfileView, TicketRow } from "./contract";

import { formatSpend } from "../../src/pricing.js";
import { formatEnergy } from "../../src/energy.js";
import { formatQuota } from "../../src/quota.js";
import type { QuotaTrip } from "./contract";
import { translate } from "./i18n";
import type { MessageKey } from "./i18n";

// Every helper that makes words takes a trailing `lang` (#561), default "en" so untranslated views and
// tests are unchanged. English keeps its hand-built path verbatim (never ICU-dependent); other languages
// use Intl and the dictionaries. The re-exported src/ formatters are shared with the CLI and stay English.

/** "$12.40 + ~$3.10 est." — reported and estimated spend side by side, never summed (src/pricing.js). */
export { formatSpend };

/** "up" / "down" — the profile row's liveness cell; pid and port only in its tooltip. */
export function formatUp(p: Pick<ProfileView, "up" | "pid" | "port">, lang = "en"): { text: string; title?: string } {
  const parts = [p.up && p.pid ? `pid ${p.pid}` : null, p.port ? `port ${p.port}` : null].filter(Boolean);
  return { text: translate(lang, p.up ? "format.up" : "format.down"), title: parts.length ? parts.join(" · ") : undefined };
}

/** The profile's display name: its label, "label (stateKey)" when they differ. `name` stays the key. */
export function profileLabel(p: Pick<ProfileView, "name" | "label">): string {
  return p.label && p.label !== p.name ? `${p.label} (${p.name})` : p.name;
}

const LAST_EVENT_VERB: Record<string, MessageKey> = { pipeline: "lastEvent.pipeline", merge: "lastEvent.merge", ci: "lastEvent.ci" };

/** Long refs (e.g. a 16-digit Asana gid) shorten to "…" + the last 6 chars, with the full ref as a tooltip. */
export function shortRef(ref: string): { text: string; title?: string } {
  if (ref.length <= 8) return { text: ref };
  return { text: `…${ref.slice(-6)}`, title: ref };
}

/** "<verb> <id> · <step> · <relative>" / "—" — the profile row's last-event cell. */
export function formatLastEvent(e: ProfileView["lastEvent"], displayId: string | null, now: number, lang = "en"): { text: string; title?: string } {
  if (!e) return { text: "—" };
  const verb = e.kind ? (LAST_EVENT_VERB[e.kind] ? translate(lang, LAST_EVENT_VERB[e.kind]) : e.kind) : translate(lang, "lastEvent.event");
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
  return { text: `${verb} ${id}${step} · ${formatRelative(e.at, now, lang)}`, title };
}

/** The title cell's text + whether it's a placeholder for a title not yet cached. */
export function ticketTitle(t: Pick<TicketRow, "title">, lang = "en"): { text: string; unknown: boolean } {
  if (t.title) return { text: t.title, unknown: false };
  return { text: translate(lang, "ticket.titleUnknown"), unknown: true };
}

/** "opus 5.5" from "claude-opus-5-5", "sonnet 5" from "claude-sonnet-5"; bare aliases ("opus") and
 * unknown strings pass through; null → "—". The full id is the tooltip. */
export function formatModel(id: string | null): { text: string; title?: string } {
  if (!id) return { text: "—" };
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?$/.exec(id);
  return { text: m ? `${m[1]} ${m[2]}${m[3] ? `.${m[3]}` : ""}` : id, title: id };
}

/** "active / maxConcurrent" — null on either side renders as "—". */
export function formatAgents(p: Pick<ProfileView, "active" | "maxConcurrent">): string {
  return `${p.active ?? "—"} / ${p.maxConcurrent ?? "—"}`;
}

/** "5m ago" / "3h ago" / "2d ago" / "—" for null, invalid, or future-skewed timestamps; "hace 5 min" in es. */
export function formatRelative(iso: string | null, now: number, lang = "en"): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const diffMs = now - t;
  if (diffMs < 0) return "—";
  const mins = Math.floor(diffMs / 60000);
  if (lang !== "en") return intlRelative(mins, lang);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function intlRelative(mins: number, lang: string): string {
  if (mins < 1) return translate(lang, "time.justNow");
  const rtf = new Intl.RelativeTimeFormat(lang, { style: "narrow", numeric: "always" });
  if (mins < 60) return rtf.format(-mins, "minute");
  const hours = Math.floor(mins / 60);
  if (hours < 24) return rtf.format(-hours, "hour");
  return rtf.format(-Math.floor(hours / 24), "day");
}

/** "$0.57" / "—" for zero or non-finite; "0,57 US$" in es. */
export function formatCost(n: number, lang = "en"): string {
  if (!Number.isFinite(n) || n === 0) return "—";
  if (lang !== "en") return new Intl.NumberFormat(lang, { style: "currency", currency: "USD" }).format(n);
  return `$${n.toFixed(2)}`;
}

/**
 * A ticket's spend cell: "$1.20", "~$0.40 est.", "$1.20 + ~$0.40 est.", "—" when neither; a ticket
 * with measured runs (src/energy.js) appends " · energy $0.00029 (1.9 Wh)" — beside, never added.
 */
export function formatTicketSpend(t: Pick<TicketRow, "costUsd"> & Partial<Pick<TicketRow, "estUsd" | "energyKwh" | "energyUsd">>): string {
  const spend = formatSpend({ reported: Number.isFinite(t.costUsd) ? t.costUsd : 0, est: t.estUsd ?? 0 });
  const energy = formatEnergy(t);
  return spend && energy ? `${spend} · ${energy}` : spend || energy || "—";
}

/** "2026-10-08" / "?" — the date part of an ISO timestamp. */
export function formatDate(iso: string | null): string {
  if (!iso || Number.isNaN(Date.parse(iso))) return "?";
  return new Date(iso).toISOString().slice(0, 10);
}

/** The provenance badge under a profile's name: a ghost wins over a missing config; else none. */
export function profileBadge(
  p: Pick<ProfileView, "name" | "label" | "ghost" | "configMissing" | "configPath" | "createdAt">,
  lang = "en",
): { kind: "ghost" | "missing"; text: string; title: string } | null {
  if (p.ghost) {
    return {
      kind: "ghost",
      text: translate(lang, "badge.ghost"),
      title: translate(lang, "badge.ghostTitle", { date: formatDate(p.createdAt), name: p.label || p.name }),
    };
  }
  if (p.configMissing) return { kind: "missing", text: translate(lang, "badge.missing"), title: translate(lang, "badge.missingTitle", { path: p.configPath ?? translate(lang, "badge.theConfigFile") }) };
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

/**
 * A running agent's elapsed time, as precise as it is honest to tick (#579): "45s" each second for the
 * first minute, then "4m" / "1h 04m" each minute. A small negative (clock skew against startedAt) is 0s.
 * `coarse` (prefers-reduced-motion) skips the per-second phase: "<1m".
 */
export function formatElapsed(ms: number | null, coarse = false): string {
  if (ms === null || !Number.isFinite(ms)) return "—";
  const secs = Math.max(0, Math.floor(ms / 1000));
  if (secs < 60) return coarse ? "<1m" : `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, "0")}m`;
}

/** Milliseconds until `formatElapsed(elapsed)` next changes: the next second for the first minute, then the next minute. */
export function elapsedTickMs(elapsed: number, coarse = false): number {
  if (elapsed < 0) return Math.min(-elapsed, 1000);
  const step = elapsed < 60_000 && !coarse ? 1000 : 60_000;
  return step - (elapsed % step);
}

/** Milliseconds until `formatRelative` next changes: the next minute, hour, then day boundary since `t`. */
export function relativeTickMs(elapsed: number): number {
  if (elapsed < 0) return Math.min(-elapsed, 60_000);
  const step = elapsed < 3_600_000 ? 60_000 : elapsed < 86_400_000 ? 3_600_000 : 86_400_000;
  return step - (elapsed % step);
}

/** The Claude quota readout, e.g. `weekly 65% · resets in 2d 4h · 5h 8% (as of 3m ago)` (src/quota.js). */
export { formatQuota };

/** The "quota paused" badge's tooltip. */
export function quotaPausedTitle(t: QuotaTrip, lang = "en"): string {
  const win = translate(lang, t.window === "sevenDay" ? "quota.weekly" : "quota.fiveHour");
  return translate(lang, "quota.pausedTitle", { window: win, used: Math.round(t.utilization * 100), threshold: Math.round(t.threshold * 100), resetsAt: t.resetsAt });
}
