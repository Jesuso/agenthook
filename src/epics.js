// Pure stats over an epic + its tickets (no I/O): joins the live members (Adapter.listEpicTickets)
// with the profile's local state (ui/rows.js buildRows) and event history (ui/stats.js readHistory)
// into progress-by-bucket, needs-you, and velocity/ETA numbers. #300+ wires this up (ops/MCP/CLI/UI).
import { dailyStats } from "./ui/stats.js";

const DAY_MS = 24 * 3600 * 1000;

/**
 * @typedef {'backlog'|'running'|'needsYou'|'finished'|'merged'|'untracked'} EpicBucket
 */

/**
 * @typedef {object} EpicStats
 * @property {string} ref
 * @property {string} name
 * @property {string} url
 * @property {string} [displayId]
 * @property {string|null} status
 * @property {boolean} completed
 * @property {number} total
 * @property {Record<EpicBucket, number>} byStage
 * @property {string[]} needsYou
 * @property {string|null} startedAt
 * @property {{ days: import('./ui/stats.js').DayStats[], finished14: number, activeDays: number, perDay: number|null }} velocity
 * @property {{ days: number, date: string }|null} eta
 */

/**
 * Mirrors ui/src/summary.ts isNeedsYou — keep the two in sync.
 * @param {Pick<import('./ui/contract.js').TicketRow, 'status'|'prState'|'prUrl'>} row
 * @param {boolean} forge
 */
export function isNeedsYou(row, forge) {
  return row.status === "held" || row.status === "failed" || (forge && row.status === "done" && row.prState === "ready" && !!row.prUrl);
}

/** @param {number} ts @param {number} tzOffset */
const dayKey = (ts, tzOffset) => new Date(ts - tzOffset * 60000).toISOString().slice(0, 10);

/**
 * @param {import('./types.js').Epic} epic
 * @param {import('./types.js').EpicTicket[]} tickets
 * @param {{ rows: import('./ui/contract.js').TicketRow[], events: Record<string, any>[], forge: boolean, now?: number, tzOffset?: number }} o
 * @returns {EpicStats}
 */
export function epicStats(epic, tickets, { rows, events, forge, now = Date.now(), tzOffset = 0 }) {
  const memberRefs = new Set(tickets.map((t) => t.ref));
  const rowByRef = new Map(rows.map((r) => [r.ref, r]));
  const memberEvents = events.filter((e) => memberRefs.has(String(e.ref)));

  /** @type {Map<string, Record<string, any>[]>} events per ref, in order */
  const eventsByRef = new Map();
  for (const e of memberEvents) {
    const list = eventsByRef.get(String(e.ref));
    if (list) list.push(e);
    else eventsByRef.set(String(e.ref), [e]);
  }

  /** @type {Record<EpicBucket, number>} */
  const byStage = { backlog: 0, running: 0, needsYou: 0, finished: 0, merged: 0, untracked: 0 };
  /** @type {string[]} */
  const needsYou = [];

  for (const ticket of tickets) {
    const row = rowByRef.get(ticket.ref) ?? null;
    /** @type {EpicBucket} */
    let bucket;
    if (row && row.status === "done" && row.prState === "merged") {
      bucket = "merged";
    } else if (row && isNeedsYou(row, forge)) {
      bucket = "needsYou";
    } else if (row && ["running", "queued", "interrupted", "stalled"].includes(row.status)) {
      bucket = "running";
    } else if (row && row.status === "done") {
      bucket = "finished";
    } else if (ticket.completed) {
      bucket = "finished";
    } else if ((!row || row.status === "idle") && historicallyFinished(eventsByRef.get(ticket.ref))) {
      bucket = "finished";
    } else if (ticket.stage !== null) {
      bucket = "backlog";
    } else {
      bucket = "untracked";
    }
    byStage[bucket]++;
    if (bucket === "needsYou") needsYou.push(ticket.ref);
  }

  let startedAt = /** @type {string|null} */ (null);
  for (const e of memberEvents) {
    if (e.event !== "run_start" || typeof e.ts !== "string") continue;
    if (startedAt === null || e.ts < startedAt) startedAt = e.ts;
  }

  const days = dailyStats(memberEvents, { now, days: 14, tzOffset });
  const finished14 = days.reduce((n, d) => n + d.finished, 0);
  const activeDays = days.filter((d) => d.finished > 0).length;
  const windowStartKey = days[0]?.date ?? dayKey(now - 13 * DAY_MS, tzOffset);
  const startedAtKey = startedAt !== null ? dayKey(Date.parse(startedAt), tzOffset) : null;
  const spanStartKey = startedAtKey !== null && startedAtKey > windowStartKey ? startedAtKey : windowStartKey;
  const todayKey = dayKey(now, tzOffset);
  const spanDays = Math.max(1, Math.round((Date.parse(`${todayKey}T00:00:00Z`) - Date.parse(`${spanStartKey}T00:00:00Z`)) / DAY_MS) + 1);
  const perDay = finished14 > 0 ? finished14 / spanDays : null;

  const total = tickets.length;
  const remaining = total - byStage.finished - byStage.merged;
  /** @type {{ days: number, date: string }|null} */
  let eta = null;
  if (finished14 >= 3 && activeDays >= 3 && remaining > 0 && perDay) {
    const etaDays = Math.ceil(remaining / perDay);
    eta = { days: etaDays, date: dayKey(now + etaDays * DAY_MS, tzOffset) };
  }

  return {
    ref: epic.ref,
    name: epic.name,
    url: epic.url,
    displayId: epic.displayId,
    status: epic.status,
    completed: epic.completed,
    total,
    byStage,
    needsYou,
    startedAt,
    velocity: { days, finished14, activeDays, perDay },
    eta,
  };
}

/** Did the ref finish per the event history (no live row, e.g. older than the rows tail), with no
 * later re-run? @param {Record<string, any>[]|undefined} refEvents */
function historicallyFinished(refEvents) {
  if (!refEvents) return false;
  let finished = false;
  for (const e of refEvents) {
    if (e.event === "pipeline_done" || e.event === "merged") finished = true;
    else if (e.event === "run_start") finished = false;
  }
  return finished;
}
