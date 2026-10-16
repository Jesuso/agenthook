import type { Snapshot, TicketRow, TicketStatus } from "./contract";

/** The ticket statuses that always want a human: held and failed. */
export const NEEDS_YOU: TicketStatus[] = ["held", "failed"];

/**
 * Whether a ticket is Needs you (CONTEXT.md): held, failed, or a finished ticket whose known PR
 * awaits merge. The PR clause needs `forge` — without one `merged` is never observed, so a PR merged
 * by hand would read as awaiting forever — and a `prUrl`: a ticket finished with no recorded PR
 * (work shipped by hand on another branch) is simply Finished.
 */
export function isNeedsYou(t: Pick<TicketRow, "status" | "prState" | "prUrl">, forge: boolean): boolean {
  return NEEDS_YOU.includes(t.status) || (forge && t.status === "done" && t.prState === "ready" && !!t.prUrl);
}

export type Summary = {
  /** Σ active / Σ maxConcurrent over up profiles (null → 0). */
  active: number;
  capacity: number;
  /** Tickets that are Needs you (isNeedsYou). */
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
  const forges = new Set(snapshot.profiles.filter((p) => p.forge).map((p) => p.name));
  for (const t of snapshot.tickets) if (isNeedsYou(t, forges.has(t.profile))) s.needsYou++;
  return s;
}

/** `snapshot` narrowed to one profile — so `summarize` gives that profile's own strip / card numbers. */
export function scopeToProfile(snapshot: Snapshot, name: string): Snapshot {
  return { profiles: snapshot.profiles.filter((p) => p.name === name), tickets: snapshot.tickets.filter((t) => t.profile === name) };
}
