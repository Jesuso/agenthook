// `agenthook reconcile` — the ONLY board poll, and it is user-explicit by design.
// Forward motion is event-driven; this exists to recover from a webhook the server
// missed while down (a task left resting in a step's source section with no event to
// fire it). It lists resting tasks, then replays each as a forged, signed event
// through the live server — reusing the whole dispatch path, exactly like `catchup`.
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

/** @param {any} args */
export async function reconcile(args) {
  const cfg = loadConfig({ configPath: args.config });
  requireStarted(cfg);
  const store = createStore(cfg.dataDir);
  const adapter = createAdapter(cfg, store);
  try {
    await runReconcile(cfg, { store, adapter });
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}

/**
 * The reconcile body, callable in-process (the engine runs it once on a
 * `--reconcile-on-boot` restart). Throws instead of exiting; replays through the
 * live server on 127.0.0.1:<port>.
 * @param {import('../types.js').Config} cfg
 * @param {{store: import('../types.js').Store, adapter: import('../types.js').Adapter, log?: (msg: string) => void}} deps
 * @returns {Promise<{replayed: number, skipped: number}>}
 */
export async function runReconcile(cfg, { store, adapter, log = console.log }) {
  if (!isPipeline(cfg)) throw new Error(`reconcile is for pipeline configs; "${cfg.name}" has no tracker.pipeline.`);
  if (typeof adapter.listResting !== "function" || typeof adapter.forgeCatchup !== "function") {
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
    const forged = await adapter.forgeCatchup(job.ref, job.stepId);
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
