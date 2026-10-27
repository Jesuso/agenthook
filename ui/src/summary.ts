import type { Snapshot, TicketRow, TicketStatus } from "./contract";

/** The ticket statuses that always want a human: held and failed. */
export const NEEDS_YOU: TicketStatus[] = ["held", "failed"];

/**
 * Whether a ticket is Needs you (CONTEXT.md): held, failed, or a PR reason where code and board
 * disagree (`prNeeds`, server-computed — ADR 0008). The PR clause needs `forge`: without one no PR
 * fact is ever observed, so the board alone decides. Mirrors src/epics.js isNeedsYou — keep the two in sync.
 */
export function isNeedsYou(t: Pick<TicketRow, "status" | "prNeeds">, forge: boolean): boolean {
  return NEEDS_YOU.includes(t.status) || (forge && t.prNeeds != null);
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
  /** Σ recentCosts' rate-table estimates since local midnight — never in costToday. */
  estToday: number;
  up: number;
  down: number;
};

/** The dashboard's summary strip over one snapshot. */
export function summarize(snapshot: Snapshot, now: number): Summary {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const since = midnight.getTime();
  const s: Summary = { active: 0, capacity: 0, needsYou: 0, queued: 0, costToday: 0, estToday: 0, up: 0, down: 0 };
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
      if (Number.isNaN(t) || t < since) continue;
      if (Number.isFinite(c.costUsd)) s.costToday += c.costUsd;
      if (Number.isFinite(c.estUsd)) s.estToday += c.estUsd;
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
