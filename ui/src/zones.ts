import type { ProfileView, TicketRow } from "./contract";
import { isNeedsYou } from "./summary";

/** One row of the Overview's Needs-you zone. */
export type NeedsItem = {
  ticket: TicketRow;
  /** `pr`: finished, its PR awaits merge (forge profiles only). */
  kind: "failed" | "held" | "pr";
  /** The one-line why: the failure / hold reason, null when the agent gave none. */
  reason: string | null;
  /** When it started needing you (ISO), for the age column. */
  since: string | null;
};

const KIND_RANK = { failed: 0, held: 1, pr: 2 } as const;

const time = (iso: string | null) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? 0 : t;
};

/** The profile's Needs-you tickets, worst first: failed → held → PR awaiting merge, newest first within a kind. */
export function needsYouItems(tickets: TicketRow[], forge: boolean): NeedsItem[] {
  const items: NeedsItem[] = [];
  for (const t of tickets) {
    if (!isNeedsYou(t, forge)) continue;
    if (t.status === "failed") items.push({ ticket: t, kind: "failed", reason: t.failReason, since: t.startedAt });
    else if (t.status === "held") items.push({ ticket: t, kind: "held", reason: t.heldReason, since: t.heldAt ?? t.startedAt });
    else items.push({ ticket: t, kind: "pr", reason: null, since: t.finishedAt });
  }
  return items.sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || time(b.since) - time(a.since) || a.ticket.ref.localeCompare(b.ticket.ref));
}

/** What is in flight: running agents (longest-running first) and the queue in its own order. */
export function nowItems(tickets: TicketRow[]): { running: TicketRow[]; queued: TicketRow[] } {
  const running = tickets.filter((t) => t.status === "running").sort((a, b) => time(a.startedAt) - time(b.startedAt) || a.ref.localeCompare(b.ref));
  const queued = tickets.filter((t) => t.status === "queued").sort((a, b) => (a.queuePos ?? Infinity) - (b.queuePos ?? Infinity) || a.ref.localeCompare(b.ref));
  return { running, queued };
}

/** Below this many runs in the window a rate is noise, so Progress hides the rework figure. */
export const MIN_RUNS_FOR_RATES = 10;

export type Progress = {
  finishedToday: number;
  finishedYesterday: number;
  costToday: number;
  costYesterday: number;
  /** `run_end`s in the events tail's window (≈48 h). */
  runs: number;
  /** Of those, how many ended `changes` — a rework loop. */
  rework: number;
  /** rework / runs, null below MIN_RUNS_FOR_RATES. */
  reworkRate: number | null;
};

/** Local midnight of the day `daysAgo` before `now` (setDate, so DST days stay one calendar day). */
function midnight(now: number, daysAgo: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - daysAgo);
  return d.getTime();
}

/**
 * Today vs yesterday (browser-local days) plus the rework rate, over what the events tail holds —
 * about 48 h, so "yesterday" is only complete when the tail reaches back that far.
 */
export function progress(profile: Pick<ProfileView, "recentCosts" | "recentRuns">, tickets: TicketRow[], now: number): Progress {
  const today = midnight(now, 0);
  const yesterday = midnight(now, 1);
  const p: Progress = { finishedToday: 0, finishedYesterday: 0, costToday: 0, costYesterday: 0, runs: 0, rework: 0, reworkRate: null };
  for (const t of tickets) {
    const at = time(t.finishedAt);
    if (t.status !== "done" || !at) continue;
    if (at >= today) p.finishedToday++;
    else if (at >= yesterday) p.finishedYesterday++;
  }
  for (const c of profile.recentCosts ?? []) {
    const at = time(c.at);
    if (!Number.isFinite(c.costUsd)) continue;
    if (at >= today) p.costToday += c.costUsd;
    else if (at >= yesterday) p.costYesterday += c.costUsd;
  }
  for (const r of profile.recentRuns ?? []) {
    p.runs++;
    if (r.outcome === "changes") p.rework++;
  }
  if (p.runs >= MIN_RUNS_FOR_RATES) p.reworkRate = p.rework / p.runs;
  return p;
}
