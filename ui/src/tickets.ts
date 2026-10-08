import type { TicketRow, TicketStatus } from "./contract";

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

/** running → queued → held → failed → done (newest first) → idle; stable by profile, ref. */
export function sortTickets(rows: TicketRow[]): TicketRow[] {
  return [...rows].sort((a, b) => {
    const rankA = STATUS_ORDER.indexOf(a.status);
    const rankB = STATUS_ORDER.indexOf(b.status);
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

export type TicketFilter = { profile: string | null; status: TicketStatus | null; showAll: boolean; now: number };

export function filterTickets(rows: TicketRow[], filter: TicketFilter): TicketRow[] {
  return rows.filter((r) => {
    if (filter.profile && r.profile !== filter.profile) return false;
    if (filter.status && r.status !== filter.status) return false;
    if (!filter.showAll && isStale(r, filter.now)) return false;
    return true;
  });
}

/** "230" from ".../pull/230" — the PR number of a `TicketRow.prUrl`; null when it isn't one. */
export function prNumber(prUrl: string | null): string | null {
  return (prUrl && /\/pull\/(\d+)\/?$/.exec(prUrl)?.[1]) || null;
}
