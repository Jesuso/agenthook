// The receiver engine. One profile = one engine = one process.
//
// Boot sequence (server owns the ingress lifecycle):
//   ingress.up(port) -> url
//   if ingress.ephemeral: tracker.unregisterWebhooks()   # scrub dead-URL hooks
//   tracker.registerWebhook(url)                          # idempotent if stable
//   forge?: (ephemeral: scrub) + registerWebhook(url)     # optional; best-effort
//   listen + write pidfile + heartbeat
//   on exit: ingress.down(), clear pidfile/heartbeat
//
// A control-socket `restart {when:'idle'}` pauses the queue (jobs still persist to
// queue.json), waits for 0 active agents, exits through the graceful path and respawns
// detached with --reconcile-on-boot; the new process restores the queue and runs one
// reconcile to recover webhooks missed in the gap. With `moveTo` (`rename --move`), teardown
// also moves the state dir to ~/.agenthook/<moveTo>/ and rewrites the config's stateId
// before the respawn (src/state-move.js); a failed move restarts on the old key.
// A control-socket `decommission {when:'idle'}` pauses the same way, then unregisters the
// webhooks (best-effort), exits gracefully WITHOUT a respawn and archives its own state dir
// to ~/.agenthook-archive/<key>-<stamp>/ once nothing holds it (src/archive.js).
//
// The request path is the same fast-ACK-then-async shape as before: authenticate
// (sync, no network) -> ACK 200 -> processEvents off the response path -> intake.
// `/forge` goes to the forge (when one is configured); everything else to the tracker.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createStore, isStateDedupKey } from "./store.js";
import { ensurePrivateDir } from "./config.js";
import { createAdapter } from "./trackers/index.js";
import { createIngress } from "./ingress/index.js";
import { createForge, isForgePath } from "./forges/index.js";
import { createQueue, planRestore } from "./queue.js";
import { createPuller } from "./pull.js";
import { queueStageOf } from "./pipeline.js";
import { createDispatcher } from "./dispatch.js";
import { createHeartbeat } from "./heartbeat.js";
import { claimStateDir } from "./profile.js";
import { startControl } from "./control.js";
import { createEmitter } from "./events.js";
import { createSinks } from "./sinks.js";
import { loadConfig } from "./config.js";
import { restartSpawnArgs, spawnDetached } from "./respawn.js";
import { checkMove, moveStateDir } from "./state-move.js";
import { archiveStateDir } from "./archive.js";
import { runReconcile } from "./commands/reconcile.js";

/**
 * Pure record builder for a fatal crash — unit-testable without touching disk/process.
 * @param {string} kind  "uncaughtException" | "unhandledRejection"
 * @param {unknown} err
 * @param {string[]} runningRefs  refs mid-step at the moment of the crash (store.listRunning() keys)
 */
export function crashRecord(kind, err, runningRefs) {
  const e = err instanceof Error ? err : new Error(String(err));
  return {
    at: new Date().toISOString(),
    pid: process.pid,
    kind,
    message: e.message,
    stack: e.stack,
    running: runningRefs,
  };
}

/**
 * Wrap a job runner so a `step:` dedup key is released when the job settles
 * (resolve or reject). Other keys stay in `seen`.
 * @param {(job: import('./types.js').Job) => Promise<any>} run
 * @param {{reloadSeen: () => void, unmarkSeen: (key: string) => void}} store
 */
export function releaseOnSettle(run, store) {
  return async (/** @type {import('./types.js').Job} */ job) => {
    try {
      return await run(job);
    } finally {
      if (isStateDedupKey(job.dedupKey)) {
        store.reloadSeen(); // seen is edited out-of-band (catchup)
        store.unmarkSeen(job.dedupKey);
      }
    }
  };
}

/**
 * The overlapGuard release (see src/overlap.js): `blocker` left the pipeline, so clear
 * its lock and re-intake every ref waiting on it. The dedup key is `overlap:<blocker>:<ref>`;
 * intake is forced because the overlap.json entry — cleared just before — is the one-shot
 * guard (the same pair can wait again after a later lock). A released job re-runs the gate
 * and may be re-held behind a different lock.
 * @param {import('./types.js').Store} store
 * @param {(jobs: import('./types.js').Job[], opts?: {force?: boolean}) => void} intake
 * @param {(event: string, ref: string, step: string, extra?: Record<string, any>) => void} [emit]
 * @returns {(blocker: string) => void}
 */
export function createOverlapReleaser(store, intake, emit) {
  return (blocker) => {
    store.clearLock(blocker);
    const waiting = store.listOverlap();
    for (const ref of Object.keys(waiting)) {
      const { stepId, blockedBy } = waiting[ref];
      if (blockedBy !== blocker) continue;
      store.clearOverlap(ref);
      console.log(`[overlap] ${blocker} released — re-offering ${ref} to step ${stepId}`);
      emit?.("overlap_released", ref, stepId, { blockedBy: blocker });
      intake([{ kind: "pipeline", ref, stepId, dedupKey: `overlap:${blocker}:${ref}` }], { force: true });
    }
  };
}

/**
 * Crash recovery from LOCAL state only — never a board poll. A restart orphans any
 * in-flight `claude -p` (queued-but-unstarted jobs survive in queue.json, see
 * restoreQueued); running.json is the record of what was mid-step. We resolve each as
 * a failed run (implement isn't idempotent, so re-running blind is unsafe) → the
 * adapter moves it to its failure lane for a human. Catching tasks that *arrived*
 * during downtime is the explicit `reconcile` command's job, not boot's.
 * @param {import('./types.js').Store} store
 * @param {import('./types.js').Adapter} adapter
 * @param {(event: string, ref: string, step: string, extra?: Record<string, any>) => void} emit
 * @param {(blocker: string) => void} [releaseOverlap]  overlapGuard: a fail frees the ref's lock
 */
export async function recoverInterrupted(store, adapter, emit, releaseOverlap) {
  const running = store.listRunning();
  const refs = Object.keys(running);
  if (!refs.length) return;
  console.log(`[recover] ${refs.length} step(s) interrupted by restart — moving to failure lane`);
  for (const ref of refs) {
    const { stepId } = running[ref];
    emit("failed", ref, stepId, { reason: "interrupted by restart" });
    try {
      await adapter.advance?.(ref, stepId, { outcome: "fail", reason: "interrupted by restart" });
    } catch (e) {
      console.error(`[recover] advance ${ref} (${stepId}) failed:`, e.message);
    }
    store.clearRunning(ref);
    store.clearAttempts(ref);
    store.unmarkSeen(`step:${stepId}:${ref}`);
    if (releaseOverlap) {
      store.clearPredictedPaths(ref);
      releaseOverlap(ref);
    }
  }
}

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
 * Delete the tracker's and the forge's webhooks, each side best-effort in its own try/catch.
 * Never throws.
 * @param {{unregisterWebhooks(): Promise<any>}} adapter
 * @param {{unregisterWebhooks(): Promise<any>} | null | undefined} forge
 * @returns {Promise<{tracker: 'ok'|'failed', forge: 'ok'|'failed'|'none', errors?: {tracker?: string, forge?: string}}>}
 */
export async function unregisterAll(adapter, forge) {
  /** @type {{tracker?: string, forge?: string}} */
  const errors = {};
  /** @type {'ok'|'failed'} */
  let tracker = "ok";
  try {
    await adapter.unregisterWebhooks();
  } catch (e) {
    tracker = "failed";
    errors.tracker = e?.message ?? String(e);
  }
  /** @type {'ok'|'failed'|'none'} */
  let forgeResult = "none";
  if (forge) {
    forgeResult = "ok";
    try {
      await forge.unregisterWebhooks();
    } catch (e) {
      forgeResult = "failed";
      errors.forge = e?.message ?? String(e);
    }
  }
  return { tracker, forge: forgeResult, ...(Object.keys(errors).length && { errors }) };
}

/**
 * A firing decommission: unregister the webhooks (when asked; failures are logged, never block),
 * emit `decommissioning`, then the graceful shutdown-with-archive. A signal that arrived during
 * the unregister owns the exit — no event, no archive.
 * @param {{unregister: boolean}} opts
 * @param {{
 *   adapter: {unregisterWebhooks(): Promise<any>},
 *   forge: {unregisterWebhooks(): Promise<any>} | null | undefined,
 *   isDraining: () => boolean,
 *   queued: () => number,
 *   emit: (event: string, ref: string, step: string, extra?: Record<string, any>) => void,
 *   shutdown: (signal: string, opts: {archive: boolean}) => void | Promise<void>,
 * }} deps
 */
export async function runDecommission({ unregister }, { adapter, forge, isDraining, queued, emit, shutdown }) {
  /** @type {Record<string, any>} */
  const result = unregister ? await unregisterAll(adapter, forge) : { tracker: "skipped", forge: "skipped" };
  const errs = result.errors ? ` (${Object.entries(result.errors).map(([k, m]) => `${k}: ${m}`).join("; ")})` : "";
  console.log(`[decommission] webhooks — tracker ${result.tracker}, forge ${result.forge}${errs}`);
  if (isDraining()) return;
  emit("decommissioning", "", "", { queued: queued(), unregister: result });
  return shutdown("decommission", { archive: true });
}

/**
 * What a graceful shutdown waits on before teardown. `keepQueued` (a pending restart or
 * decommission paused the queue): only the active agents — queue.onIdle() would never resolve
 * on a paused queue with jobs, and those jobs stay in queue.json. Otherwise running + queued.
 * @param {{onIdle(): Promise<void>, onActiveIdle(): Promise<void>}} queue
 * @param {boolean} keepQueued
 */
export function waitForExit(queue, keepQueued) {
  return keepQueued ? queue.onActiveIdle() : queue.onIdle();
}

/**
 * Teardown's tail, run once the heartbeat, control socket and pidfile are released (so a
 * successor's already-running / socket-owner checks pass and archiveStateDir sees no live pid).
 * `respawn` (restart): optionally move the state dir, then spawn the successor. `archive`
 * (decommission, mutually exclusive): archive the state dir, never respawn. No events/heartbeat
 * after either: they'd write into — or recreate — the old dir.
 * @param {{cfg: {configPath: string, stateKey: string, stateDir: string, name: string, installDir: string}, respawn?: boolean, moveTo?: string, archive?: boolean}} plan
 * @param {{moveStateDir?: typeof moveStateDir, spawnDetached?: typeof spawnDetached, archiveStateDir?: typeof archiveStateDir}} [deps]
 */
export function finishTeardown({ cfg, respawn, moveTo, archive }, deps = {}) {
  const { moveStateDir: move = moveStateDir, spawnDetached: spawn = spawnDetached, archiveStateDir: archiveDir = archiveStateDir } = deps;
  if (respawn) {
    // A pending move happens here, once nothing holds the state dir, and the successor logs
    // into the new dir (it resolves the new key from the rewritten config).
    /** @type {{stateDir: string, stateKey: string}} */
    let spawnCfg = cfg;
    if (moveTo) {
      try {
        spawnCfg = move({ configPath: cfg.configPath, from: cfg.stateKey, to: moveTo, source: "restart" });
        console.log(`[restart] moved state dir ${cfg.stateDir} → ${spawnCfg.stateDir}`);
      } catch (e) {
        console.error(`[restart] move failed: ${e.message} — restarting on "${cfg.stateKey}"`);
      }
    }
    try {
      const { pid, logPath } = spawn(spawnCfg, restartSpawnArgs(cfg));
      console.log(`[restart] respawned "${cfg.name}" (pid ${pid}). Log: ${logPath}`);
    } catch (e) {
      console.error(`[restart] respawn failed: ${e.message}`);
    }
    return;
  }
  if (archive) {
    // receiver.log is held open by fd: lines logged after the rename land in the archived copy.
    try {
      const { archivedTo } = archiveDir({ stateKey: cfg.stateKey, reason: "decommission", source: "decommission" });
      console.log(`[decommission] archived ${cfg.stateDir} → ${archivedTo}`);
    } catch (e) {
      console.error(`[decommission] archive failed: ${e.message} — state dir left at ${cfg.stateDir}`);
    }
  }
}

/**
 * @param {import('./types.js').Config} cfg
 * @param {{reconcileOnBoot?: boolean}} [opts]  reconcileOnBoot: run one reconcile after boot (set by a `restart` respawn)
 */
export function createEngine(cfg, { reconcileOnBoot = false } = {}) {
  // Before anything below writes into the state dir (the heartbeat flushes on construction):
  // refuse an unrecognised rename while the dir is still fresh, else stamp profile.json.
  claimStateDir(cfg);
  const store = createStore(cfg.dataDir);
  const adapter = createAdapter(cfg, store);
  const forge = createForge(cfg, store);
  const ingress = createIngress(cfg);
  const heartbeat = createHeartbeat(cfg);
  const startedAt = new Date().toISOString();
  /** @type {{close(): void} | null} */
  let control = null;
  const emit = createEmitter(cfg.dataDir, cfg.sinks?.length ? createSinks(cfg) : undefined);
  /** @type {Set<import('node:child_process').ChildProcess>} */
  const children = new Set();
  // overlapGuard only: undefined when off, so nothing downstream touches the overlap files.
  const releaseOverlap = cfg.overlapGuard ? createOverlapReleaser(store, intake, emit) : undefined;
  const runClaude = createDispatcher(cfg, adapter, children, store, emit, forge, releaseOverlap);
  const queue = createQueue(cfg.maxConcurrent, releaseOnSettle(runClaude, store), (state) =>
    heartbeat.update({ queue: state, seen: store.seenCount() }),
    { onAdd: (job) => store.addQueued(job), onRemove: (job) => store.removeQueued(job), onSettle: () => void puller.pull() },
  );

  // Reload the dedup set from disk each batch (catchup edits it out-of-band), then
  // enqueue anything new. Disk is the source of truth. No section side-effect here:
  // a job's section is gated downstream (legacy: assignedToUs in dispatch; pipeline:
  // the task already rests in the step's source section), so moving on enqueue would
  // yank tasks the dispatcher then skips.
  /**
   * @param {import('./types.js').Job[]} [jobs]
   * @param {{force?: boolean}} [opts]  force skips the dedup gate (explicit replay/reconcile)
   */
  function intake(jobs, { force = false } = {}) {
    store.reloadSeen();
    for (const job of jobs || []) {
      if (!job.dedupKey) continue;
      if (!force && store.hasSeen(job.dedupKey)) continue;
      store.markSeen(job.dedupKey);
      console.log(`[event] step ${job.stepId} ${job.ref}`);
      puller.arrived(job.ref); // a pulled ref's webhook-driven job arrived — the queue counts its slot now
      heartbeat.update({
        lastEvent: { at: new Date().toISOString(), kind: job.kind, ref: job.ref, step: job.stepId },
        seen: store.seenCount(),
      });
      emit("enqueued", job.ref, job.stepId);
      // Refused (coalesced/draining) → never ran, so don't leave a state key behind.
      if (!queue.enqueue(job) && isStateDedupKey(job.dedupKey)) store.unmarkSeen(job.dedupKey);
    }
  }

  // Re-enqueue jobs that were waiting (queue.json) when the receiver died. Bypasses
  // intake: their `seen` key is already marked. Must run AFTER recoverInterrupted so
  // refs that were in running.json at boot (`runningRefs`, captured before recovery
  // clears them) went to the failure lane and are dropped. Entries stay in queue.json
  // (addQueued dedups) until they start. Local reads only.
  /** @param {string[]} runningRefs */
  function restoreQueued(runningRefs) {
    const { keep, drop } = planRestore(store.listQueued(), runningRefs, (cfg.pipeline || []).map((s) => s.id));
    for (const j of drop) store.removeQueued(j);
    if (!keep.length) return;
    console.log(`[restore] ${keep.length} queued job(s) re-enqueued`);
    for (const j of keep) {
      emit("enqueued", j.ref, j.stepId, { restored: true });
      queue.enqueue(j);
    }
  }

  // Queue-stage pull (opt-in per step; see src/pull.js). Triggered once on boot and after
  // every job settles — never on a timer; a no-op without any queue key.
  const puller = createPuller({
    steps: adapter.listQueued && adapter.enterStage ? (cfg.pipeline || []).filter((s) => !s.manual && queueStageOf(s)) : [],
    max: cfg.maxConcurrent,
    queueState: () => queue.state(),
    inflightRefs: () => [...Object.keys(store.listRunning()), ...store.listQueued().map((j) => j.ref)],
    listQueued: (stepId) => /** @type {NonNullable<typeof adapter.listQueued>} */ (adapter.listQueued)(stepId),
    enterStage: (ref, stepId, opts) => /** @type {NonNullable<typeof adapter.enterStage>} */ (adapter.enterStage)(ref, stepId, opts),
    stageOf: queueStageOf,
    isDraining: () => draining || restarter.isPending() || decommissioner.isPending(),
    emit,
    onDepth: (queueStage) => heartbeat.update({ queueStage }),
  });

  const server = http.createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(200);
      res.end("agenthook up");
      return;
    }
    const pathname = new URL(req.url || "/", "http://localhost").pathname;
    /** @type {Buffer[]} */
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const rawBody = Buffer.concat(chunks).toString("utf8");
      const ctx = { pathname, headers: req.headers, rawBody };
      // A forge owns `/forge`; without one, `/forge` falls through to the tracker.
      const source = forge && isForgePath(pathname) ? forge : adapter;
      let auth;
      try {
        auth = source.authenticate(ctx);
      } catch (e) {
        console.error("[auth]", e.message);
        res.writeHead(500);
        res.end();
        return;
      }
      if (auth.type === "handshake") {
        res.writeHead(200, auth.headers);
        res.end();
        return;
      }
      if (auth.type === "reject") {
        res.writeHead(401);
        res.end();
        return;
      }
      // accept: ACK immediately (providers expect a fast 2xx), then process async.
      res.writeHead(200);
      res.end();
      Promise.resolve(source.processEvents(ctx)).then(intake).catch((e) => console.error("[events]", e.message));
    });
  });

  let draining = false;
  let respawnOnExit = false; // set by a firing restart; any signal clears it
  /** @type {string|undefined} */
  let moveOnExit; // the restart's state-dir move target, if any
  let archiveOnExit = false; // set by a firing decommission; any signal clears it
  let finished = false; // teardown's respawn/archive tail runs once
  const restarter = createRestartRequester({
    queue,
    isDraining: () => draining,
    validateConfig: () => void loadConfig({ configPath: cfg.configPath }),
    validateMove: (moveTo) => checkMove({ configPath: cfg.configPath, from: cfg.stateKey, to: moveTo }),
    isDecommissionPending: () => decommissioner.isPending(),
    onPending: ({ active, queued, moveTo }) => {
      const move = moveTo ? ` and moving the state dir to "${moveTo}"` : "";
      console.log(`[restart] requested — pausing new runs; restarting${move} once ${active} running agent(s) finish (${queued} queued)`);
      heartbeat.update({ restartPending: true });
      emit("restart_requested", "", "", { active, queued, ...(moveTo && { moveTo }) });
    },
    fire: (moveTo) => {
      emit("restarting", "", "", { queued: queue.state().queued, ...(moveTo && { moveTo }) });
      return shutdown("restart", { respawn: true, moveTo });
    },
  });
  const decommissioner = createDecommissionRequester({
    queue,
    isDraining: () => draining,
    isRestartPending: () => restarter.isPending(),
    onPending: ({ active, queued, unregister }) => {
      const hooks = unregister ? "unregistering webhooks, " : "";
      console.log(`[decommission] requested — pausing new runs; ${hooks}exiting and archiving the state dir once ${active} running agent(s) finish (${queued} queued)`);
      heartbeat.update({ decommissionPending: true });
      emit("decommission_requested", "", "", { active, queued, unregister });
    },
    fire: ({ unregister }) =>
      runDecommission({ unregister }, { adapter, forge, isDraining: () => draining, queued: () => queue.state().queued, emit, shutdown }),
  });

  /** Final teardown shared by graceful + forced exit. */
  function teardown() {
    heartbeat.clear();
    control?.close();
    try {
      fs.rmSync(cfg.pidFile, { force: true });
    } catch {
      /* ignore */
    }
    // Restart: spawn the successor (after an optional move); decommission: archive the state
    // dir. Exactly once, after the pidfile, control socket and listener are released and before
    // either exit path below. No events/heartbeat after this point.
    if ((respawnOnExit || archiveOnExit) && !finished) {
      finished = true;
      finishTeardown({ cfg, respawn: respawnOnExit, moveTo: moveOnExit, archive: archiveOnExit });
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref(); // don't hang on lingering sockets
  }

  /** Force path: kill in-flight agents and exit now (second signal, or no children). @param {string} reason */
  function forceExit(reason) {
    console.log(`[shutdown] ${reason} — killing ${children.size} agent(s)`);
    for (const child of children) {
      try {
        child.kill("SIGTERM");
      } catch {
        /* already gone */
      }
    }
    teardown();
  }

  // First signal drains: stop taking new work, let running + queued agents finish,
  // then exit. A second signal during the drain force-kills the agents immediately.
  // A restart (respawn) or decommission (archive) shuts down the same way but never waits on
  // the paused queue: queued jobs stay in queue.json (for the successor's restoreQueued, or in
  // the archived dir). A signal while either is pending cancels it (no respawn; no unregister,
  // no archive) and exits once active agents reach 0.
  /** @param {string} [signal] @param {{respawn?: boolean, moveTo?: string, archive?: boolean}} [opts] */
  async function shutdown(signal, { respawn = false, moveTo, archive = false } = {}) {
    if (!respawn) {
      respawnOnExit = false;
      moveOnExit = undefined;
    }
    if (!archive) archiveOnExit = false;
    if (draining) {
      forceExit(`${signal || "signal"} during drain`);
      return;
    }
    draining = true;
    if (respawn) {
      respawnOnExit = true;
      moveOnExit = moveTo;
    }
    if (archive) archiveOnExit = true;

    // Stop new work reaching the queue, then close the front door so no fresh
    // events arrive. In-flight `claude -p` children keep running untouched.
    queue.close();
    try {
      await ingress.down();
    } catch (e) {
      console.error("[ingress] down failed:", e.message);
    }
    server.close(); // stop accepting new connections; in-flight handlers finish

    const { active, queued } = queue.state();
    if (restarter.isPending() || decommissioner.isPending()) {
      const what = restarter.isPending() ? "restart" : "decommission";
      if (active > 0) {
        console.log(`\n[shutdown] ${signal || ""} — ${what} cancelled; waiting for ${active} running agent(s); send the signal again to force-kill`);
        heartbeat.update({ draining: true, queue: queue.state() });
      }
      await waitForExit(queue, true);
      const how = respawnOnExit ? "restarting" : archiveOnExit ? "archiving" : "exiting";
      console.log(`[shutdown] ${how} — ${queued} queued job(s) kept in queue.json`);
      teardown();
      return;
    }
    if (active === 0 && queued === 0) {
      console.log(`\n[shutdown] ${signal || ""} — nothing running, exiting`);
      teardown();
      return;
    }
    console.log(
      `\n[shutdown] ${signal || ""} — draining ${active} running + ${queued} queued agent(s); ` +
        `send the signal again to force-kill`,
    );
    heartbeat.update({ draining: true, queue: queue.state() });
    await waitForExit(queue, false);
    console.log(`[shutdown] drain complete — exiting`);
    teardown();
  }

  /**
   * Last resort: an uncaught throw/rejection means engine state is unknown — log,
   * best-effort record + kill children, then exit. Never swallow-and-continue.
   * @param {string} kind
   * @param {unknown} err
   */
  function onFatal(kind, err) {
    const e = err instanceof Error ? err : new Error(String(err));
    console.error(`[fatal] ${kind}: ${e.stack}`);
    try {
      fs.writeFileSync(
        path.join(cfg.stateDir, "crash.json"),
        JSON.stringify(crashRecord(kind, err, Object.keys(store.listRunning())), null, 2),
      );
    } catch (writeErr) {
      console.error(`[fatal] crash.json write failed (continuing): ${/** @type {Error} */ (writeErr).message}`);
    }
    for (const child of children) {
      try {
        child.kill("SIGTERM");
      } catch {
        /* already gone */
      }
    }
    try {
      fs.rmSync(cfg.pidFile, { force: true });
    } catch {
      /* ignore */
    }
    process.exit(1);
  }
  process.on("uncaughtException", (err) => onFatal("uncaughtException", err));
  process.on("unhandledRejection", (err) => onFatal("unhandledRejection", err));

  async function serve() {
    const meta = ingress.describe();
    console.log(`[boot] profile "${cfg.name}" — tracker ${cfg.provider}, ingress ${meta.name}${forge ? `, forge ${forge.describe().name}` : ""}`);

    for (const dir of [cfg.stateDir, cfg.logDir]) {
      const result = ensurePrivateDir(dir, { tighten: true });
      if (result.tightened) console.error(`[boot] tightened ${dir} permissions 0${result.from.toString(8)} → 0700`);
    }

    if (cfg.fullAuto) {
      // fullAuto runs agents with --dangerously-skip-permissions: a verified webhook
      // leads straight to unsandboxed code execution on this host. Make that loud at
      // every boot so it's never a silent default. See docs/architecture.md#security-posture.
      console.error(
        "\n  ⚠  fullAuto is ON — agents run `claude -p --dangerously-skip-permissions`.\n" +
          "     A verified webhook executes code on this host, UNSANDBOXED. The only gate\n" +
          "     is the HMAC signature + a non-guessable URL. Run on a trusted host with a\n" +
          "     scoped token, or in a container/VM with only the repo mounted. Set\n" +
          "     fullAuto:false to require per-action permission prompts (the safe default).\n",
      );
    }

    if (cfg.overlapGuard && !(cfg.pipeline || []).some((s) => s.drainWorktree) && !forge) {
      // Locks release on a drain, a fail, or a forge merge. Without a drain step or a
      // forge, a ref that finishes cleanly keeps its lock and its waiters wait forever.
      console.error(
        "\n  ⚠  overlapGuard is ON but no step has drainWorktree and no forge is configured —\n" +
          "     file-overlap locks never release on success (only on fail). Add a drain step\n" +
          "     or a forge block, or turn overlapGuard off.\n",
      );
    }

    let ingressUp = false;
    try {
      const { url } = await ingress.up(cfg.port);
      ingressUp = true;
      fs.writeFileSync(cfg.publicUrlFile, url);
      heartbeat.update({ url });

      // Listen BEFORE registering: registering a webhook makes the tracker immediately
      // POST a handshake/ping to the public URL, which must reach a live server (Asana
      // needs the X-Hook-Secret echoed back, or it fails the hook with a 502).
      await new Promise((resolve) => server.listen(cfg.port, "127.0.0.1", () => resolve(undefined)));
      control = await startControl(cfg, { startedAt, adapter, restart: restarter.request, decommission: decommissioner.request }); // owner check reads the OLD pidfile — must run before the write below
      fs.writeFileSync(cfg.pidFile, String(process.pid));
      console.log(`agenthook [${cfg.name}] listening on 127.0.0.1:${cfg.port}  (public: ${url})`);

      if (meta.ephemeral) {
        console.log("[boot] ingress URL is ephemeral — scrubbing stale webhooks");
        try {
          await adapter.unregisterWebhooks();
        } catch (e) {
          console.error("[boot] unregister failed (continuing):", e.message);
        }
      }
      // Create any pipeline objects the tracker API won't auto-add to a task before
      // the move (GitHub: the issue labels). Best-effort — a labels API hiccup must
      // not stop the receiver serving already-labelled work.
      try {
        await adapter.ensureLabels?.();
      } catch (e) {
        console.error("[boot] ensureLabels failed (continuing):", e.message);
      }
      await adapter.registerWebhook(url);

      // Forge hook (PR merges). Best-effort: a forge failure never aborts boot — the
      // tracker pipeline still works without it.
      if (forge) {
        if (meta.ephemeral) {
          try {
            await forge.unregisterWebhooks();
          } catch (e) {
            console.error("[boot] forge unregister failed (continuing):", e.message);
          }
        }
        try {
          await forge.registerWebhook(url);
        } catch (e) {
          console.error("[boot] forge webhook failed (continuing):", e.message);
        }
      }

      // Self-heal from LOCAL state only (no board poll — see recoverInterrupted).
      const runningRefs = Object.keys(store.listRunning());
      await recoverInterrupted(store, adapter, emit, releaseOverlap);
      restoreQueued(runningRefs);
      // Queue-stage pull into any free slots (opt-in; no-op without a queue key).
      await puller.pull();

      // An explicit one-shot requested by a control-socket `restart` (the old process
      // respawns us with --reconcile-on-boot): replay tasks whose webhook landed in the
      // restart gap. Not polling — it runs once, here, and is never re-armed.
      // Best-effort: a reconcile failure must not abort boot.
      if (reconcileOnBoot) {
        try {
          const { replayed, skipped } = await runReconcile(cfg, { store, adapter });
          console.log(`[boot] post-restart reconcile — ${replayed} replayed, ${skipped} skipped`);
        } catch (e) {
          console.error("[boot] post-restart reconcile failed (continuing):", e.message);
        }
      }
    } catch (e) {
      // Boot failed after the tunnel came up — tear it down so it doesn't orphan
      // (an orphaned ngrok endpoint causes ERR_NGROK_334 on the next start).
      if (ingressUp) await ingress.down().catch(() => {});
      control?.close();
      throw e;
    }

    console.log(`${store.secretCount()} secret(s), ${store.seenCount()} item(s) seen`);
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
  }

  return { serve, shutdown, requestRestart: restarter.request, requestDecommission: decommissioner.request, store, adapter, forge, ingress };
}
