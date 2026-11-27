// The engine's pause controllers: the control-socket `restart` / `decommission` requesters
// (pause, wait for 0 active agents, fire) and the opt-in quota pacer wiring.
import { appendControlAudit } from "../ops.js";
import { createQuotaPacer, evaluateQuota } from "../shared/quota.js";
import { writeQuota } from "../quota-file.js";
import { quotaGroupOf } from "../dispatch/harness.js";
import { diffConfig } from "../config-reload.js";
import { buildHarnessing } from "./harnessing.js";
import { pruneOverrides, heartbeatOverrides } from "../overrides.js";

/**
 * The control-socket `restart` request: validate, then pause the queue and fire once
 * active agents reach 0. Returns immediately; the fire runs in the background. Every refusal is
 * thrown exposed (bounded), so the client sees the reason, not the socket's opaque "restart
 * failed"; the config-check refusal additionally names `agenthook stop && agenthook start` as the
 * escape, because that check runs in the running receiver's in-memory code. An optional
 * `moveTo` (a state key) is validated up front too and handed to `fire`; while one restart is
 * pending, a request naming a different `moveTo` is rejected (a plain one is alreadyPending).
 * @param {{
 *   queue: {pause(): void, state(): {active:number, queued:number}, onActiveIdle(): Promise<void>},
 *   isDraining: () => boolean,
 *   validateConfig: () => void,
 *   validateMove?: (moveTo: string) => void,
 *   isDecommissionPending?: () => boolean,
 *   harnessesDown?: () => {harness: string, until: string, reason?: string}[],
 *   onPending: (state: {active:number, queued:number, moveTo?: string}) => void,
 *   fire: (moveTo?: string) => void | Promise<void>,
 * }} deps  validateConfig throws on a config that would brick the respawn; validateMove throws
 *   on a move that can't happen; isDecommissionPending rejects a restart while a decommission
 *   waits; harnessesDown reports breakers that are down (they survive the restart; this is
 *   informational, surfaced to the operator so they know to `harness_reset`); onPending does
 *   the heartbeat + event; fire runs the graceful shutdown-with-respawn
 * @returns {{request(args: any): Promise<{accepted: true, alreadyPending?: true, active: number, queued: number, harnessesDown?: {harness: string, until: string, reason?: string}[]}>, isPending(): boolean}}
 */
export function createRestartRequester({ queue, isDraining, validateConfig, validateMove, isDecommissionPending, harnessesDown, onPending, fire }) {
  let pending = false;
  /** @type {string|undefined} */
  let pendingMove;
  const down = () => {
    const list = harnessesDown?.() ?? [];
    return list.length ? { harnessesDown: list } : {};
  };
  // Refusals are the operator's answer — expose them to the client (bounded, like ops.js does for
  // operator commands), never the opaque "<cmd> failed" the control socket defaults to.
  const MAX_REASON_CHARS = 500;
  const MAX_CONFIG_REASON_CHARS = 300;
  /** @param {unknown} msg @returns {Error & {expose: boolean}} */
  const exposed = (msg) => {
    const s = String(msg);
    return Object.assign(new Error(s.length > MAX_REASON_CHARS ? s.slice(0, MAX_REASON_CHARS - 1) + "…" : s), { expose: true });
  };
  /** @param {string} msg @returns {never} */
  const refuse = (msg) => {
    throw exposed(msg);
  };
  return {
    isPending: () => pending,
    async request(args) {
      if (args?.when !== "idle") refuse(`restart: unsupported when ${JSON.stringify(args?.when)} (only "idle")`);
      const moveTo = args.moveTo;
      if (moveTo !== undefined && typeof moveTo !== "string") refuse("restart: moveTo must be a string");
      if (isDraining()) refuse("restart: shutdown already in progress");
      if (isDecommissionPending?.()) refuse("restart: a decommission is pending");
      const { active, queued } = queue.state();
      if (pending) {
        if (moveTo !== undefined && moveTo !== pendingMove) {
          refuse(`restart: a restart ${pendingMove ? `moving to "${pendingMove}"` : "without a move"} is already pending`);
        }
        return { accepted: true, alreadyPending: true, active, queued, ...down() };
      }
      try {
        validateConfig(); // a bad config on disk rejects the restart — nothing changes
      } catch (e) {
        // This check ran in the RUNNING receiver (its in-memory code), so a config valid for the
        // code on disk can still fail it — name the escape. The reason is bounded BEFORE the hint
        // is appended so the hint is never cut off. Never loosen the check or auto stop/start.
        const reason = String(e?.message ?? e);
        const bound = reason.length > MAX_CONFIG_REASON_CHARS ? reason.slice(0, MAX_CONFIG_REASON_CHARS - 1) + "…" : reason;
        throw exposed(`restart: config check failed in the running receiver (its code may be older than the code on disk): ${bound} — if the config is valid for the code on disk, run \`agenthook stop && agenthook start\``);
      }
      if (moveTo !== undefined) {
        if (!validateMove) refuse("restart: moveTo is not supported");
        try {
          validateMove(moveTo); // a bad target rejects the restart — nothing paused
        } catch (e) {
          throw exposed(e?.message ?? e);
        }
      }
      pending = true;
      pendingMove = moveTo;
      queue.pause();
      onPending({ active, queued, ...(moveTo !== undefined && { moveTo }) });
      queue
        .onActiveIdle()
        // setImmediate: let the control reply flush before teardown closes the socket.
        .then(() => new Promise((resolve) => setImmediate(resolve)))
        .then(() => (isDraining() ? undefined : fire(moveTo))) // a signal took over: no respawn
        .catch((e) => console.error(`[restart] failed: ${e.message}`));
      return { accepted: true, active, queued, ...down() };
    },
  };
}

/**
 * The control-socket `decommission` request: validate, then pause the queue and fire once
 * active agents reach 0 (the restart requester's shape). Returns immediately; the fire runs in
 * the background. `unregister` (default true) is handed to `fire`. Mutually exclusive with a
 * pending restart.
 * @param {{
 *   queue: {pause(): void, state(): {active:number, queued:number}, onActiveIdle(): Promise<void>},
 *   isDraining: () => boolean,
 *   isRestartPending: () => boolean,
 *   onPending: (state: {active:number, queued:number, unregister: boolean}) => void,
 *   fire: (opts: {unregister: boolean}) => void | Promise<void>,
 * }} deps  onPending does the log + heartbeat + event; fire unregisters the webhooks and runs the
 *   graceful shutdown-with-archive
 * @returns {{request(args: any): Promise<{accepted: true, alreadyPending?: true, active: number, queued: number}>, isPending(): boolean}}
 */
export function createDecommissionRequester({ queue, isDraining, isRestartPending, onPending, fire }) {
  let pending = false;
  return {
    isPending: () => pending,
    async request(args) {
      if (args?.when !== "idle") throw new Error(`decommission: unsupported when ${JSON.stringify(args?.when)} (only "idle")`);
      const unregister = args.unregister === undefined ? true : args.unregister;
      if (typeof unregister !== "boolean") throw new Error("decommission: unregister must be a boolean");
      if (isDraining()) throw new Error("decommission: shutdown already in progress");
      if (isRestartPending()) throw new Error("decommission: a restart is pending");
      const { active, queued } = queue.state();
      if (pending) return { accepted: true, alreadyPending: true, active, queued };
      pending = true;
      queue.pause();
      onPending({ active, queued, unregister });
      queue
        .onActiveIdle()
        // setImmediate: let the control reply flush before teardown closes the socket.
        .then(() => new Promise((resolve) => setImmediate(resolve)))
        .then(() => (isDraining() ? undefined : fire({ unregister }))) // a signal took over: no unregister, no archive
        .catch((e) => console.error(`[decommission] failed: ${e.message}`));
      return { accepted: true, active, queued };
    },
  };
}

/**
 * The engine's quota pacer (src/shared/quota.js `createQuotaPacer`, `cfg.quota`; no thresholds → never
 * pauses): a trip pauses the queue, a release resumes it (+ a backlog pull) only when no operator
 * pause or lock holds it. Each transition is logged, set on the heartbeat (`quotaPaused`), emitted
 * (`quota_pause` / `quota_resume`) and audited to control-audit.jsonl as actor `quota`. The reset
 * wait is one one-shot timer at the window's `resetsAt` — a deadline, not a poll. Running agents
 * are never touched.
 * @param {{
 *   cfg: import('../types/index.js').Config,
 *   queue: {pause(): void, resume(): void},
 *   heartbeat: {update(p: Record<string, any>): void},
 *   emit: (event: string, ref: string, step: string, extra?: Record<string, any>) => void,
 *   pull: () => Promise<void>,
 *   isLocked: () => boolean,
 *   now?: () => number,
 *   setTimer?: (fn: () => void, ms: number) => any,
 *   clearTimer?: (t: any) => void,
 * }} deps
 */
export function createQuotaControl({ cfg, queue, heartbeat, emit, pull, isLocked, now, setTimer, clearTimer }) {
  /** @param {string} cmd @param {Record<string, any>} args */
  const audit = (cmd, args) => appendControlAudit(cfg.stateDir, { ts: new Date().toISOString(), cmd, actor: "quota", args, ok: true });
  return createQuotaPacer({
    thresholds: cfg.quota,
    pauseQueue: () => queue.pause(),
    resumeQueue: () => {
      queue.resume();
      pull().catch((e) => console.warn(`[quota] pull after resume failed: ${e.message}`)); // pulls were skipped while paused
    },
    isLocked,
    now,
    setTimer,
    clearTimer,
    onPause: (trip) => {
      console.log(`[quota] ${trip.window} at ${Math.round(trip.utilization * 100)}% ≥ ${Math.round(trip.threshold * 100)}% — pausing new runs until ${trip.resetsAt}`);
      heartbeat.update({ quotaPaused: trip });
      emit("quota_pause", "", "", { ...trip });
      audit("quota_pause", trip);
    },
    onResume: (info) => {
      console.log(`[quota] ${info.window} pause lifted (${info.reason})`);
      heartbeat.update({ quotaPaused: null });
      emit("quota_resume", "", "", { ...info });
      audit("quota_resume", info);
    },
  });
}

/**
 * The harnessed quota controller (profiles WITH `harnesses`; the receiver-wide `createQuotaControl`
 * is not used in that mode). A reading at/above a `quota` threshold closes the run's subscription
 * group — every harness that shares the run's subscription, plus the unharnessed claude steps for
 * the shared group — until the trip's `resetsAt` (src/queue.js `closeForQuota` reopens on a
 * one-shot timer). `quota.json` and `heartbeat.quota` keep only the shared-group reading; an
 * own-credential harness's reading closes that harness alone and never overwrites the readout.
 * `suppress` (from `harness_reset`) keeps a harness from re-closing by quota until its trip's
 * `resetsAt`, mirroring `createQuotaPacer`'s operator resume override.
 * @param {{
 *   cfg: import('../types/index.js').Config,
 *   queue: {closeForQuota(names: string[], opts: {until: number, reason: string, unharnessed?: boolean, window?: 'sevenDay'|'fiveHour', utilization?: number, threshold?: number}): void},
 *   heartbeat: {update(p: object): void},
 *   now?: () => number,
 * }} deps
 */
export function createHarnessQuota({ cfg, queue, heartbeat, now }) {
  const tnow = now ?? Date.now;
  /** @type {Map<string, number>} harness name → quota override-until (resetsAt), in memory (harness_reset). */
  const suppressed = new Map();
  const stepById = (/** @type {string|undefined} */ stepId) => (cfg.pipeline ?? []).find((s) => s.id === stepId);
  // The shared group, independent of any run: a claude, no-env step is the "default login".
  const sharedGroup = () => quotaGroupOf(cfg, null, { agent: "claude" });

  /** @param {import('../shared/quota.js').QuotaReading|null} q @param {{harness: string|null, stepId: string}|undefined} [meta] */
  function reading(q, meta) {
    const group = meta === undefined ? sharedGroup() : quotaGroupOf(cfg, meta.harness ?? null, stepById(meta.stepId));
    // The profile's readout follows the shared group only — an own-credential reading never overwrites it.
    if (group.unharnessed && q) {
      try {
        writeQuota(cfg.stateDir, q);
      } catch (e) {
        console.error(`[quota] quota.json write failed (continuing): ${e.message}`);
      }
      heartbeat.update({ quota: q });
    }
    const ev = evaluateQuota(q, cfg.quota, tnow());
    if (!ev.pause) return;
    const { pause, ...trip } = ev;
    const names = group.harnesses.filter((n) => (suppressed.get(n) ?? 0) <= tnow());
    if (!names.length && !group.unharnessed) return;
    const until = Date.parse(trip.resetsAt);
    const label = trip.window === "sevenDay" ? "weekly" : "5h";
    const reason = `quota: ${label} ${Math.round(trip.utilization * 100)}% ≥ ${Math.round(trip.threshold * 100)}%, back at ${trip.resetsAt}`;
    queue.closeForQuota(names, { until, reason, unharnessed: group.unharnessed, window: trip.window, utilization: trip.utilization, threshold: trip.threshold });
  }

  return {
    reading,
    /** `harness_reset` on a quota-closed harness: don't re-close it until its trip's `resetsAt`. @param {string} name @param {number} until */
    suppress(name, until) {
      if (until > tnow()) suppressed.set(name, until);
    },
    stop() {},
  };
}

/**
 * The control-socket `reload` request (#725): re-read + validate the config, then apply only the
 * reloadable keys to runs that start after. Running agents keep the config they started with — the
 * shared `cfg` keys are *replaced*, never mutated in place. Refused while a restart/decommission/
 * shutdown holds the queue; an invalid config or any restart-required key applies nothing (the
 * error names every restart-required key). On success emits exactly one `config_reloaded` with the
 * dotted `changed` keys; a no-op emits none. `.env` values already in the process are not re-read.
 * @param {{
 *   cfg: import('../types/index.js').Config,
 *   loadConfig: () => import('../types/index.js').Config,
 *   checkImages?: (next: import('../types/index.js').Config) => Promise<{ok: boolean, reason?: string}>,
 *   isLocked: () => boolean,
 *   store: { getOverrides(): import('../types/index.js').Overrides, setOverrides(o: import('../types/index.js').Overrides): void },
 *   queue: { reconfigure(next: import('./harnessing.js').HarnessingShape & {max?: number}, overrides: {maxConcurrent?: number, harnesses?: Record<string, number>}): void, state(): {active: number, queued: number} },
 *   quotaPacer?: { setThresholds(t: import('../shared/quota.js').QuotaConfig | null | undefined): void },
 *   heartbeat: { update(p: Record<string, unknown>): void },
 *   emit: (event: string, ref: string, step: string, extra?: Record<string, unknown>) => void,
 * }} deps  loadConfig throws on an invalid config (apply nothing); checkImages verifies a newly
 *   gained run image before anything applies; isLocked reflects a restart/decommission/drain.
 * @returns {() => Promise<{changed: string[], note: string}>}
 */
export function createReloadRequester({ cfg, loadConfig, checkImages, isLocked, store, queue, quotaPacer, heartbeat, emit }) {
  return async function reload() {
    if (isLocked()) throw new Error("reload: a restart/decommission/shutdown is pending");
    const next = loadConfig(); // throws on an invalid config → apply nothing
    const { changed, restartRequired } = diffConfig(cfg, next);
    if (restartRequired.length) throw new Error(`reload: restart required for: ${restartRequired.join(", ")}`);
    if (!changed.length) return { changed: [], note: "no changes" };

    if (checkImages) {
      const check = await checkImages(next);
      if (!check.ok) throw new Error(`reload: sandbox check failed: ${check.reason}`);
    }

    // Apply: replace the reloadable keys with `next`'s values. A running run holds the step/harness
    // objects it resolved at start, so replacing these references (never mutating the old objects)
    // is what keeps "running agents keep their config" true.
    cfg.maxConcurrent = next.maxConcurrent;
    cfg.quota = next.quota;
    cfg.harnesses = next.harnesses;
    cfg.pipeline = next.pipeline;
    cfg.tracker.pipeline = /** @type {import('../types/index.js').Step[]} */ (next.pipeline);
    if (cfg.sandbox && next.sandbox) cfg.sandbox = { ...cfg.sandbox, egress: next.sandbox.egress };

    quotaPacer?.setThresholds(next.quota ?? null); // the no-harness pacer re-checks its last reading

    // Re-apply active operator overrides before the queue reconfigure pumps, so an override still
    // wins over the new config value; a harness override for a harness removed from the config is
    // dropped (and persisted).
    const { overrides, dropped } = pruneOverrides(cfg, store.getOverrides());
    for (const line of dropped) console.warn(line);
    if (dropped.length) store.setOverrides(overrides);

    const nextShape = buildHarnessing(cfg);
    queue.reconfigure(
      {
        max: cfg.maxConcurrent,
        stepCaps: nextShape.stepCaps,
        steps: nextShape.steps,
        caps: nextShape.caps,
        cooldowns: nextShape.cooldowns,
        reserves: nextShape.reserves,
        exclusive: nextShape.exclusive,
        unharnessedShared: nextShape.unharnessedShared,
        unharnessedAgents: nextShape.unharnessedAgents,
      },
      { maxConcurrent: overrides.maxConcurrent, harnesses: overrides.harnesses },
    );

    heartbeat.update({
      maxConcurrent: overrides.maxConcurrent !== undefined ? overrides.maxConcurrent : cfg.maxConcurrent,
      overrides: heartbeatOverrides(cfg, overrides),
      queue: queue.state(),
    });

    emit("config_reloaded", "", "", { changed });

    return { changed, note: `reloaded ${changed.length} key(s)` };
  };
}
