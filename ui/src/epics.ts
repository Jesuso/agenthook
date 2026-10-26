import type { EpicBucket, EpicDetailTicket, EpicResponse, EpicStats, EpicsResponse } from "./contract";
import { shortDate } from "./stats";
import { translate } from "./i18n";
import type { MessageKey } from "./i18n";
import type { Route } from "./route";

/** A ticket SSE event for the profile refetches the open epics view after this quiet period — a
 * debounce, not a poll: nothing fires without an event. */
export const REFETCH_DEBOUNCE_MS = 2000;

/** Whether an `epic_changed` event (events.jsonl line) from `profile` refetches the open view: the
 * profile's Epics list on any epic, one epic's page only when it is that epic. */
export function epicChangedRefetches(route: Route, profile: string, event: Record<string, unknown>): boolean {
  if (event.event !== "epic_changed") return false;
  if (route.kind !== "profile" || route.view !== "epics" || route.profile !== profile) return false;
  return route.epic === undefined || route.epic === String(event.ref ?? "");
}

/** `GET /api/epics[/<ref>]` for the profile; `tz` as `/api/stats` (statsUrl): this browser's
 * `getTimezoneOffset()`, so velocity days cut at local midnight. */
export function epicsUrl(profile: string, ref: string | null = null, tzOffset: number = new Date().getTimezoneOffset()): string {
  const path = ref === null ? "/api/epics" : `/api/epics/${encodeURIComponent(ref)}`;
  return `${path}?profile=${encodeURIComponent(profile)}&tz=${tzOffset}`;
}

/** A failed read keeps the server's `error` so a view can rebuild `message` in its language (epicsError). */
export type Loaded<T> = { kind: "ok"; body: T } | { kind: "error"; status: number; error: string | null; message: string };

/**
 * The inline message for a failed epics read (docs/web-ui.md § Epics data). `detail` = one epic's
 * page. The server's `error` goes into the sentence as written.
 */
export function epicsError(status: number, error: string | null, detail: boolean, lang = "en"): string {
  if (status === 404) return translate(lang, detail ? "epics.error.noEpic" : "epics.error.unknownProfile");
  if (status === 400) return translate(lang, "epics.error.badRef");
  if (status === 502) return error ? translate(lang, "epics.error.trackerDetail", { error }) : translate(lang, "epics.error.tracker");
  if (status === 503) return translate(lang, "epics.error.down");
  if (status === 504) return translate(lang, "epics.error.timeout");
  if (status === 0) return translate(lang, "epics.error.unreachable");
  return translate(lang, "epics.error.status", { status });
}

async function load<T>(url: string, detail: boolean, fetchImpl: typeof fetch): Promise<Loaded<T>> {
  try {
    const res = await fetchImpl(url);
    if (res.ok) return { kind: "ok", body: (await res.json()) as T };
    const error = await res.json().then((b: { error?: unknown }) => (typeof b?.error === "string" ? b.error : null), () => null);
    return { kind: "error", status: res.status, error, message: epicsError(res.status, error, detail) };
  } catch {
    return { kind: "error", status: 0, error: null, message: epicsError(0, null, detail) };
  }
}

/** Every epic of the profile, with stats. */
export const fetchEpics = (profile: string, fetchImpl: typeof fetch = fetch) => load<EpicsResponse>(epicsUrl(profile), false, fetchImpl);

/** One epic with its tickets. */
export const fetchEpic = (profile: string, ref: string, fetchImpl: typeof fetch = fetch) => load<EpicResponse>(epicsUrl(profile, ref), true, fetchImpl);

/** The stage bar's segments, left to right: done work first, the untracked tail last. */
export const BUCKET_ORDER: EpicBucket[] = ["merged", "finished", "running", "needsYou", "backlog", "untracked"];

/** Each bucket's label as a dictionary key (merged/finished are plural forms: pass `count`). */
export const BUCKET_LABEL: Record<EpicBucket, MessageKey> = {
  merged: "epics.bucket.merged",
  finished: "epics.bucket.finished",
  running: "epics.bucket.running",
  needsYou: "epics.bucket.needsYou",
  backlog: "epics.bucket.backlog",
  untracked: "epics.bucket.untracked",
};

/** N/M: N = finished + merged, M = every ticket. */
export function progressOf(e: Pick<EpicStats, "byStage" | "total">): { done: number; total: number } {
  return { done: e.byStage.finished + e.byStage.merged, total: e.total };
}

/** One stage-bar segment per non-empty bucket, `pct` of the epic's tickets (0 tickets → none). */
export function stageSegments(e: Pick<EpicStats, "byStage" | "total">): { bucket: EpicBucket; count: number; pct: number }[] {
  if (e.total <= 0) return [];
  return BUCKET_ORDER.filter((b) => e.byStage[b] > 0).map((b) => ({ bucket: b, count: e.byStage[b], pct: (e.byStage[b] / e.total) * 100 }));
}

/** Open epics in attention order — most tickets needing you, then any running, then ready to
 * close, then the server's order — then completed ones (shown collapsed). Ready to close is not
 * Needs you (CONTEXT.md), so it never outranks an epic with tickets waiting on the human. */
export function splitCompleted<T extends Pick<EpicStats, "completed" | "readyToClose" | "needsYou" | "byStage">>(epics: T[]): { open: T[]; completed: T[] } {
  const rank = (e: T) => (e.needsYou.length > 0 ? 0 : e.byStage.running > 0 ? 1 : e.readyToClose ? 2 : 3);
  const open = epics
    .filter((e) => !e.completed)
    .map((e, i) => ({ e, i }))
    .sort((a, b) => rank(a.e) - rank(b.e) || b.e.needsYou.length - a.e.needsYou.length || a.i - b.i)
    .map(({ e }) => e);
  return { open, completed: epics.filter((e) => e.completed) };
}

/** "~3 d · Oct 19"; null without an ETA. */
export function etaLabel(eta: EpicStats["eta"], lang = "en"): string | null {
  return eta ? `~${eta.days} d · ${shortDate(eta.date, lang)}` : null;
}

/** "0.4/day" — finished per day over the velocity window; "—" when nothing finished. */
export function perDayLabel(perDay: number | null, lang = "en"): string {
  return perDay === null ? "—" : translate(lang, "epics.perDay", { n: perDay >= 10 ? Math.round(perDay) : Math.round(perDay * 10) / 10 });
}

/** An epic's tracker URL when it is http(s), else null (never render another scheme as a link). */
export const safeUrl = (url: string | null | undefined): string | null => (url && /^https?:\/\//i.test(url) ? url : null);

/** The epic's tickets per bucket, each keeping the server's order. */
export function groupTickets(tickets: EpicDetailTicket[]): Record<EpicBucket, EpicDetailTicket[]> {
  const out: Record<EpicBucket, EpicDetailTicket[]> = { backlog: [], running: [], needsYou: [], finished: [], merged: [], untracked: [] };
  for (const t of tickets) (out[t.bucket] ?? out.untracked).push(t);
  return out;
}
