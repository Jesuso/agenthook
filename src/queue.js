// Bounded-concurrency job queue. Worktree isolation (see INSTRUCTIONS.md) lets
// multiple agents run at once; MAX caps how many.
import { DEFAULT_COOLDOWN_MINUTES, cooldownFor } from "./dispatch/harness.js";

/** One harness's breaker entry: down until `until` (ms epoch), then probing; `strikes` doubles the next cooldown.
 * `cause` is `health` (a failing backend) or `quota` (a closed subscription, reopening to `up` at `until`).
 * @typedef {{until: number, strikes: number, reason: string, cause?: 'health'|'quota'}} HarnessHealth */
/** A harness's slots as `state()` / `harnessState()` report them (`until` as ISO; `until`/`reason`/`cause` only when not up; `reserve` only when > 0, #745).
 * @typedef {{active: number, max: number|null, state: 'up'|'down'|'probing', reserve?: number, until?: string, reason?: string, cause?: 'health'|'quota'}} HarnessSlots */
/**
 * Boot-restore plan for persisted queue entries: which to re-enqueue (in order) and
 * which to drop (ref was mid-run at boot — recovery failed it — or step is gone). A
 * non-pipeline job (`merge`, `ci`) is always kept: the forge event happened regardless,
 * its key is already in `seen` (a redelivery won't re-fire it), and its stepId may be "".
 * @param {import('./types/pipeline.js').Job[]} queued
 * @param {Iterable<string>} runningRefs
 * @param {Iterable<string>} stepIds
 */
export function planRestore(queued, runningRefs, stepIds) {
  const running = new Set(runningRefs);
  const steps = new Set(stepIds);
  /** @type {import('./types/pipeline.js').Job[]} */ const keep = [];
  /** @type {import('./types/pipeline.js').Job[]} */ const drop = [];
  for (const j of queued) {
    const stale = (j.kind ?? "pipeline") === "pipeline" && (running.has(j.ref) || !steps.has(j.stepId));
    (stale ? drop : keep).push(j);
  }
  return { keep, drop };
}

/**
 * @param {number} initialMax
 * @param {(job: import('./types/pipeline.js').Job) => Promise<{kind:string,ref:string,name:string,url:string,code:number,health?:{harness:string,reason:string,requeue:boolean}}>} run
 *   its `health` (a harnessed run only) trips the job's harness breaker; `requeue` puts the job
 *   back at the front of the wait list instead of finishing it
 * @param {(state: {active:number, queued:number, capped?:number, harnesses?: Record<string, HarnessSlots>}) => void} [onChange]  called after every state change (heartbeat)
 * @param {{onAdd?: (job: import('./types/pipeline.js').Job, opts?: {front?: boolean}) => void, onRemove?: (job: import('./types/pipeline.js').Job) => void, onSettle?: () => void}} [persist]
 *   persistence hooks: onAdd once a job is accepted (`front` for a requeued one, back at index 0),
 *   onRemove when it leaves the wait list to run, onSettle after a job settles and its slot is
 *   released (the engine's queue-stage pull trigger)
 * @param {Record<string, number>} [stepCaps]  per-step concurrency caps (stepId → max runs at once),
 *   counted INSIDE the global max. Only `pipeline` jobs count; `merge`/`ci` spawn no agent. Empty →
 *   strict FIFO as before, and `state()` carries no `capped`.
 * @param {{steps: Record<string, {harnesses: string[], routing?: 'first-free'|'round-robin'}>, caps: Record<string, number|undefined>,
 *   cooldowns?: Record<string, number|undefined>, health?: Record<string, {until: string, strikes: number, reason: string, cause?: 'health'|'quota'}>, now?: () => number,
 *   reserves?: Record<string, number>, exclusive?: string[],
 *   unharnessedShared?: string[], unharnessedUntil?: string|null, unharnessedAgents?: Record<string, string>,
 *   setTimer?: (fn: () => void, ms: number) => NodeJS.Timeout, clearTimer?: (t: NodeJS.Timeout) => void,
 *   onHealth?: (down: Record<string, {until: string, strikes: number, reason: string, cause: 'health'|'quota'}>, unharnessedUntil: string|null) => void,
 *   onHarnessDown?: (name: string, info: {reason: string, until: string, cause: 'health'|'quota', window?: 'sevenDay'|'fiveHour', utilization?: number, threshold?: number}) => void,
 *   onHarnessUp?: (name: string, info: {cause: 'health'|'quota'}) => void}} [harnessing]
 *   named harnesses (set only when the profile has `harnesses`): each harnessed step's list and
 *   routing, and each harness's slot cap (undefined = only the global cap). A pipeline job of a
 *   harnessed step starts only when one of its harnesses has room; the pick lands on `job.harness`.
 *   Set → `state()` carries `harnesses` (and `capped`).
 *   The health breaker: a settle with `health` marks its harness down for its cooldown
 *   (`cooldowns`, minutes, default 10), doubled per repeat strike up to 60. A down harness has no
 *   room; once `until` passes it is probing — room for exactly one run, whose healthy settle
 *   brings it back up. Expiry is read lazily (pump, `blocked`, `state()`), never on a timer: an
 *   idle receiver whose step has every harness down starts the waiting job on the first pump
 *   after `until` (an enqueue, a settle, `setMax`, `resume`, `resetHarness`). `health` seeds the
 *   breaker (harness-health.json), `onHealth` persists every change, `onHarnessDown`/`onHarnessUp`
 *   report the transitions. A `cause:'quota'` entry (see `closeForQuota`) never adds strikes,
 *   reads `down` until `until` then `up` (never `probing`), and reopens on a one-shot timer
 *   (`setTimer`/`clearTimer`; `stop()` disarms it). `unharnessedShared` lists the step ids whose
 *   unharnessed claude runs share the quota group; `unharnessedUntil` seeds the queue-level gate
 *   that waits those steps while the shared group is closed. `unharnessedAgents` maps a
 *   harness-less step id to the agent CLI it spawns; a pipeline job on such a step is counted in
 *   `state().unharnessed` by that agent name, never in `harnesses` (a chip a reader could mistake
 *   for a configured harness, and which the puller/breaker/doctor would then treat as one).
 */
export function createQueue(initialMax, run, onChange, persist, stepCaps = {}, harnessing) {
  let max = initialMax;
  const caps = new Map(Object.entries(stepCaps));
  const harnessSteps = new Map(Object.entries(harnessing?.steps ?? {}));
  // Queue-owned copy: setHarnessMax changes a cap at runtime without touching the engine's.
  const harnessCaps = { ...(harnessing?.caps ?? {}) };
  // Queue-owned copy of the cooldowns (a reload replaces them; the engine's stays intact).
  const cooldowns = { ...(harnessing?.cooldowns ?? {}) };
  // Queue-owned copy of the reserve (#745): the slot count an exclusive harness keeps back from
  // a spilling job with an open alternative elsewhere. A harness not in this map has none.
  const reserves = { ...(harnessing?.reserves ?? {}) };
  // Harnesses some non-manual step lists as its only harness — the order rule (Rule 2) applies to
  // these whatever their reserve, including a reserve of 0.
  const exclusiveHarnesses = new Set(harnessing?.exclusive ?? []);
  const now = harnessing?.now ?? Date.now;
  const setTimer = harnessing?.setTimer ?? setTimeout;
  const clearTimer = harnessing?.clearTimer ?? clearTimeout;
  /** @type {Map<string, HarnessHealth>} harness name → its breaker entry (absent = up) */
  const health = new Map();
  for (const [name, h] of Object.entries(harnessing?.health ?? {})) {
    const until = Date.parse(h?.until);
    if (Object.hasOwn(harnessCaps, name) && Number.isFinite(until)) health.set(name, { until, strikes: Number.isInteger(h.strikes) && h.strikes > 0 ? h.strikes : 1, reason: String(h.reason ?? ""), ...(h?.cause ? { cause: h.cause } : { cause: "health" }) });
  }
  /** Step ids whose unharnessed claude runs share the quota group (a pipeline job waits while the gate holds). */
  const unharnessedShared = new Set(harnessing?.unharnessedShared ?? []);
  /** The unharnessed gate's deadline (ms epoch) while the shared group is quota-closed; null = open. */
  /** @type {number|null} */
  let unharnessedUntil = null;
  const seededGate = harnessing?.unharnessedUntil;
  if (typeof seededGate === "string" && Number.isFinite(Date.parse(seededGate))) unharnessedUntil = Date.parse(seededGate);
  const unharnessedAgents = new Map(Object.entries(harnessing?.unharnessedAgents ?? {}));
  /** @param {string} name @returns {'up'|'down'|'probing'} */
  const healthOf = (name) => {
    const h = health.get(name);
    if (!h) return "up";
    if (now() < h.until) return "down";
    return h.cause === "quota" ? "up" : "probing";
  };
  /** The earliest quota deadline (entry or unharnessed gate), or null when none is set. */
  const quotaDeadline = () => {
    let d = Infinity;
    for (const [, h] of health) if (h.cause === "quota" && h.until < d) d = h.until;
    if (unharnessedUntil !== null && unharnessedUntil < d) d = unharnessedUntil;
    return d === Infinity ? null : d;
  };
  const persistHealth = () => {
    /** @type {Record<string, {until: string, strikes: number, reason: string, cause: 'health'|'quota'}>} */
    const down = {};
    for (const [name, h] of health) down[name] = { until: new Date(h.until).toISOString(), strikes: h.strikes, reason: h.reason, cause: h.cause ?? "health" };
    try {
      harnessing?.onHealth?.(down, unharnessedUntil === null ? null : new Date(unharnessedUntil).toISOString());
    } catch (e) {
      console.error(`[harness] health write failed (continuing): ${e.message}`);
    }
  };
  // The quota reopen timer: one unref'd one-shot at the earliest quota `until` (a deadline, never a
  // poll), clamped like src/shared/quota.js MAX_TIMER_MS and re-armed when it fires before the deadline.
  const MAX_TIMER_MS = 2 ** 31 - 1;
  /** @type {NodeJS.Timeout|undefined} */
  let quotaTimer;
  const armQuotaTimer = () => {
    if (quotaTimer !== undefined) clearTimer(quotaTimer);
    quotaTimer = undefined;
    const d = quotaDeadline();
    if (d === null) return;
    quotaTimer = setTimer(onQuotaTimer, Math.min(Math.max(0, d - now()), MAX_TIMER_MS));
    quotaTimer?.unref?.();
  };
  function onQuotaTimer() {
    quotaTimer = undefined;
    const d = quotaDeadline();
    if (d === null) return;
    if (d > now()) return armQuotaTimer(); // a clamped long wait fired early: re-arm for the remainder
    /** @type {string[]} */
    const opened = [];
    for (const [name, h] of [...health]) {
      if (h.cause === "quota" && h.until <= now()) {
        health.delete(name);
        opened.push(name);
      }
    }
    let gateOpened = false;
    if (unharnessedUntil !== null && unharnessedUntil <= now()) {
      unharnessedUntil = null;
      gateOpened = true;
    }
    if (opened.length || gateOpened) {
      persistHealth();
      for (const name of opened) {
        console.log(`[harness] ${name} quota window reset — back up`);
        harnessing?.onHarnessUp?.(name, { cause: "quota" });
      }
      report();
      pump();
    }
    armQuotaTimer(); // any later deadline still ahead
  }
  // Live, not a const: a reload can add the first step cap (turning capping on) or remove the last.
  const capping = () => caps.size > 0 || harnessSteps.size > 0 || !!harnessing;
  // Re-arm on boot: a persisted quota closure must reopen (and emit harness_up) without a new reading.
  armQuotaTimer();
  /** @type {Map<string, number>} stepId → running pipeline jobs of that step */
  const activeByStep = new Map();
  /** @type {Map<string, number>} harness name → running jobs on it */
  const activeByHarness = new Map();
  /** @type {Map<string, number>} agent CLI name → running pipeline jobs on a harness-less step that spawns it */
  const activeByAgent = new Map();
  /** @type {Map<string, number>} stepId → its round-robin cursor (the next list index to try) */
  const rrNext = new Map();
  /** @param {import('./types/pipeline.js').Job} job */
  const isPipeline = (job) => (job.kind ?? "pipeline") === "pipeline";
  /** @param {import('./types/pipeline.js').Job} job  true while `job`'s step is at its cap (it must wait) */
  const atCap = (job) => {
    const cap = isPipeline(job) ? caps.get(job.stepId) : undefined;
    return cap != null && (activeByStep.get(job.stepId) ?? 0) >= cap;
  };
  /** @param {string} name  true while `name` has a free slot (an uncapped harness always does); a down harness has none, a probing one only while idle */
  const hasRoom = (name) => {
    const n = activeByHarness.get(name) ?? 0;
    const h = healthOf(name);
    if (h === "down" || (h === "probing" && n > 0)) return false;
    const cap = Object.hasOwn(harnessCaps, name) ? harnessCaps[name] : undefined;
    return cap == null || n < cap;
  };
  /**
   * A settle on `name`: a health signal opens (or re-opens) its breaker, a healthy settle closes a
   * probing one. A trip from a run that started before the harness went down changes nothing.
   * @param {string} name @param {{reason: string}|undefined} signal
   */
  const settleHealth = (name, signal) => {
    if (!Object.hasOwn(harnessCaps, name)) return; // a harness removed by a reload never re-trips
    const h = healthOf(name);
    const cur = health.get(name);
    if (signal && h !== "down") {
      const strikes = cur ? cur.strikes + 1 : 1;
      const cd = cooldowns[name] ?? DEFAULT_COOLDOWN_MINUTES;
      const until = now() + cooldownFor(cd, strikes) * 60000;
      health.set(name, { until, strikes, reason: signal.reason, cause: "health" });
      persistHealth();
      console.warn(`[harness] ${name} down until ${new Date(until).toISOString()} (${signal.reason})`);
      harnessing?.onHarnessDown?.(name, { reason: signal.reason, until: new Date(until).toISOString(), cause: "health" });
    } else if (!signal && h === "probing") {
      health.delete(name);
      persistHealth();
      console.log(`[harness] ${name} up again`);
      harnessing?.onHarnessUp?.(name, { cause: "health" });
    }
  };
  /** @param {import('./types/pipeline.js').Job} job  its step's harness routing, when it has one */
  const routingOf = (job) => (isPipeline(job) ? harnessSteps.get(job.stepId) : undefined);
  /** @param {string} name  true while `name` is not down (probing counts as open) and not drained to 0 — an alternative a job may still spill into, even while full */
  const harnessOpen = (name) => {
    if (healthOf(name) === "down") return false;
    const cap = Object.hasOwn(harnessCaps, name) ? harnessCaps[name] : undefined;
    return cap !== 0;
  };
  /** @param {import('./types/pipeline.js').Job} job @param {string} name  true while `job`'s step lists another harness besides `name` that is open right now (#745) */
  const openAlt = (job, name) => {
    const r = routingOf(job);
    return !!r?.harnesses.some((n) => n !== name && harnessOpen(n));
  };
  /**
   * `hasRoom(name)` plus the reserve rule (#745): a job with an open alternative to an exclusive
   * harness `name` may take a slot there only while `active+1` still fits under its live cap
   * minus its reserve. A job with no open alternative, or a non-exclusive/uncapped harness, is
   * unaffected — same as plain `hasRoom`.
   * @param {import('./types/pipeline.js').Job} job @param {string} name
   */
  const roomFor = (job, name) => {
    if (!hasRoom(name)) return false;
    if (!exclusiveHarnesses.has(name) || !openAlt(job, name)) return true;
    const cap = Object.hasOwn(harnessCaps, name) ? harnessCaps[name] : undefined;
    if (cap == null) return true; // a reserve is meaningless on an uncapped harness
    const reserve = reserves[name] ?? 0;
    return (activeByHarness.get(name) ?? 0) + 1 <= cap - reserve;
  };
  /** @param {import('./types/pipeline.js').Job} job  true while `job` must wait: its step's cap, every one of its harnesses full or reserved against it, or the unharnessed quota gate holds its shared step */
  const blocked = (job) => atCap(job) || !!routingOf(job)?.harnesses.every((n) => !roomFor(job, n)) || (isPipeline(job) && unharnessedUntil !== null && now() < unharnessedUntil && unharnessedShared.has(job.stepId));
  /**
   * True while `job` is blocked ONLY by a reserve (#745): some harness in its list has a free
   * slot, but none of them clears `roomFor` for this job, and no step cap or quota gate applies.
   * @param {import('./types/pipeline.js').Job} job
   */
  const reserveWait = (job) => {
    if (atCap(job)) return false;
    if (isPipeline(job) && unharnessedUntil !== null && now() < unharnessedUntil && unharnessedShared.has(job.stepId)) return false;
    const r = routingOf(job);
    if (!r?.harnesses.length) return false;
    return r.harnesses.some((n) => hasRoom(n)) && !r.harnesses.some((n) => roomFor(job, n));
  };
  /**
   * The harness `job` starts on (undefined when its step has none, or all are full/reserved):
   * first-free takes the first listed one with room; round-robin starts at the step's cursor and
   * skips full ones, then moves the cursor past its pick. `commit` false peeks the pick without
   * advancing the round-robin cursor (#745's Rule 2 checks where a job WOULD land before
   * deciding whether to start it this pass).
   * @param {import('./types/pipeline.js').Job} job @param {{commit?: boolean}} [opts]
   */
  const pickHarness = (job, { commit = true } = {}) => {
    const r = routingOf(job);
    if (!r?.harnesses.length) return undefined;
    const list = r.harnesses;
    if (r.routing !== "round-robin") return list.find((n) => roomFor(job, n));
    const start = (rrNext.get(job.stepId) ?? 0) % list.length;
    for (let k = 0; k < list.length; k++) {
      const i = (start + k) % list.length;
      if (!roomFor(job, list[i])) continue;
      if (commit) rrNext.set(job.stepId, i + 1);
      return list[i];
    }
    return undefined;
  };
  /** @returns {Record<string, HarnessSlots>} every configured harness's slots and breaker state */
  const harnessState = () => {
    /** @type {Record<string, HarnessSlots>} */
    const out = {};
    for (const [name, cap] of Object.entries(harnessCaps)) {
      const state = healthOf(name);
      const h = health.get(name);
      const reserve = reserves[name] ?? 0;
      // A lazily-expired quota entry reads "up" (never "probing") — report it plain until the
      // reopen timer drops it, so no `until`/`reason`/`cause` leak onto an up harness.
      out[name] = {
        active: activeByHarness.get(name) ?? 0,
        max: cap ?? null,
        state,
        ...(reserve > 0 ? { reserve } : {}),
        ...(h && state !== "up" ? { until: new Date(h.until).toISOString(), reason: h.reason, cause: h.cause ?? "health" } : {}),
      };
    }
    return out;
  };
  const cappedCount = () => (capping() ? queue.filter(blocked).length : 0);
  /** @type {import('./types/pipeline.js').Job[]} */
  const queue = [];
  // Work-level coalescing: one (ref,stepId) may be queued-or-active at most once.
  // The engine's `seen` set dedups by EVENT key, but a single user action can emit
  // two events with different keys (task `added` -> step:<id>:<gid> AND story
  // `section_changed` -> secmove:<storyGid>) that resolve to the same step — both
  // clear `seen` and would spawn two `claude -p` on the same task/step. This drops
  // the second; a later legit re-entry (next step, or a `changes` rework) carries a
  // different stepId, or arrives after this key is cleared on completion. A `merge`
  // job is keyed apart from pipeline jobs: it moves the task into its completeOnMerge
  // step, and that step's own pipeline job must not be coalesced away behind it. A `ci`
  // job is keyed by its run+attempt: two red workflows on one ref each get handled.
  const inflight = new Set();
  /** @param {import('./types/pipeline.js').Job} job */
  const workKey = (job) =>
    job.kind === "ci" ? job.dedupKey : `${job.kind === "pipeline" ? "" : `${job.kind}:`}${job.ref}:${job.stepId ?? job.dedupKey}`;
  /** @type {Map<string, (() => void)[]>} work key -> waiters for that key to leave the queue/finish */
  const freeWaiters = new Map();
  /** @type {Map<string, number>} ref -> its queued + active jobs (any kind) */
  const byRef = new Map();
  /** @type {Map<string, (() => void)[]>} ref -> waiters for its last job to leave the queue/settle */
  const refWaiters = new Map();
  /** One of `ref`'s jobs left the queue or settled; at zero, wake its waiters. @param {string} ref */
  const releaseRef = (ref) => {
    const n = (byRef.get(ref) ?? 1) - 1;
    if (n > 0) return void byRef.set(ref, n);
    byRef.delete(ref);
    const waiters = refWaiters.get(ref) ?? [];
    refWaiters.delete(ref);
    for (const w of waiters) w();
  };
  let active = 0;
  let closed = false; // drain: refuse new work, let in-flight + queued finish
  let paused = false; // restart pending: accept + persist new work, but start nothing
  /** @type {(() => void)[]} */
  let idleWaiters = [];
  /** @type {(() => void)[]} */
  let activeIdleWaiters = [];
  /** Pipeline jobs waiting only on a reserve (#745) — {ref, stepId, harnesses} per job, [] when none. */
  const reservedJobs = () =>
    harnessing
      ? queue.filter((j) => isPipeline(j) && reserveWait(j)).map((j) => ({ ref: j.ref, stepId: j.stepId, harnesses: routingOf(j)?.harnesses ?? [] }))
      : [];
  const snapshot = () => {
    const reserved = reservedJobs();
    return {
      active,
      queued: queue.length,
      ...(capping() ? { capped: cappedCount() } : {}),
      ...(harnessing ? { harnesses: harnessState() } : {}),
      ...(harnessing && activeByAgent.size ? { unharnessed: Object.fromEntries(activeByAgent) } : {}),
      ...(reserved.length ? { reserved } : {}),
    };
  };
  const report = () => onChange?.(snapshot());
  const resolveIdle = () => {
    if (active === 0 && queue.length === 0 && idleWaiters.length) {
      const waiters = idleWaiters;
      idleWaiters = [];
      for (const w of waiters) w();
    }
  };
  const resolveActiveIdle = () => {
    if (active === 0 && activeIdleWaiters.length) {
      const waiters = activeIdleWaiters;
      activeIdleWaiters = [];
      for (const w of waiters) w();
    }
  };

  function pump() {
    while (!paused && active < max && queue.length) {
      // First waiting job whose step is under its cap and has a harness with room: a capped
      // job never blocks the startable ones behind it, and the jobs left behind keep their
      // relative order.
      let i = capping() ? queue.findIndex((j) => !blocked(j)) : 0;
      if (i < 0) break;
      // Rule 2 (#745): if that job would spill onto an exclusive harness it has an open
      // alternative to, prefer instead the first startable job that has NO open alternative and
      // can use that same harness — the spiller keeps its place and is reconsidered next pass.
      if (capping()) {
        const spiller = queue[i];
        const spillHarness = isPipeline(spiller) ? pickHarness(spiller, { commit: false }) : undefined;
        if (spillHarness && exclusiveHarnesses.has(spillHarness) && openAlt(spiller, spillHarness)) {
          const preferred = queue.findIndex(
            (j, idx) =>
              idx !== i &&
              isPipeline(j) &&
              !blocked(j) &&
              !openAlt(j, spillHarness) &&
              routingOf(j)?.harnesses.includes(spillHarness) &&
              roomFor(j, spillHarness),
          );
          if (preferred >= 0) i = preferred;
        }
      }
      const [job] = queue.splice(i, 1);
      if (!job) break;
      persist?.onRemove?.(job);
      // The harness is picked here, never trusted from the job (a restored entry may name one
      // since renamed or removed).
      if (job.harness != null && !Object.hasOwn(harnessCaps, job.harness)) console.warn(`[harness] ${job.harness} on ${job.ref} unknown, re-routing`);
      delete job.harness;
      const harness = pickHarness(job);
      if (harness) {
        job.harness = harness;
        activeByHarness.set(harness, (activeByHarness.get(harness) ?? 0) + 1);
      }
      const agent = !harness && isPipeline(job) ? unharnessedAgents.get(job.stepId) : undefined;
      if (agent) activeByAgent.set(agent, (activeByAgent.get(agent) ?? 0) + 1);
      active++;
      if (isPipeline(job)) activeByStep.set(job.stepId, (activeByStep.get(job.stepId) ?? 0) + 1);
      report();
      console.log(`[start] ${job.kind} ${job.ref}${harness ? ` on ${harness}` : ""} (running ${active}/${max}, ${queue.length} queued)`);
      /** @type {Awaited<ReturnType<typeof run>>['health']} */
      let signal;
      run(job)
        .then((info) => {
          signal = info?.health;
          const left = active - 1 + queue.length;
          console.log(
            `[done] ${info.kind} "${info.name}" exited ${info.code} — ` +
              `${active - 1} running, ${queue.length} queued (${left} left)\n        review: ${info.url}`,
          );
          if (left === 0) console.log(`[idle] all agents done, queue empty`);
        })
        .catch((e) => {
          const left = active - 1 + queue.length;
          console.error(`[done] ${job.kind} ${job.ref} FAILED: ${e.message} — ${left} left`);
        })
        .finally(() => {
          active--;
          if (isPipeline(job)) {
            const n = (activeByStep.get(job.stepId) ?? 1) - 1;
            if (n > 0) activeByStep.set(job.stepId, n);
            else activeByStep.delete(job.stepId);
          }
          if (harness) {
            const n = (activeByHarness.get(harness) ?? 1) - 1;
            if (n > 0) activeByHarness.set(harness, n);
            else activeByHarness.delete(harness);
            settleHealth(harness, signal);
          }
          if (agent) {
            const n = (activeByAgent.get(agent) ?? 1) - 1;
            if (n > 0) activeByAgent.set(agent, n);
            else activeByAgent.delete(agent);
          }
          if (harness && signal?.requeue) {
            // Back to the front, still in flight: its work key and ref count stay, so no duplicate
            // is coalesced in and no whenFree/whenRefFree waiter fires. pump re-picks the harness.
            delete job.harness;
            queue.unshift(job);
            persist?.onAdd?.(job, { front: true });
          } else {
            inflight.delete(workKey(job));
            for (const w of freeWaiters.get(workKey(job)) ?? []) w();
            freeWaiters.delete(workKey(job));
            releaseRef(job.ref);
          }
          report();
          pump();
          resolveIdle();
          resolveActiveIdle();
          if (!closed) persist?.onSettle?.();
        });
    }
  }

  return {
    /** @param {import('./types/pipeline.js').Job} job @returns {boolean} accepted */
    enqueue(job) {
      if (closed) {
        console.warn(`[drain] refusing ${job.kind} ${job.ref} — shutting down`);
        return false;
      }
      const key = workKey(job);
      if (inflight.has(key)) {
        console.warn(`[coalesce] ${job.kind} ${job.ref} step ${job.stepId} already queued/running — dropping duplicate`);
        return false;
      }
      inflight.add(key);
      byRef.set(job.ref, (byRef.get(job.ref) ?? 0) + 1);
      queue.push(job);
      persist?.onAdd?.(job);
      report();
      pump();
      return true;
    },
    /** Stop accepting new jobs (in-flight + already-queued still run to completion). */
    close() {
      closed = true;
    },
    /** Stop starting jobs; enqueue still accepts + persists (onAdd). Running jobs finish. */
    pause() {
      paused = true;
    },
    /** Start pumping again (drains whatever queued up while paused). */
    resume() {
      paused = false;
      pump();
    },
    /** True while `job`'s (ref, step) is queued or running — an enqueue of it would be coalesced away. @param {import('./types/pipeline.js').Job} job */
    has: (job) => inflight.has(workKey(job)),
    /** True once `close()` has been called — a refused enqueue past this point is draining, not a coalesced duplicate. */
    isClosed: () => closed,
    /**
     * Resolve true once `job`'s (ref, step) is no longer queued/running (immediately if it is not),
     * false after `timeoutMs`. Event-driven: woken by the run settling, no polling. For a caller that
     * must enqueue right after an event announcing the previous run's verdict, which lands a few
     * hundred ms before the run's own cleanup (label move) finishes.
     * @param {import('./types/pipeline.js').Job} job @param {number} timeoutMs @returns {Promise<boolean>}
     */
    whenFree(job, timeoutMs) {
      const key = workKey(job);
      if (!inflight.has(key)) return Promise.resolve(true);
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          const rest = (freeWaiters.get(key) ?? []).filter((w) => w !== wake);
          if (rest.length) freeWaiters.set(key, rest);
          else freeWaiters.delete(key);
          resolve(false);
        }, timeoutMs);
        const wake = () => {
          clearTimeout(timer);
          resolve(true);
        };
        freeWaiters.set(key, [...(freeWaiters.get(key) ?? []), wake]);
      });
    },
    /** True while any job for `ref` (any step or kind) is queued or running. @param {string} ref */
    hasRef: (ref) => byRef.has(ref),
    /**
     * Call `fn` once `ref` has no queued or running job — synchronously now if it has none, else
     * from the settle of its last one, AFTER that run's promise (and all its cleanup) resolved.
     * Event-driven, no timeout: the push sink parks a ref's next job here (see engine.js).
     * @param {string} ref @param {() => void} fn
     */
    whenRefFree(ref, fn) {
      if (!byRef.has(ref)) return fn();
      refWaiters.set(ref, [...(refWaiters.get(ref) ?? []), fn]);
    },
    /**
     * {active, queued} snapshot; `capped` (waiting jobs whose step is at its cap, or whose harnesses
     * are all full or down) only when step caps or harnesses are set; `harnesses` ({[name]: {active,
     * max, state, until?, reason?}}) only when the profile has harnesses; `unharnessed` ({[agent]:
     * count}) only when harnesses are set and at least one pipeline job is running on a
     * harness-less step.
     */
    state: snapshot,
    /** Every configured harness's {active, max, state, until?, reason?, cause?} (max null = uncapped) — the puller's harness budget; {} without harnesses. */
    harnessState,
    /**
     * Close a subscription group for quota (src/engine `createHarnessQuota`): every named harness
     * gets a `cause:"quota"` entry, and `unharnessed` also sets the queue-level gate that waits the
     * profile's unharnessed shared claude steps. A quota entry never adds strikes; it reads `down`
     * until `until`, then `up` (never `probing`). It never shortens a harness already health-down
     * past `until`, never shortens (or re-emits) a harness already quota-closed to a later `until`,
     * and an identical closure is a no-op. Re-arms the one-shot reopen timer.
     * @param {string[]} names
     * @param {{until: number, reason: string, unharnessed?: boolean, window?: 'sevenDay'|'fiveHour', utilization?: number, threshold?: number}} opts
     */
    closeForQuota(names, { until, reason, unharnessed = false, window, utilization, threshold }) {
      let changed = false;
      for (const name of names) {
        const cur = health.get(name);
        if (cur && cur.cause !== "quota" && cur.until > until) continue; // a longer health-down stands
        if (cur?.cause === "quota" && cur.until >= until) continue; // never shorten a quota closure, nor re-emit on a slightly different reading
        health.set(name, { until, strikes: cur?.strikes ?? 0, reason, cause: "quota" });
        console.log(`[harness] ${name} closed for quota until ${new Date(until).toISOString()}`);
        harnessing?.onHarnessDown?.(name, { reason, until: new Date(until).toISOString(), cause: "quota", ...(window ? { window, utilization, threshold } : {}) });
        changed = true;
      }
      if (unharnessed && (unharnessedUntil === null || until > unharnessedUntil)) {
        unharnessedUntil = until;
        changed = true;
      }
      if (changed) {
        persistHealth();
        armQuotaTimer();
        report();
        pump();
      }
    },
    /**
     * Close `name`'s breaker now (the `harness_reset` op): drop its entry, persist, report
     * `onHarnessUp` (with the entry's `cause`) when it was down or probing, then start waiting
     * work. `reset:false` (and null cause/until) when it was up.
     * @param {string} name @returns {{reset: boolean, cause: 'health'|'quota'|null, until: number|null}}
     */
    resetHarness(name) {
      const entry = health.get(name);
      if (!entry) return { reset: false, cause: null, until: null };
      health.delete(name);
      persistHealth();
      harnessing?.onHarnessUp?.(name, { cause: entry.cause ?? "health" });
      report();
      pump();
      return { reset: true, cause: entry.cause ?? "health", until: entry.until };
    },
    /** Disarm the quota reopen timer (shutdown). */
    stop() {
      if (quotaTimer !== undefined) clearTimer(quotaTimer);
      quotaTimer = undefined;
    },
    /**
     * Per-step counts of PIPELINE jobs: {[stepId]: {active, queued}} — the puller's per-step budget.
     * @returns {Record<string, {active: number, queued: number}>}
     */
    stepState() {
      /** @type {Record<string, {active: number, queued: number}>} */
      const out = {};
      const at = (/** @type {string} */ id) => (out[id] ??= { active: 0, queued: 0 });
      for (const [id, n] of activeByStep) at(id).active = n;
      for (const j of queue) if (isPipeline(j)) at(j.stepId).queued++;
      return out;
    },
    /** Whether new runs are held back (restart/decommission/operator pause). */
    isPaused: () => paused,
    /** Current concurrency cap. */
    max: () => max,
    /** Change the concurrency cap at runtime (not persisted to config); a raise starts waiting jobs now. @param {number} n */
    setMax(n) {
      max = n;
      report();
      pump();
    },
    /**
     * Change one named harness's slot cap at runtime (not persisted to config). 0 drains the
     * harness: `hasRoom` is false until raised again, so no new starts while running agents
     * finish. Lowering it below its running count kills nothing — it only gates new starts; a
     * raise starts waiting jobs now. `null` resets it to unbounded (only the global cap). Throws
     * for a name that isn't a configured harness.
     * @param {string} name @param {number | null} n
     */
    setHarnessMax(name, n) {
      if (!Object.hasOwn(harnessCaps, name)) throw new Error(`unknown harness "${name}"`);
      harnessCaps[name] = n ?? undefined;
      report();
      pump();
    },
    /**
     * Apply a reloaded config (#725): replace the copied maps with the freshly built shapes so
     * runs that start after this pick up the new values, then pump so waiting jobs re-route.
     * Active runs keep the harness they resolved at start (a removed harness's runs still count
     * until they settle — nothing here crashes on them). `overrides` (the surviving operator
     * overrides, pruned to the new config by the caller) are applied *before* the pump, so a
     * per-harness slot override still wins over the new cap and a `maxConcurrent` override over
     * the new global max — a drained harness stays drained through the reload. Breaker `health`
     * entries for harnesses removed from the config are dropped and persisted (`onHealth`).
     * @param {{max?: number, stepCaps?: Record<string, number>, steps?: Record<string, {harnesses: string[], routing?: 'first-free'|'round-robin'}>, caps?: Record<string, number|undefined>, cooldowns?: Record<string, number|undefined>, reserves?: Record<string, number>, exclusive?: string[], unharnessedShared?: string[], unharnessedAgents?: Record<string, string>}} next
     * @param {{maxConcurrent?: number, harnesses?: Record<string, number>}} [overrides]
     */
    reconfigure(
      { max: nextMax, stepCaps: nextStepCaps, steps: nextSteps, caps: nextHarnessCaps, cooldowns: nextCooldowns, reserves: nextReserves, exclusive: nextExclusive, unharnessedShared: nextShared, unharnessedAgents: nextAgents },
      overrides = {},
    ) {
      if (nextMax !== undefined) max = nextMax;
      caps.clear();
      for (const [id, n] of Object.entries(nextStepCaps ?? {})) caps.set(id, n);
      harnessSteps.clear();
      for (const [id, r] of Object.entries(nextSteps ?? {})) harnessSteps.set(id, r);
      for (const name of Object.keys(harnessCaps)) delete harnessCaps[name];
      Object.assign(harnessCaps, nextHarnessCaps ?? {});
      for (const name of Object.keys(cooldowns)) delete cooldowns[name];
      Object.assign(cooldowns, nextCooldowns ?? {});
      for (const name of Object.keys(reserves)) delete reserves[name];
      Object.assign(reserves, nextReserves ?? {});
      exclusiveHarnesses.clear();
      for (const name of nextExclusive ?? []) exclusiveHarnesses.add(name);
      unharnessedShared.clear();
      for (const id of nextShared ?? []) unharnessedShared.add(id);
      unharnessedAgents.clear();
      for (const [id, agent] of Object.entries(nextAgents ?? {})) unharnessedAgents.set(id, agent);
      // Drop breaker entries for harnesses no longer in the config, then persist what remains.
      for (const name of [...health.keys()]) if (!Object.hasOwn(harnessCaps, name)) health.delete(name);
      persistHealth();
      // Operator overrides win over the new config values — applied before the pump so the queue
      // re-routes waiting jobs under the override caps, not the freshly loaded ones.
      if (overrides.maxConcurrent !== undefined) max = overrides.maxConcurrent;
      for (const [name, n] of Object.entries(overrides.harnesses ?? {})) {
        if (Object.hasOwn(harnessCaps, name)) harnessCaps[name] = n;
      }
      report();
      pump();
    },
    /**
     * Drop WAITING jobs for `ref` (optionally only `stepId`) — never a running one. Fires
     * `onRemove` per job so queue.json follows. Returns the dropped jobs. `only` narrows it
     * further (e.g. pipeline jobs only).
     * @param {string} ref @param {string} [stepId]
     * @param {(job: import('./types/pipeline.js').Job) => boolean} [only]
     */
    remove(ref, stepId, only) {
      /** @type {import('./types/pipeline.js').Job[]} */
      const dropped = [];
      for (let i = queue.length - 1; i >= 0; i--) {
        const j = queue[i];
        if (j.ref !== ref || (stepId && j.stepId !== stepId) || (only && !only(j))) continue;
        queue.splice(i, 1);
        inflight.delete(workKey(j));
        persist?.onRemove?.(j);
        releaseRef(j.ref);
        dropped.unshift(j);
      }
      if (dropped.length) {
        report();
        resolveIdle();
      }
      return dropped;
    },
    /** Resolves once nothing is running and the queue is empty. Immediate if idle now. */
    onIdle() {
      if (active === 0 && queue.length === 0) return Promise.resolve();
      return /** @type {Promise<void>} */ (
        new Promise((resolve) => idleWaiters.push(() => resolve(undefined)))
      );
    },
    /** Resolves once nothing is running, ignoring queued jobs (a paused queue's wait). Immediate if 0 now. */
    onActiveIdle() {
      if (active === 0) return Promise.resolve();
      return /** @type {Promise<void>} */ (
        new Promise((resolve) => activeIdleWaiters.push(() => resolve(undefined)))
      );
    },
  };
}
