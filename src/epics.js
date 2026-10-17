// Pure stats over an epic + its tickets (no I/O): joins the live members (Adapter.listEpicTickets)
// with the profile's local state (ui/rows.js buildRows) and event history (ui/stats.js readHistory)
// into progress-by-bucket, needs-you, and velocity/ETA numbers. The receiver's `epics` op (ops.js)
// and the `ah ui` receiver-down fallback (`localEpics`, from refmeta.epic) both join through here.
import { dailyStats } from "./ui/stats.js";

const DAY_MS = 24 * 3600 * 1000;

/** An epic ref safe to interpolate into a tracker URL path (Asana gid, Jira key, issue number). */
export const EPIC_REF_RE = /^[A-Za-z0-9._-]{1,64}$/;

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
 * @property {boolean} readyToClose
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

/** Events grouped per ref, in order. @param {Record<string, any>[]} events */
function groupByRef(events) {
  /** @type {Map<string, Record<string, any>[]>} */
  const byRef = new Map();
  for (const e of events) {
    const list = byRef.get(String(e.ref));
    if (list) list.push(e);
    else byRef.set(String(e.ref), [e]);
  }
  return byRef;
}

/**
 * The bucket one epic ticket counts in: the local row (when the ref ran here) outranks the
 * tracker's view; with no live row, the event history and then the tracker stage decide.
 * @param {import('./types.js').EpicTicket} ticket
 * @param {import('./ui/contract.js').TicketRow|null} row  the ref's local row, or null
 * @param {Record<string, any>[]|undefined} refEvents  the ref's events, in order
 * @param {boolean} forge
 * @returns {EpicBucket}
 */
export function ticketBucket(ticket, row, refEvents, forge) {
  if (row && row.status === "done" && row.prState === "merged") return "merged";
  if (row && isNeedsYou(row, forge)) return "needsYou";
  if (row && ["running", "queued", "interrupted", "stalled"].includes(row.status)) return "running";
  if (row && row.status === "done") return "finished";
  if (ticket.completed) return "finished";
  if ((!row || row.status === "idle") && historicallyFinished(refEvents)) return "finished";
  if (ticket.stage !== null) return "backlog";
  return "untracked";
}

/**
 * @param {import('./types.js').Epic} epic
 * @param {import('./types.js').EpicTicket[]} tickets
 * @param {{ rows: import('./ui/contract.js').TicketRow[], events: Record<string, any>[], forge: boolean, now?: number, tzOffset?: number, live?: boolean }} o
 * @returns {EpicStats}
 */
export function epicStats(epic, tickets, { rows, events, forge, now = Date.now(), tzOffset = 0, live = false }) {
  const memberRefs = new Set(tickets.map((t) => t.ref));
  const rowByRef = new Map(rows.map((r) => [r.ref, r]));
  const memberEvents = events.filter((e) => memberRefs.has(String(e.ref)));
  const eventsByRef = groupByRef(memberEvents);

  /** @type {Record<EpicBucket, number>} */
  const byStage = { backlog: 0, running: 0, needsYou: 0, finished: 0, merged: 0, untracked: 0 };
  /** @type {string[]} */
  const needsYou = [];

  for (const ticket of tickets) {
    const bucket = ticketBucket(ticket, rowByRef.get(ticket.ref) ?? null, eventsByRef.get(ticket.ref), forge);
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
  const readyToClose = live && total > 0 && remaining === 0 && byStage.needsYou === 0 && epic.completed === false;
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
    readyToClose,
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

/**
 * @typedef {import('./types.js').EpicTicket & { bucket: EpicBucket, status: import('./ui/contract.js').TicketStatus|null }} EpicDetailTicket
 * @typedef {EpicStats & { tickets: EpicDetailTicket[] }} EpicDetail
 */

/**
 * One epic's stats plus each ticket with its bucket and local row status (null: never ran here).
 * @param {import('./types.js').Epic} epic
 * @param {import('./types.js').EpicTicket[]} tickets
 * @param {Parameters<typeof epicStats>[2]} o
 * @returns {EpicDetail}
 */
export function epicDetail(epic, tickets, o) {
  const rowByRef = new Map(o.rows.map((r) => [r.ref, r]));
  const memberRefs = new Set(tickets.map((t) => t.ref));
  const eventsByRef = groupByRef(o.events.filter((e) => memberRefs.has(String(e.ref))));
  return {
    ...epicStats(epic, tickets, o),
    tickets: tickets.map((t) => {
      const row = rowByRef.get(t.ref) ?? null;
      return { ...t, bucket: ticketBucket(t, row, eventsByRef.get(t.ref), o.forge), status: row?.status ?? null };
    }),
  };
}

/**
 * The epics a profile can see without its tracker: refmeta entries grouped by their `epic.ref`
 * (dispatch records it per run). Each epic's status is unknown and its tickets carry no stage.
 * @param {Record<string, any>} refmeta  refmeta.json
 * @returns {{ epic: import('./types.js').Epic, tickets: import('./types.js').EpicTicket[] }[]}
 */
export function localEpics(refmeta) {
  /** @type {Map<string, { epic: import('./types.js').Epic, tickets: import('./types.js').EpicTicket[] }>} */
  const byEpic = new Map();
  for (const [ref, m] of Object.entries(refmeta)) {
    const e = m && typeof m === "object" ? m.epic : null;
    if (!e || typeof e !== "object" || typeof e.ref !== "string" || !e.ref) continue;
    let group = byEpic.get(e.ref);
    if (!group) {
      group = { epic: { ref: e.ref, name: typeof e.name === "string" ? e.name : e.ref, url: typeof e.url === "string" ? e.url : "", status: null, completed: false }, tickets: [] };
      byEpic.set(e.ref, group);
    }
    group.tickets.push({
      ref,
      ...(typeof m.displayId === "string" && m.displayId ? { displayId: m.displayId } : {}),
      name: typeof m.title === "string" ? m.title : ref,
      completed: false,
      stage: null,
    });
  }
  return [...byEpic.values()];
}
