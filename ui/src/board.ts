import type { TicketRow, TicketStatus } from "./contract";
import { isNeedsYou } from "./summary";

/**
 * Pure bucketing for the Overview's board (#697, #696): one row per ticket in flight, the
 * pipeline's steps as columns, and the tickets that finished today. Needs-you rows (held, failed,
 * a flagged PR) are built by `zones.ts`'s `needsYouItems`; here they only count toward their
 * step's column. No DOM, no fetch — `Departures.tsx` only renders what this computes.
 */

/** Rows that read as "running": live, or an interrupted leftover (profile down). */
const RUNNING_LIKE: TicketStatus[] = ["running", "interrupted"];
/** Rows that read as "queued": waiting, or a stalled leftover (profile down). */
const QUEUED_LIKE: TicketStatus[] = ["queued", "stalled"];
/** Rows that sit in a step and wait on the human. */
const WAITING_ON_YOU: TicketStatus[] = ["held", "failed"];

const time = (iso: string | null) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? 0 : t;
};

/** One board row: the ticket plus how its clock reads. */
export type BoardEntry = {
  ticket: TicketRow;
  /** `running`: live `Elapsed` from `startedAt`. `queued`: muted `Waiting` from `queuedAt`. */
  clock: "running" | "queued";
};

export type Board = {
  /** The step columns, in pipeline order. A manual step is a column only while it holds a ticket. */
  columns: string[];
  /** Tickets sitting in each column: running, queued, held and failed. */
  counts: Record<string, number>;
  runningCount: number;
  queuedCount: number;
  /** Running first (longest first), then the queue in its own order, capped at QUEUE_CAP. */
  rows: BoardEntry[];
  /** Queued rows beyond the cap. */
  moreQueued: number;
  /** Finished since local midnight, newest first, capped at FINISHED_CAP; `total` is the full count. */
  finished: { tickets: TicketRow[]; total: number };
};

/** The board lists at most this many waiting tickets before "+N more". Running ones always show. */
export const QUEUE_CAP = 8;
/** Finished today shows at most this many. */
export const FINISHED_CAP = 6;

/** Local midnight of `now` (browser-local day) — "Finished today" (and `progress`'s) boundary. */
export function localMidnight(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

const runningSort = (a: TicketRow, b: TicketRow) => time(a.startedAt) - time(b.startedAt) || a.ref.localeCompare(b.ref);
const queuedSort = (a: TicketRow, b: TicketRow) => (a.queuePos ?? Infinity) - (b.queuePos ?? Infinity) || a.ref.localeCompare(b.ref);

/**
 * The board for one profile's tickets. `stepIds` is the pipeline in order ([] while it is unknown:
 * the rows still list, with no columns); `manual` are the steps that run no agent.
 */
export function board(tickets: TicketRow[], stepIds: string[], manual: readonly string[], now: number, forge?: boolean): Board {
  const running = tickets.filter((t) => RUNNING_LIKE.includes(t.status)).sort(runningSort);
  const queued = tickets.filter((t) => QUEUED_LIKE.includes(t.status)).sort(queuedSort);
  const counts: Record<string, number> = {};
  for (const t of [...running, ...queued, ...tickets.filter((t) => WAITING_ON_YOU.includes(t.status))]) {
    if (t.step) counts[t.step] = (counts[t.step] ?? 0) + 1;
  }
  const columns = stepIds.filter((id) => !manual.includes(id) || (counts[id] ?? 0) > 0);

  const midnight = localMidnight(now);
  const finished = tickets
    .filter((t) => t.status === "done" && t.finishedAt && time(t.finishedAt) >= midnight && !(forge && isNeedsYou(t, forge)))
    .sort((a, b) => time(b.finishedAt) - time(a.finishedAt) || a.ref.localeCompare(b.ref));

  return {
    columns,
    counts,
    runningCount: running.length,
    queuedCount: queued.length,
    rows: [...running.map((ticket): BoardEntry => ({ ticket, clock: "running" })), ...queued.slice(0, QUEUE_CAP).map((ticket): BoardEntry => ({ ticket, clock: "queued" }))],
    moreQueued: Math.max(0, queued.length - QUEUE_CAP),
    finished: { tickets: finished.slice(0, FINISHED_CAP), total: finished.length },
  };
}
