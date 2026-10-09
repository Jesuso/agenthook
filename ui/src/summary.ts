import type { Snapshot, TicketStatus } from "./contract";

/** The ticket statuses that want a human: the "needs you" tile and its ticket filter. */
export const NEEDS_YOU: TicketStatus[] = ["held", "failed"];

export type Summary = {
  /** Σ active / Σ maxConcurrent over up profiles (null → 0). */
  active: number;
  capacity: number;
  /** Tickets whose status is in NEEDS_YOU. */
  needsYou: number;
  /** Σ queued over up profiles (null → 0). */
  queued: number;
  /** Σ recentCosts since the local midnight of `now`, across every profile. */
  costToday: number;
  up: number;
  down: number;
};

/** The dashboard's summary strip over one snapshot. */
export function summarize(snapshot: Snapshot, now: number): Summary {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const since = midnight.getTime();
  const s: Summary = { active: 0, capacity: 0, needsYou: 0, queued: 0, costToday: 0, up: 0, down: 0 };
  for (const p of snapshot.profiles) {
    if (p.up) {
      s.up++;
      s.active += p.active ?? 0;
      s.capacity += p.maxConcurrent ?? 0;
      s.queued += p.queued ?? 0;
    } else {
      s.down++;
    }
    for (const c of p.recentCosts ?? []) {
      const t = Date.parse(c.at);
      if (!Number.isNaN(t) && t >= since && Number.isFinite(c.costUsd)) s.costToday += c.costUsd;
    }
  }
  for (const t of snapshot.tickets) if (NEEDS_YOU.includes(t.status)) s.needsYou++;
  return s;
}
