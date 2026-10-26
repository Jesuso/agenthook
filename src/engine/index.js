// The receiver engine. One profile = one engine = one process. This file is the composition
// root (`createEngine`); the pieces live beside it:
//   http.js        the webhook request handler (fast-ACK-then-async)
//   boot.js        `serve()` — the boot sequence
//   teardown.js    shutdown / forced exit / fatal handler + teardown's respawn/archive tail
//   controllers.js the restart / decommission requesters and the quota pacer wiring
//   recovery.js    crash record, local crash recovery, overlap releaser, dedup release
//   intake.js      intake's event decision and the in-process push sink
//   context.js     types only: the shared mutable engine state
//
// Boot sequence (server owns the ingress lifecycle; see boot.js):
//   quota reading -> sandbox?.check() (abort boot if unavailable) -> ingress.up(port) -> url, write publicUrl
//   listen -> startControl -> write pidfile              # BEFORE any webhook register
//   if ingress.ephemeral: tracker.unregisterWebhooks()   # scrub dead-URL hooks
//   tracker.ensureLabels?() -> tracker.registerWebhook(url)  # idempotent if stable
//   forge?: (ephemeral: scrub) + registerWebhook(url)     # optional; best-effort
//   sandbox?.reap()                                       # orphaned runs of a dead receiver
//   recoverInterrupted -> restoreQueued -> puller.pull -> reconcile (reconcileOnBoot only)
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
import { createStore, isStateDedupKey } from "../store.js";
import { createAdapter } from "../trackers/index.js";
import { createIngress } from "../ingress/index.js";
import { createForge } from "../forges/index.js";
import { createSandbox } from "../sandbox/index.js";
import { createCiGreen } from "../ci-green.js";
import { createEpicChanged } from "../epic-changed.js";
import { createQueue } from "../queue.js";
import { createPuller } from "../pull.js";
import { queueStageOf } from "../pipeline.js";
import { createDispatcher } from "../dispatch.js";
import { createHeartbeat, repositoryOf } from "../heartbeat.js";
import { createDigester } from "../digest.js";
import { createSummarizer } from "../summarize.js";
import { claimStateDir, writeProfileMarker } from "../profile.js";
import { createOps } from "../ops.js";
import { readQuota, writeQuota } from "../quota-file.js";
import { createEmitter } from "../events.js";
import { createSinks } from "../sinks.js";
import { loadConfig } from "../config.js";
import { checkMove } from "../state-move.js";
import { createOverlapReleaser, releaseOnSettle } from "./recovery.js";
import { createPushSink, intakeEvent } from "./intake.js";
import { createDecommissionRequester, createQuotaControl, createRestartRequester } from "./controllers.js";
import { createExits, runDecommission } from "./teardown.js";
import { createRequestHandler } from "./http.js";
import { createServe } from "./boot.js";

export { crashRecord, releaseOnSettle, createOverlapReleaser, recoverInterrupted } from "./recovery.js";
export { intakeEvent, createPushSink } from "./intake.js";
export { createRestartRequester, createDecommissionRequester, createQuotaControl } from "./controllers.js";
export { unregisterAll, runDecommission, waitForExit, finishTeardown } from "./teardown.js";

/**
 * @param {import('../types.js').Config} cfg
 * @param {{reconcileOnBoot?: boolean}} [opts]  reconcileOnBoot: run one reconcile after boot (set by a `restart` respawn)
 */
export function createEngine(cfg, { reconcileOnBoot = false } = {}) {
  // Before anything below writes into the state dir (the heartbeat flushes on construction):
  // refuse an unrecognised rename while the dir is still fresh, else stamp profile.json.
  claimStateDir(cfg);
  const store = createStore(cfg.dataDir);
  const adapter = createAdapter(cfg, store);
  const forge = createForge(cfg, store);
  writeProfileMarker(cfg, { webhooks: adapter.describe().webhooks !== false || !!forge });
  const ingress = createIngress(cfg);
  const sandbox = createSandbox(cfg); // null = agents run on the host
  const heartbeat = createHeartbeat(cfg);
  const startedAt = new Date().toISOString();
  const emit = createEmitter(cfg.dataDir, cfg.sinks?.length ? createSinks(cfg) : undefined);
  /** @type {Set<import('node:child_process').ChildProcess>} */
  const children = new Set();
  // overlapGuard only: undefined when off, so nothing downstream touches the overlap files.
  const releaseOverlap = cfg.overlapGuard ? createOverlapReleaser(store, intake, emit) : undefined;
  const ciGreen = createCiGreen({ adapter, forge, store, emit });
  /** ops' epics-cache reset, handed over via `onEpicChanged` (never an own property of ops — that would be a control op). @type {(() => void) | undefined} */
  let resetEpics;
  const epicChanged = createEpicChanged({ store, emit, invalidate: () => resetEpics?.() });
  const runClaude = createDispatcher(cfg, adapter, children, store, emit, forge, releaseOverlap, {
    sandbox,
    // A Claude run's quota reading: persisted (readable with the receiver down), shown, paced.
    onQuota: (q) => {
      try {
        writeQuota(cfg.stateDir, q);
      } catch (e) {
        console.error(`[quota] quota.json write failed (continuing): ${e.message}`);
      }
      heartbeat.update({ quota: q });
      quotaPacer.reading(q);
    },
  });
  // Per-step caps (`maxConcurrent` on a step), counted inside the global cap.
  /** @type {Record<string, number>} */
  const stepCaps = {};
  for (const s of cfg.pipeline || []) if (!s.manual && s.maxConcurrent != null) stepCaps[s.id] = s.maxConcurrent;
  const queue = createQueue(cfg.maxConcurrent, releaseOnSettle(runClaude, store), (state) =>
    heartbeat.update({ queue: state, seen: store.seenCount() }),
    { onAdd: (job) => store.addQueued(job), onRemove: (job) => store.removeQueued(job), onSettle: () => void puller.pull() },
    stepCaps,
  );

  // Reload the dedup set from disk each batch (catchup edits it out-of-band), then
  // enqueue anything new. Disk is the source of truth. No section side-effect here:
  // a job's section is gated downstream (legacy: assignedToUs in dispatch; pipeline:
  // the task already rests in the step's source section), so moving on enqueue would
  // yank tasks the dispatcher then skips.
  /**
   * @param {import('../types.js').Job[]} [jobs]
   * @param {{force?: boolean}} [opts]  force skips the dedup gate (explicit replay/reconcile)
   * @returns {number} how many jobs the queue accepted (a coalesced duplicate is not accepted)
   */
  function intake(jobs, { force = false } = {}) {
    let accepted = 0;
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
      const wasInflight = queue.has(job) && !queue.isClosed();
      const ok = queue.enqueue(job);
      if (ok) accepted++;
      // Refused (coalesced/draining) → never ran, so don't leave a state key behind.
      else if (isStateDedupKey(job.dedupKey)) store.unmarkSeen(job.dedupKey);
      const ev = intakeEvent(ok, wasInflight);
      if (ev) emit(ev, job.ref, job.stepId);
    }
    return accepted;
  }

  // Queue-stage pull (opt-in per step; see src/pull.js). Triggered once on boot and after
  // every job settles — never on a timer; a no-op without any queue key.
  const puller = createPuller({
    steps: adapter.listQueued && adapter.enterStage ? (cfg.pipeline || []).filter((s) => !s.manual && queueStageOf(s)) : [],
    max: () => queue.max(), // live: `set_concurrency` moves it
    queueState: () => queue.state(),
    stepState: () => queue.stepState(),
    inflightRefs: () => [...Object.keys(store.listRunning()), ...store.listQueued().map((j) => j.ref)],
    listQueued: (stepId) => /** @type {NonNullable<typeof adapter.listQueued>} */ (adapter.listQueued)(stepId),
    enterStage: (ref, stepId, opts) => /** @type {NonNullable<typeof adapter.enterStage>} */ (adapter.enterStage)(ref, stepId, opts),
    stageOf: queueStageOf,
    isDraining: () => state.draining || queue.isPaused() || restarter.isPending() || decommissioner.isPending(), // an operator pause also stops backlog pulls
    emit,
    onDepth: (queueStage) => heartbeat.update({ queueStage }),
  });

  // An in-process event source (local tracker) pushes its jobs here instead of over HTTP.
  adapter.onJobs?.(createPushSink({ hasRef: queue.hasRef, whenRefFree: queue.whenRefFree, intake }));

  /** @type {import('./context.js').EngineState} */
  const state = {
    draining: false,
    respawnOnExit: false,
    moveOnExit: undefined,
    archiveOnExit: false,
    finished: false,
    control: null,
    server: http.createServer(createRequestHandler({ adapter, forge, intake, ciGreen, epicChanged })),
  };

  // Opt-in quota pacer (src/quota.js; `quota` config, default off).
  const quotaPacer = createQuotaControl({
    cfg, queue, heartbeat, emit,
    pull: () => puller.pull(),
    isLocked: () => state.draining || restarter.isPending() || decommissioner.isPending(),
  });
  heartbeat.update({ quota: readQuota(cfg.stateDir) });

  const ops = createOps({
    cfg, store, adapter, forge, queue, intake, emit, heartbeat, pacer: quotaPacer,
    onEpicChanged: (reset) => { resetEpics = reset; },
    digester: createDigester({
      cfg, emit, repository: repositoryOf(cfg),
      // Declared before `ops` is assigned but only called from inside the digester, by which
      // point `ops` has already been assigned — safe.
      readEpics: async () => {
        const r = await ops.epics({});
        return r.supported ? r.epics : null;
      },
    }),
    summarizer: createSummarizer({ cfg, store, adapter, emit }),
    cancelRun: runClaude.cancel,
    pull: () => puller.pull(),
    // mirrors dispatch's leavePipeline: a ref abandoned by `cancel` must not keep an overlap lock
    leavePipeline: (ref) => {
      if (!cfg.overlapGuard) return;
      store.clearPredictedPaths(ref);
      store.clearOverlap(ref);
      releaseOverlap?.(ref);
    },
    isLocked: () => state.draining || restarter.isPending() || decommissioner.isPending(),
  });

  const restarter = createRestartRequester({
    queue,
    isDraining: () => state.draining,
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
    isDraining: () => state.draining,
    isRestartPending: () => restarter.isPending(),
    onPending: ({ active, queued, unregister }) => {
      const hooks = unregister ? "unregistering webhooks, " : "";
      console.log(`[decommission] requested — pausing new runs; ${hooks}exiting and archiving the state dir once ${active} running agent(s) finish (${queued} queued)`);
      heartbeat.update({ decommissionPending: true });
      emit("decommission_requested", "", "", { active, queued, unregister });
    },
    fire: ({ unregister }) =>
      runDecommission({ unregister }, { adapter, forge, isDraining: () => state.draining, queued: () => queue.state().queued, emit, shutdown }),
  });

  const { shutdown, onFatal } = createExits({
    cfg, state, queue, ingress, heartbeat, children, store, quotaPacer, sandbox,
    isRestartPending: () => restarter.isPending(),
    isDecommissionPending: () => decommissioner.isPending(),
  });
  process.on("uncaughtException", (err) => onFatal("uncaughtException", err));
  process.on("unhandledRejection", (err) => onFatal("unhandledRejection", err));

  const serve = createServe({
    cfg, state, store, adapter, forge, ingress, sandbox, heartbeat, queue, puller, quotaPacer, emit, intake, releaseOverlap, startedAt,
    restart: restarter.request, decommission: decommissioner.request, ops, shutdown, reconcileOnBoot,
  });

  return { serve, shutdown, requestRestart: restarter.request, requestDecommission: decommissioner.request, store, adapter, forge, ingress };
}
