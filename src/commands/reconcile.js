// `agenthook reconcile` — the ONLY board poll, and it is user-explicit by design.
// Forward motion is event-driven; this exists to recover from a webhook the server
// missed while down (a task left resting in a step's source section with no event to
// fire it). It lists resting tasks, then replays each as a forged, signed event
// through the live server — reusing the whole dispatch path, exactly like `catchup`.
//
// An in-process tracker (`local`: no webhooks, so no forgeCatchup) has nothing to replay over
// HTTP: the CLI sends the `reconcile` op over control.sock instead, and the receiver feeds the
// resting jobs straight into its own intake.
//
// Tasks currently mid-step (in the local running record) are skipped so a reconcile
// never double-runs in-flight work.
//
// overlapGuard: a task waiting on a file-overlap lock rests in its source stage, so the
// replay below already re-offers it to the gate. We only prune overlap.json waits whose
// blocker no longer holds a lock (a release the receiver missed) first.
import { loadConfig } from "../config.js";
import { requireStarted } from "../profile.js";
import { createStore } from "../store.js";
import { createAdapter } from "../trackers/index.js";
import { isPipeline } from "../pipeline.js";
import { staleOverlaps } from "../overlap.js";
import { controlRequest } from "../ui/control-client.js";

/** @param {any} args */
export async function reconcile(args) {
  const cfg = loadConfig({ configPath: args.config });
  requireStarted(cfg);
  const store = createStore(cfg.dataDir);
  const adapter = createAdapter(cfg, store);
  try {
    if (typeof adapter.forgeCatchup !== "function" && typeof adapter.onJobs === "function") {
      await reconcileOverControl(cfg);
      return;
    }
    await runReconcile(cfg, { store, adapter });
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}

/** Ask the live receiver to reconcile (in-process trackers). @param {import('../types.js').Config} cfg */
async function reconcileOverControl(cfg) {
  let reply;
  try {
    reply = await controlRequest(cfg.controlSock, "reconcile", {}, { timeoutMs: 20000 });
  } catch (e) {
    throw new Error(`could not reach "${cfg.name}" (${e.code === "timeout" ? "timed out" : "receiver is down"}). Is it running? \`agenthook start --detach\` first.`);
  }
  if (!reply.ok) throw new Error(`reconcile: ${reply.error}`);
  for (const line of reply.result.log || []) console.log(line);
}

/**
 * The reconcile body, callable in-process (the engine runs it once on a
 * `--reconcile-on-boot` restart). Throws instead of exiting; replays through the
 * live server on 127.0.0.1:<port> — or, given `intake` (in the receiver) and an adapter with no
 * forgeCatchup (an in-process tracker), straight into the queue.
 * @param {import('../types.js').Config} cfg
 * @param {{store: import('../types.js').Store, adapter: import('../types.js').Adapter, log?: (msg: string) => void, intake?: (jobs: import('../types.js').Job[], opts?: {force?: boolean}) => number}} deps
 * @returns {Promise<{replayed: number, skipped: number}>}
 */
export async function runReconcile(cfg, { store, adapter, log = console.log, intake }) {
  if (!isPipeline(cfg)) throw new Error(`reconcile is for pipeline configs; "${cfg.name}" has no tracker.pipeline.`);
  const direct = typeof adapter.forgeCatchup !== "function" && !!intake;
  if (typeof adapter.listResting !== "function" || (typeof adapter.forgeCatchup !== "function" && !direct)) {
    throw new Error(`tracker "${cfg.provider}" does not support reconcile.`);
  }

  if (cfg.overlapGuard) {
    const waiting = store.listOverlap();
    for (const ref of staleOverlaps(waiting, store.listLocks())) {
      store.clearOverlap(ref);
      log(`[overlap] pruned ${ref} — its blocker ${waiting[ref].blockedBy} holds no lock`);
    }
  }

  const resting = await adapter.listResting();
  if (!resting.length) {
    log("board clean — no resting tasks to reconcile.");
    return { replayed: 0, skipped: 0 };
  }
  const running = store.listRunning();
  store.reloadSeen();

  let dispatched = 0;
  for (const job of resting) {
    if (job.ref in running) {
      log(`[skip] ${job.ref} is mid-step (${running[job.ref].stepId}) — not replaying`);
      continue;
    }
    if (direct) {
      if (/** @type {NonNullable<typeof intake>} */ (intake)([job], { force: true }) > 0) {
        log(`[reconcile] queued ${job.ref} -> step ${job.stepId}`);
        dispatched++;
      } else log(`[skip] ${job.ref} — a run for this step is already queued or running`);
      continue;
    }
    const forged = await /** @type {NonNullable<typeof adapter.forgeCatchup>} */ (adapter.forgeCatchup)(job.ref, job.stepId);
    // The server computes this dedup key from the forged event; clear it so the
    // replay isn't dedup-skipped (the task is genuinely still waiting).
    if (store.hasSeen(forged.dedupKey)) store.unmarkSeen(forged.dedupKey);
    try {
      const res = await fetch(`http://127.0.0.1:${cfg.port}${forged.path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...forged.headers },
        body: forged.body,
      });
      if (res.status !== 200) throw new Error(`server returned ${res.status}`);
      log(`[reconcile] replayed ${job.ref} -> step ${job.stepId}`);
      dispatched++;
    } catch (e) {
      throw new Error(`could not reach server on 127.0.0.1:${cfg.port} (${e.message}). Is "${cfg.name}" running?`);
    }
  }
  log(`reconcile done — ${dispatched} task(s) replayed, ${resting.length - dispatched} skipped.`);
  return { replayed: dispatched, skipped: resting.length - dispatched };
}
