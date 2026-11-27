import crypto from "node:crypto";
import path from "node:path";
import { loadConfig } from "../config/load.js";
import { listProfiles } from "../heartbeat.js";
import { readProfileState, buildRows, isObj, harnessSlots, unharnessedSlots, readEventsTail } from "../reader/rows.js";
import { READ_CAP_BYTES } from "../reader/stats.js";
import { pricingOf } from "../shared/pricing.js";
import { ctxOverflow } from "../models.js";
import { normalizeQuota, normalizeTrip } from "../shared/quota.js";
import { pendingFollowUp } from "../followup.js";
import { createStore } from "../store/index.js";
import { harnessTotals } from "../harness-usage.js";
import { harnessesOf } from "../dispatch/harness.js";
import { runStats, sinceMsOf, STATS_BY, STATS_SINCE } from "../stats.js";
import { REASON_MAX, clip } from "./common.js";

const FAILED_MAX = 50;
const TITLE_MAX = 80;

/** Keys that drift every call without the underlying state changing — excluded from the etag hash. */
const ETAG_VOLATILE_KEYS = new Set(["at", "etag", "ageS", "outTok", "ctx"]);

/** Stable short hash of a payload, ignoring volatile keys (`at`, `etag`, `ageS`, `outTok`, `ctx`). @param {any} obj */
export function etagOf(obj) {
  return crypto
    .createHash("sha1")
    .update(JSON.stringify(obj, (k, v) => (ETAG_VOLATILE_KEYS.has(k) ? undefined : v)))
    .digest("hex")
    .slice(0, 12);
}

/** @param {any} t @param {any} meta */
const label = (t, meta) => ({ ...(meta?.displayId ? { id: String(meta.displayId) } : {}), ...(meta?.title ? { title: clip(String(meta.title), TITLE_MAX) } : {}), ...t });

/**
 * One profile's live picture in the fewest tokens that still answer "what is running, what is
 * waiting, can I start more?". `slots.free` already subtracts queued jobs and is 0 while paused / quota-paused / restarting / draining (nothing can start).
 * `slots.harnesses` ({[name]: {active, max, state, until?, reason?}}) only for a profile with harnesses;
 * `slots.unharnessed` ({[agent]: count}) only when some pipeline run is active on a harness-less step; `harnessUsage`
 * ({[name]: {runs, input, output, cacheRead, cacheCreate}}, from usage.jsonl) only when the
 * heartbeat lists harnesses and some run used one — usage.jsonl isn't read otherwise.
 * `quota` is the last Claude quota reading (quota.json — there with the receiver down too).
 * @param {ReturnType<typeof import('../heartbeat.js').readProfile>} entry
 * @param {{now?: number}} [opts]
 */
export function readStatus(entry, { now = Date.now() } = {}) {
  const hb = entry.heartbeat ?? {};
  const state = readProfileState(entry.dir);
  const max = typeof hb.maxConcurrent === "number" ? hb.maxConcurrent : null;
  const running = Object.entries(state.running).map(([ref, r]) => {
    const started = Date.parse(r?.startedAt);
    return label(
      {
        ref,
        step: r?.stepId,
        ageS: Number.isNaN(started) ? null : Math.max(0, Math.round((now - started) / 1000)),
        ...(r?.model ? { model: r.model } : {}),
        ...(r?.harness ? { harness: r.harness } : {}),
        ...(r?.host ? { host: r.host } : {}),
        ...(typeof r?.output === "number" ? { outTok: r.output } : {}),
        ...(typeof r?.ctx === "number" ? { ctx: r.ctx } : {}),
        // An observed ctx above the listed window proves the window (or override) is wrong —
        // omit ctxMax rather than present a false over-limit reading (#700).
        ...(!ctxOverflow(r?.ctx, r?.ctxMax) && typeof r?.ctxMax === "number" ? { ctxMax: r.ctxMax } : {}),
      },
      state.refmeta[ref],
    );
  });
  // Per-harness slots (heartbeat; only set when the profile has harnesses) — read early so a
  // reserve-waiting queue entry below can name the harness's reserve count.
  const harnesses = entry.up ? harnessSlots(hb.queue?.harnesses) : null;
  // Which step(s) list a harness as their ONLY one — for the reserve-wait `why` below. Best
  // effort: the config may be gone or invalid; the queue entry then just carries no `why`.
  /** @type {Record<string, string[]>} */
  const reserveOwners = {};
  if (entry.configPath) {
    try {
      const cfg = loadConfig({ configPath: entry.configPath });
      for (const s of cfg.pipeline ?? []) {
        if (s.manual) continue;
        const names = harnessesOf(s);
        if (names.length === 1) (reserveOwners[names[0]] ??= []).push(s.id);
      }
    } catch {
      /* best effort */
    }
  }
  /** @type {Array<{ref: string, stepId: string, harnesses: string[]}>} */
  const reservedRaw = Array.isArray(hb.queue?.reserved) ? hb.queue.reserved : [];
  const reservedByKey = new Map(reservedRaw.map((r) => [`${r.ref}\u0000${r.stepId}`, r]));
  const queue = state.queue.map((j) => {
    const r = reservedByKey.get(`${j.ref}\u0000${j.stepId}`);
    const names = r ? r.harnesses.filter((/** @type {string} */ n) => harnesses?.[n]?.reserve) : [];
    const why = names.length
      ? names.map((/** @type {string} */ n) => `reserve: ${n} keeps ${harnesses?.[n]?.reserve} slot(s) for ${(reserveOwners[n] ?? []).join(", ") || "another step"}`).join("; ")
      : undefined;
    return label({ ref: String(j.ref), step: j.stepId, ...(j.kind && j.kind !== "pipeline" ? { kind: j.kind } : {}), ...(why ? { why: clip(why, REASON_MAX) } : {}) }, state.refmeta[j.ref]);
  });
  const held = Object.entries(state.held).map(([ref, h]) =>
    label({ ref, step: h?.stepId, ...(h?.reason ? { why: clip(h.reason, REASON_MAX) } : {}), since: h?.heldAt }, state.refmeta[ref]),
  );
  // Tickets whose last word is a real failure (the dashboard's "needs you" minus held): not an
  // operator cancel, not dismissed, not re-run since. Newest first, from the events tail.
  const lastFailed = new Map();
  /** The ref's last `merged` event — a mergedOpen PR row's board is open, so `finishedAt` is null there; the merge is its finish. */
  const lastMerged = new Map();
  /** The ref's newest event ts — the last age source for a prWaiting row that has no `finishedAt` and no merge. */
  const lastEventTs = new Map();
  for (const e of state.events) {
    if (e.event === "failed") lastFailed.set(e.ref, e);
    else if (e.event === "merged") lastMerged.set(e.ref, e);
    if (typeof e.ts === "string" && e.ts) lastEventTs.set(e.ref, e.ts);
  }
  // Rows with the repository, so `failed` (below) and `prWaiting` both see the PR facts —
  // the local view of "PR awaiting a person" (ADR 0008) the dashboard's needs-you needs.
  const rows = buildRows(entry.stateKey, state, { up: entry.up, repository: hb.repository ?? null });
  const failed = rows
    .filter((r) => r.status === "failed")
    .map((r) => {
      const e = lastFailed.get(r.ref);
      return label({ ref: r.ref, step: e?.step || r.step, ...(e?.reason ? { why: clip(String(e.reason), REASON_MAX) } : {}), at: e?.ts }, state.refmeta[r.ref]);
    })
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))
    .slice(0, FAILED_MAX);
  // Approvals with checks to verify once the change is live (src/followup.js), oldest first.
  const followUp = pendingFollowUp(state.refmeta).map(({ ref, checks, tier, pr, since }) =>
    label({ ref, checks: checks.map((c) => clip(c, REASON_MAX)), ...(tier ? { tier } : {}), ...(pr ? { pr } : {}), ...(since ? { since } : {}) }, state.refmeta[ref]),
  );
  // Open PRs awaiting a person (forge profiles only) — the third needs-you input beside held/failed.
  const prWaiting = hb.forge
    ? rows.filter((r) => r.prNeeds).map((r) => label({ ref: r.ref, step: r.step, pr: r.prUrl, kind: r.prNeeds, at: r.finishedAt ?? (r.prNeeds === "mergedOpen" ? lastMerged.get(r.ref)?.ts : null) ?? lastEventTs.get(r.ref) ?? null }, state.refmeta[r.ref]))
    : [];
  const active = entry.up ? running.length : 0;
  const queued = entry.up ? queue.length : 0;
  // Queued jobs waiting on their step's own maxConcurrent, not on a slot (heartbeat; only set with step caps).
  const capped = Math.min(queued, Math.max(0, Number(hb.queue?.capped) || 0));
  // Implicit (harness-less) run counts by agent CLI (heartbeat; only set when some such run is active).
  const unharnessed = entry.up ? unharnessedSlots(hb.queue?.unharnessed) : null;
  const harnessUsage = isObj(hb.queue?.harnesses) && Object.keys(hb.queue.harnesses).length ? harnessTotals(createStore(entry.dir).readUsage()) : null;
  const quotaPaused = normalizeTrip(hb.quotaPaused);
  const quota = normalizeQuota(state.quota);
  const out = {
    profile: entry.stateKey,
    up: entry.up,
    tracker: hb.tracker ?? null,
    slots: { max, active, queued, ...(capped ? { capped } : {}), free: max === null ? null : hb.paused || quotaPaused || hb.restartPending || hb.decommissionPending || hb.draining ? 0 : Math.max(0, max - active - (queued - capped)), ...(harnesses ? { harnesses } : {}), ...(unharnessed ? { unharnessed } : {}) },
    ...(hb.paused ? { paused: true } : {}),
    ...(hb.overrides && typeof hb.overrides === "object" ? { overrides: hb.overrides } : {}),
    ...(quotaPaused ? { quotaPaused } : {}),
    ...(quota ? { quota } : {}),
    ...(hb.restartPending ? { restartPending: true } : {}),
    ...(hb.decommissionPending ? { decommissionPending: true } : {}),
    ...(hb.draining ? { draining: true } : {}),
    ...(hb.queueStage ? { backlog: hb.queueStage } : {}),
    ...(harnessUsage ? { harnessUsage } : {}),
    running,
    queue,
    held,
    ...(failed.length ? { failed } : {}),
    ...(prWaiting.length ? { prWaiting } : {}),
    ...(followUp.length ? { followUp } : {}),
    ...(entry.up ? {} : { note: "receiver down — running/queue are from the last state on disk (interrupted/stalled)" }),
  };
  return { ...out, etag: etagOf(out) };
}

/**
 * Per-harness/model/step/agent run outcomes, wall time, context and cost (#646) — read-only
 * from the state dir like `readStatus`, so it works with the receiver down. Steps/agent default
 * and pricing overrides come from the profile's own config when `entry.configPath` still loads;
 * otherwise those fall back to `"claude"` and no overrides — the stats themselves still work.
 * @param {ReturnType<typeof listProfiles>[number]} entry
 * @param {{ by?: string, since?: string, step?: string, harness?: string }} [args]
 * @returns {import('../stats.js').StatsResult}
 */
export function readRunStats(entry, args = {}) {
  const by = args.by ?? "harness";
  if (!STATS_BY.includes(by)) throw new Error(`stats: "by" must be one of ${STATS_BY.join(", ")}`);
  const since = args.since ?? "7d";
  const sinceMs = sinceMsOf(since);
  if (sinceMs === undefined) throw new Error(`stats: "since" must be one of ${STATS_SINCE.join(", ")}`);
  const usage = createStore(entry.dir).readUsage();
  const events = readEventsTail(path.join(entry.dir, "events.jsonl"), READ_CAP_BYTES); // stats need the whole window, not just the UI's 256 KB tail
  let steps = /** @type {{id: string, agent?: string}[]} */ ([]);
  let defaultAgent = "claude";
  if (entry.configPath) {
    try {
      const cfg = loadConfig({ configPath: entry.configPath });
      steps = cfg.pipeline ?? [];
      defaultAgent = cfg.agent ?? "claude";
    } catch {
      /* best effort: the config may be gone/invalid — stats still work without the step-agent fallback */
    }
  }
  return runStats(usage, events, { by, sinceMs, step: args.step, harness: args.harness, steps, defaultAgent, pricing: pricingOf(entry.heartbeat) });
}
