import type { TicketRow, TicketStatus } from "./contract";
import { NEEDS_YOU } from "./summary";

export const STATUS_ORDER: TicketStatus[] = ["running", "queued", "held", "interrupted", "stalled", "failed", "done", "idle"];

const STALE_MS = 24 * 60 * 60 * 1000;

/** `done`/`idle` rows with no `startedAt` or older than 24h are stale; others never are
 * (`interrupted`/`stalled` included — a down profile's leftovers stay visible). */
export function isStale(row: Pick<TicketRow, "status" | "startedAt">, now: number): boolean {
  if (row.status !== "done" && row.status !== "idle") return false;
  if (!row.startedAt) return true;
  const t = Date.parse(row.startedAt);
  if (Number.isNaN(t)) return true;
  return now - t > STALE_MS;
}

/** Rows pinned to the top of the table as one group: they want a human (or a receiver restart).
 * Wider than NEEDS_YOU — `interrupted` is pinned and tinted but not counted by the tile/filter. */
export const PINNED: TicketStatus[] = ["held", "failed", "interrupted"];

/** The order after the pinned group. */
const REST_ORDER: TicketStatus[] = ["running", "queued", "stalled", "done", "idle"];

const rank = (s: TicketStatus) => (PINNED.includes(s) ? 0 : 1 + REST_ORDER.indexOf(s));

/** held/failed/interrupted (one group) → running → queued → stalled → done → idle; newest first
 * within a group, then stable by profile, ref. */
export function sortTickets(rows: TicketRow[]): TicketRow[] {
  return [...rows].sort((a, b) => {
    const rankA = rank(a.status);
    const rankB = rank(b.status);
    if (rankA !== rankB) return rankA - rankB;
    const ta = a.startedAt ? Date.parse(a.startedAt) : NaN;
    const tb = b.startedAt ? Date.parse(b.startedAt) : NaN;
    const aValid = !Number.isNaN(ta);
    const bValid = !Number.isNaN(tb);
    if (aValid && bValid && ta !== tb) return tb - ta;
    if (aValid !== bValid) return aValid ? -1 : 1;
    if (a.profile !== b.profile) return a.profile.localeCompare(b.profile);
    return a.ref.localeCompare(b.ref);
  });
}

/** One status, `"needs-you"` (any of NEEDS_YOU: held + failed), or null for all. */
export type StatusFilter = TicketStatus | "needs-you";

export type TicketFilter = { profile: string | null; status: StatusFilter | null; showAll: boolean; now: number };

export function filterTickets(rows: TicketRow[], filter: TicketFilter): TicketRow[] {
  return rows.filter((r) => {
    if (filter.profile && r.profile !== filter.profile) return false;
    if (filter.status === "needs-you" ? !NEEDS_YOU.includes(r.status) : filter.status && r.status !== filter.status) return false;
    if (!filter.showAll && isStale(r, filter.now)) return false;
    return true;
  });
}

/** "230" from ".../pull/230" — the PR number of a `TicketRow.prUrl`; null when it isn't one. */
export function prNumber(prUrl: string | null): string | null {
  return (prUrl && /\/pull\/(\d+)\/?$/.exec(prUrl)?.[1]) || null;
}

export type StatusCounts = { all: number; "needs-you": number } & Record<TicketStatus, number>;

/** Per-chip counts for the status filter: over the rows the profile + stale filters keep, before
 * the status filter (so every chip shows what clicking it would list). */
export function statusCounts(rows: TicketRow[], filter: Omit<TicketFilter, "status">): StatusCounts {
  const counts = { all: 0, "needs-you": 0, ...Object.fromEntries(STATUS_ORDER.map((s) => [s, 0])) } as StatusCounts;
  for (const r of filterTickets(rows, { ...filter, status: null })) {
    counts.all++;
    counts[r.status]++;
    if (NEEDS_YOU.includes(r.status)) counts["needs-you"]++;
  }
  return counts;
}

/** Rows the table renders per page; "show more" adds another page. */
export const PAGE_SIZE = 50;

/** The table's row limit, tagged with the filters it was grown under. */
export type Page = { key: string; limit: number };

/** The limit to render under filter `key`: a page grown under other filters resets to one page. */
export function pageLimit(page: Page, key: string): number {
  return page.key === key ? page.limit : PAGE_SIZE;
}

/** One more page under filter `key`. */
export function showMore(page: Page, key: string): Page {
  return { key, limit: pageLimit(page, key) + PAGE_SIZE };
}
