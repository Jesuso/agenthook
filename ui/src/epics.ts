import type { EpicBucket, EpicDetailTicket, EpicResponse, EpicStats, EpicsResponse } from "./contract";
import { shortDate } from "./stats";
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

export type Loaded<T> = { kind: "ok"; body: T } | { kind: "error"; status: number; message: string };

/** The inline message for a failed epics read (docs/web-ui.md § Epics data). `detail` = one epic's page. */
export function epicsError(status: number, error: string | null, detail: boolean): string {
  if (status === 404) return detail ? "No such epic on this profile." : "Unknown profile.";
  if (status === 400) return "Bad epic reference.";
  if (status === 502) return `The receiver couldn't read the tracker${error ? `: ${error}` : ""}.`;
  if (status === 503) return "The receiver isn't running.";
  if (status === 504) return "The tracker read timed out — try Refresh.";
  if (status === 0) return "Dashboard unreachable.";
  return `Couldn't load epics (status ${status}).`;
}

async function load<T>(url: string, detail: boolean, fetchImpl: typeof fetch): Promise<Loaded<T>> {
  try {
    const res = await fetchImpl(url);
    if (res.ok) return { kind: "ok", body: (await res.json()) as T };
    const error = await res.json().then((b: { error?: unknown }) => (typeof b?.error === "string" ? b.error : null), () => null);
    return { kind: "error", status: res.status, message: epicsError(res.status, error, detail) };
  } catch {
    return { kind: "error", status: 0, message: epicsError(0, null, detail) };
  }
}

/** Every epic of the profile, with stats. */
export const fetchEpics = (profile: string, fetchImpl: typeof fetch = fetch) => load<EpicsResponse>(epicsUrl(profile), false, fetchImpl);

/** One epic with its tickets. */
export const fetchEpic = (profile: string, ref: string, fetchImpl: typeof fetch = fetch) => load<EpicResponse>(epicsUrl(profile, ref), true, fetchImpl);

/** The stage bar's segments, left to right: done work first, the untracked tail last. */
export const BUCKET_ORDER: EpicBucket[] = ["merged", "finished", "running", "needsYou", "backlog", "untracked"];

export const BUCKET_LABEL: Record<EpicBucket, string> = {
  merged: "merged",
  finished: "finished",
  running: "running",
  needsYou: "needs you",
  backlog: "backlog",
  untracked: "untracked",
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

/** Open epics in the server's order, then completed ones (shown collapsed). */
export function splitCompleted<T extends Pick<EpicStats, "completed">>(epics: T[]): { open: T[]; completed: T[] } {
  return { open: epics.filter((e) => !e.completed), completed: epics.filter((e) => e.completed) };
}

/** "~3 d · Oct 19"; null without an ETA. */
export function etaLabel(eta: EpicStats["eta"]): string | null {
  return eta ? `~${eta.days} d · ${shortDate(eta.date)}` : null;
}

/** "0.4/day" — finished per day over the velocity window; "—" when nothing finished. */
export function perDayLabel(perDay: number | null): string {
  return perDay === null ? "—" : `${perDay >= 10 ? Math.round(perDay) : Math.round(perDay * 10) / 10}/day`;
}

/** An epic's tracker URL when it is http(s), else null (never render another scheme as a link). */
export const safeUrl = (url: string | null | undefined): string | null => (url && /^https?:\/\//i.test(url) ? url : null);

/** The epic page's sections below Needs you, in order. */
export const GROUP_ORDER: EpicBucket[] = ["running", "backlog", "finished", "merged"];

/** The epic's tickets per bucket, each keeping the server's order. */
export function groupTickets(tickets: EpicDetailTicket[]): Record<EpicBucket, EpicDetailTicket[]> {
  const out: Record<EpicBucket, EpicDetailTicket[]> = { backlog: [], running: [], needsYou: [], finished: [], merged: [], untracked: [] };
  for (const t of tickets) (out[t.bucket] ?? out.untracked).push(t);
  return out;
}
