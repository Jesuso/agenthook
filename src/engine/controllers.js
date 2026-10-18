// The engine's pause controllers: the control-socket `restart` / `decommission` requesters
// (pause, wait for 0 active agents, fire) and the opt-in quota pacer wiring.
import { appendControlAudit } from "../ops.js";
import { createQuotaPacer } from "../quota.js";

/**
 * The control-socket `restart` request: validate, then pause the queue and fire once
 * active agents reach 0. Returns immediately; the fire runs in the background. An optional
 * `moveTo` (a state key) is validated up front too and handed to `fire`; while one restart is
 * pending, a request naming a different `moveTo` is rejected (a plain one is alreadyPending).
 * @param {{
 *   queue: {pause(): void, state(): {active:number, queued:number}, onActiveIdle(): Promise<void>},
 *   isDraining: () => boolean,
 *   validateConfig: () => void,
 *   validateMove?: (moveTo: string) => void,
 *   isDecommissionPending?: () => boolean,
 *   onPending: (state: {active:number, queued:number, moveTo?: string}) => void,
 *   fire: (moveTo?: string) => void | Promise<void>,
 * }} deps  validateConfig throws on a config that would brick the respawn; validateMove throws
 *   on a move that can't happen; isDecommissionPending rejects a restart while a decommission
 *   waits; onPending does the heartbeat + event; fire runs the graceful shutdown-with-respawn
 * @returns {{request(args: any): Promise<{accepted: true, alreadyPending?: true, active: number, queued: number}>, isPending(): boolean}}
 */
export function createRestartRequester({ queue, isDraining, validateConfig, validateMove, isDecommissionPending, onPending, fire }) {
  let pending = false;
  /** @type {string|undefined} */
  let pendingMove;
  return {
    isPending: () => pending,
    async request(args) {
      if (args?.when !== "idle") throw new Error(`restart: unsupported when ${JSON.stringify(args?.when)} (only "idle")`);
      const moveTo = args.moveTo;
      if (moveTo !== undefined && typeof moveTo !== "string") throw new Error("restart: moveTo must be a string");
      if (isDraining()) throw new Error("restart: shutdown already in progress");
      if (isDecommissionPending?.()) throw new Error("restart: a decommission is pending");
      const { active, queued } = queue.state();
      if (pending) {
        if (moveTo !== undefined && moveTo !== pendingMove) {
          throw new Error(`restart: a restart ${pendingMove ? `moving to "${pendingMove}"` : "without a move"} is already pending`);
        }
        return { accepted: true, alreadyPending: true, active, queued };
      }
      validateConfig(); // a bad config on disk rejects the restart — nothing changes
      if (moveTo !== undefined) {
        if (!validateMove) throw new Error("restart: moveTo is not supported");
        validateMove(moveTo); // a bad target rejects the restart — nothing paused
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
      return { accepted: true, active, queued };
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
 * The engine's quota pacer (src/quota.js `createQuotaPacer`, `cfg.quota`; no thresholds → never
 * pauses): a trip pauses the queue, a release resumes it (+ a backlog pull) only when no operator
 * pause or lock holds it. Each transition is logged, set on the heartbeat (`quotaPaused`), emitted
 * (`quota_pause` / `quota_resume`) and audited to control-audit.jsonl as actor `quota`. The reset
 * wait is one one-shot timer at the window's `resetsAt` — a deadline, not a poll. Running agents
 * are never touched.
 * @param {{
 *   cfg: import('../types.js').Config,
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
