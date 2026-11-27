import path from "node:path";
import { registryDir } from "../config/index.js";
import { EPIC_REF_RE, epicDetail, epicStats, localEpics } from "../epics.js";
import { readProfileState, buildRows } from "../reader/rows.js";
import { readHistory } from "../reader/stats.js";
import { live } from "./live.js";
import { readStatus, etagOf } from "./status.js";
import { eventsCursor, compactEvent, readEventsSince } from "./events.js";

/**
 * The receiver-down view of `epics`: the epics the profile's refmeta names (`epic` per ticket),
 * joined with its local rows and history — no tracker read, `live:false`. Null when `ref` names
 * none of them (an unknown ref down).
 * @param {ReturnType<typeof import('../heartbeat.js').readProfile>} entry
 * @param {{ref?: string|null, tz?: number}} [o]
 */
export function readLocalEpics(entry, { ref = null, tz = 0 } = {}) {
  const hb = entry.heartbeat;
  const state = readProfileState(entry.dir);
  const join = {
    rows: buildRows(entry.stateKey, state, { repository: hb?.repository ?? null, up: false }),
    events: readHistory(path.join(entry.dir, "events.jsonl")).events,
    forge: !!hb?.forge,
    tzOffset: tz,
  };
  const groups = localEpics(state.refmeta);
  const at = new Date().toISOString();
  if (ref === null) return { at, live: false, supported: true, epics: groups.map((g) => epicStats(g.epic, g.tickets, join)) };
  const hit = groups.find((g) => g.epic.ref === ref);
  return hit ? { at, live: false, supported: true, epic: epicDetail(hit.epic, hit.tickets, join) } : null;
}

/**
 * Epics: live via the receiver's `epics` op when it is up, else the local refmeta-based fallback
 * (`live:false`). An unknown ref while down throws naming the fallback explicitly.
 * @param {ReturnType<typeof import('../heartbeat.js').readProfile>} entry
 * @param {{ref?: string, fresh?: boolean, tz?: number, registry?: string}} [o]
 */
export async function readEpics(entry, { ref, fresh, tz, registry = registryDir } = {}) {
  if (ref !== undefined && !EPIC_REF_RE.test(ref)) throw new Error("invalid epic ref");
  const tzOffset = tz ?? new Date().getTimezoneOffset();
  if (entry.up) {
    try {
      return await live(entry.stateKey, "epics", { ...(ref !== undefined ? { ref } : {}), ...(fresh ? { fresh: true } : {}), tz: tzOffset }, { registry });
    } catch (e) {
      if (e.code !== "down") throw e;
    }
  }
  const local = readLocalEpics(entry, { ref: ref ?? null, tz: tzOffset });
  if (local === null) throw new Error(`no epic ${ref} (receiver down: only epics named by local tickets are known)`);
  return local;
}

/**
 * Everything a supervising agent needs per cycle in one object: status + (optionally) board and
 * open agent PRs + the events since `cursor`. Board/PR failures degrade to an `…Error` string
 * instead of failing the tick (no forge, receiver down, rate limit).
 * @param {ReturnType<typeof import('../heartbeat.js').readProfile>} entry
 * @param {{cursor?: number, board?: boolean, prs?: boolean, epics?: boolean, eventLimit?: number, registry?: string}} [o]
 */
export async function readTick(entry, { cursor, board = true, prs = true, epics = false, eventLimit = 50, registry = registryDir } = {}) {
  const status = readStatus(entry);
  /** @type {Record<string, any>} */
  const out = { ...status };
  const wantLive = entry.up;
  const [b, p, ep] = await Promise.all([
    board && wantLive ? live(entry.stateKey, "board", {}, { registry }).catch((e) => ({ error: e.message })) : null,
    prs && wantLive ? live(entry.stateKey, "prs", {}, { registry }).catch((e) => ({ error: e.message })) : null,
    epics ? readEpics(entry, { registry }).catch((e) => ({ error: e.message })) : null,
  ]);
  if (b) {
    if (b.error) out.boardError = b.error;
    else out.board = b.steps;
  }
  if (p) {
    if (p.error) out.prsError = p.error;
    else out.prs = p.prs.map((/** @type {any} */ x) => ({ n: x.number, ref: x.ref, ci: x.ci, ...(x.mergeable === false ? { conflict: true } : {}), ...(x.mergeState && x.mergeState !== "clean" ? { state: x.mergeState } : {}), ...(x.draft ? { draft: true } : {}), ...(x.autoMerge ? { autoMerge: true } : {}), ...(typeof x.mine === "boolean" ? { mine: x.mine } : {}), ...(x.review ? { review: x.review } : {}) }));
  }
  if (ep) {
    if (ep.error) out.epicsError = ep.error;
    else if (ep.supported === false) out.epicsError = "tracker has no epic support";
    else {
      out.epicsLive = ep.live;
      out.epics = (ep.epics ?? []).map((/** @type {any} */ e) => {
        const { velocity, ...rest } = e;
        const { days: _days, ...v } = velocity;
        return { ...rest, velocity: v };
      });
    }
  }
  const since = readEventsSince(entry.dir, cursor ?? eventsCursor(entry.dir), { limit: eventLimit });
  out.events = since.events.map(compactEvent);
  out.cursor = since.cursor;
  delete out.etag;
  out.etag = etagOf(out);
  return out;
}
