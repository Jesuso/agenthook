import type { TicketRow, TicketStatus } from "./contract";

/**
 * Pure bucketing for the profile Board (#697): every pipeline step is a box holding its
 * running/queued tickets, plus an "Other" box for rows whose step matches none, and one "Done
 * today" box at the end. Needs-you (held/failed/a flagged PR) is never bucketed here — it's a
 * separate, always-full-width zone built from `zones.ts`'s `needsYouItems`/`harnessAttention`.
 * No DOM, no fetch — `BoardView.tsx` only renders what this computes.
 */

/** Rows that read as "running" in a step box: live, or an interrupted leftover (profile down). */
const RUNNING_LIKE: TicketStatus[] = ["running", "interrupted"];
/** Rows that read as "queued": waiting, or a stalled leftover (profile down). */
const QUEUED_LIKE: TicketStatus[] = ["queued", "stalled"];

const time = (iso: string | null) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? 0 : t;
};

/** One board entry: the ticket plus how its clock reads. */
export type BoardEntry = {
  ticket: TicketRow;
  /** `running`: live `Elapsed` from `startedAt`. `queued`: muted `Waiting` from `queuedAt`. `done`: no clock. */
  clock: "running" | "queued" | "done";
};

export type BoardSection = {
  id: string;
  kind: "step" | "other" | "done";
  runningCount: number;
  queuedCount: number;
  /** Capped at BOARD_CAP, in display order. */
  entries: BoardEntry[];
  /** Rows beyond the cap — the "+N more" row switches the Table tab to `id` (step sections only). */
  moreCount: number;
};

/** A step/other section shows at most this many rows before "+N more". */
export const BOARD_CAP = 6;

/** Local midnight of `now` (browser-local day) — "Done today" (and `progress`'s) boundary. */
export function localMidnight(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

const runningSort = (a: TicketRow, b: TicketRow) => time(a.startedAt) - time(b.startedAt) || a.ref.localeCompare(b.ref);
const queuedSort = (a: TicketRow, b: TicketRow) => (a.queuePos ?? Infinity) - (b.queuePos ?? Infinity) || a.ref.localeCompare(b.ref);

function cap(rows: TicketRow[], clock: "running" | "queued"): { entries: BoardEntry[]; moreCount: number } {
  return { entries: rows.slice(0, BOARD_CAP).map((ticket) => ({ ticket, clock })), moreCount: Math.max(0, rows.length - BOARD_CAP) };
}

/** One step/other section's rows: running-like first (longest running first), then queued-like
 * (queue order), capped together at BOARD_CAP. */
function section(id: string, kind: "step" | "other", rows: TicketRow[]): BoardSection {
  const running = rows.filter((t) => RUNNING_LIKE.includes(t.status)).sort(runningSort);
  const queued = rows.filter((t) => QUEUED_LIKE.includes(t.status)).sort(queuedSort);
  const ordered = [...running, ...queued];
  const { entries, moreCount } = cap(ordered, "running");
  // Queued entries past the running ones read their own clock; recompute per-row rather than
  // trusting `cap`'s single clock.
  for (const e of entries) e.clock = QUEUED_LIKE.includes(e.ticket.status) ? "queued" : "running";
  return { id, kind, runningCount: running.length, queuedCount: queued.length, entries, moreCount };
}

/**
 * One box per pipeline step (`stepIds`, in order) holding its running/queued tickets; an "Other"
 * box (only when non-empty) for rows whose `step` matches none of them; one "Done today" box
 * (newest first, capped, with the full count) for `done` rows finished since local midnight.
 */
export function boardSections(tickets: TicketRow[], stepIds: string[], now: number): { steps: BoardSection[]; other: BoardSection | null; doneToday: { section: BoardSection; total: number } } {
  const live = tickets.filter((t) => RUNNING_LIKE.includes(t.status) || QUEUED_LIKE.includes(t.status));
  const stepSet = new Set(stepIds);
  const steps = stepIds.map((id) => section(id, "step", live.filter((t) => t.step === id)));
  const otherRows = live.filter((t) => !t.step || !stepSet.has(t.step));
  const other = otherRows.length > 0 ? section("other", "other", otherRows) : null;

  const midnight = localMidnight(now);
  const doneRows = tickets
    .filter((t) => t.status === "done" && t.finishedAt && time(t.finishedAt) >= midnight)
    .sort((a, b) => time(b.finishedAt) - time(a.finishedAt) || a.ref.localeCompare(b.ref));
  const { entries, moreCount } = cap(doneRows, "running");
  for (const e of entries) e.clock = "done";
  const doneSection: BoardSection = { id: "done", kind: "done", runningCount: 0, queuedCount: 0, entries, moreCount };

  return { steps, other, doneToday: { section: doneSection, total: doneRows.length } };
}

export type BoardTab = "board" | "table";

const TAB_KEY = "ah.board.tab";

/** The profile page's last-picked tab (Table is the default), persisted per browser — same
 * pattern as `logview.ts`'s view toggle. */
export function readBoardTab(store: Pick<Storage, "getItem"> | undefined = globalThis.localStorage): BoardTab {
  try {
    return store?.getItem(TAB_KEY) === "board" ? "board" : "table";
  } catch {
    return "table";
  }
}

export function writeBoardTab(tab: BoardTab, store: Pick<Storage, "setItem"> | undefined = globalThis.localStorage): void {
  try {
    store?.setItem(TAB_KEY, tab);
  } catch {
    /* storage disabled — the tab just won't persist */
  }
}
