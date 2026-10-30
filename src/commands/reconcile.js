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
//
// With a forge, reconcile then also replays agent PRs merged while the receiver was down
// (`runMergeCatchup`, via the `reconcile_merges` op — only the receiver can intake them), and
// re-checks the rows already flagged with a PR reason (src/recheck.js) — those rows only.
import { loadConfig } from "../config.js";
import { requireStarted } from "../profile.js";
import { createStore } from "../store.js";
import { createAdapter } from "../trackers/index.js";
import { isPipeline } from "../pipeline.js";
import { staleOverlaps } from "../overlap.js";
import { readRecheckState, recordBoardDone } from "../recheck.js";
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
  if (cfg.forge) await reconcileMergesOverControl(cfg);
}

/** Merges missed while down: only the receiver can intake them, so ask it. Best-effort — a
 * failure warns and leaves the exit code alone. @param {import('../types.js').Config} cfg */
async function reconcileMergesOverControl(cfg) {
  try {
    const reply = await controlRequest(cfg.controlSock, "reconcile_merges", {}, { timeoutMs: 60000 });
    if (!reply.ok) throw new Error(reply.error);
    for (const line of reply.result.log || []) console.log(line);
  } catch (e) {
    console.warn(`warning: merge catch-up skipped — ${e.code === "timeout" ? "timed out" : e.code === "down" ? "receiver is down" : e.message}`);
  }
}

/** Ask the live receiver to reconcile (in-process trackers). @param {import('../types.js').Config} cfg */
async function reconcileOverControl(cfg) {
  let reply;
  try {
    reply = await controlRequest(cfg.controlSock, "reconcile", {}, { timeoutMs: 60000 }); // board + forge scan
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

/** With no watermark yet, the merge catch-up looks back this far. */
export const MERGE_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Merge catch-up: replay the `merge` job for agent PRs the forge merged while the receiver
 * was down (its `merged` webhook never arrived), so completeOnMerge / `complete` / the drain
 * still run and the tracker's close-release frees dependents. Explicit only — reconcile,
 * reconcile-on-boot and the `reconcile_merges` op; never a plain boot or a timer.
 *
 * Asks the forge for PRs merged after the stored watermark (default: the last 7 days) and
 * intakes one `merge` job per PR, oldest first, WITHOUT force: `merged:<pr>` is the same
 * permanent dedup key the live webhook uses, so a merge already handled is never re-run. A task
 * already completed on the board still gets its merge job (it self-closes), and — given `emit` —
 * a `board_done` (`via: "recheck"`, src/recheck.js) for its likely-missed done webhook.
 * Best-effort: no forge / no list method / a forge error logs and returns; the watermark only
 * advances after a successful list. Never throws.
 * @param {import('../types.js').Config} cfg
 * @param {{store: import('../types.js').Store, adapter: import('../types.js').Adapter, forge: import('../types.js').Forge|null|undefined, intake: (jobs: import('../types.js').Job[], opts?: {force?: boolean}) => number, emit?: (event: string, ref: string, step: string, extra?: Record<string, any>) => void, log?: (msg: string) => void, now?: () => number}} deps
 * @returns {Promise<{merged: number, skipped: number}>}
 */
export async function runMergeCatchup(cfg, { store, adapter, forge, intake, emit, log = console.log, now = Date.now }) {
  if (!forge || typeof forge.listMergedAgentPrs !== "function") {
    log(`merge catch-up skipped — ${forge ? `forge "${forge.describe().name}" cannot list merged PRs` : "no forge configured"}.`);
    return { merged: 0, skipped: 0 };
  }
  const since = store.getMergeWatermark() ?? new Date(now() - MERGE_LOOKBACK_MS).toISOString();
  let prs;
  try {
    prs = await forge.listMergedAgentPrs(since);
  } catch (e) {
    log(`merge catch-up: listing merged PRs failed (${e.message}) — watermark unchanged.`);
    return { merged: 0, skipped: 0 };
  }
  prs = [...prs].sort((a, b) => Date.parse(a.mergedAt) - Date.parse(b.mergedAt));
  const stepId = cfg.pipeline?.find((s) => s.completeOnMerge)?.id || "";
  let merged = 0;
  let skipped = 0;
  /** @type {number|null} mergedAt of the oldest PR whose fetch failed — the watermark stays below it */
  let failedAt = null;
  /** @type {ReturnType<typeof readRecheckState>|undefined} read once, on the first completed task */
  let local;
  for (const p of prs) {
    let task;
    try {
      task = await adapter.fetchTask(p.ref);
    } catch (e) {
      log(`[skip] PR #${p.pr} (${p.ref}) — fetch failed (${e.message})`);
      skipped++;
      failedAt ??= Date.parse(p.mergedAt);
      continue;
    }
    // A completed task's board_done webhook may have been missed too: record it (ours only,
    // never on live work). Its merge job still runs — on a completed task it is self-closing
    // (no tracker write) and records `prState: merged` + the `merged` event.
    if (task.completed && task.assignedToUs && emit) {
      local ??= readRecheckState(cfg);
      const row = local.rows.find((r) => r.ref === p.ref);
      const live = row && ["running", "queued", "done"].includes(row.status);
      if (!live && recordBoardDone({ store, emit }, p.ref, local.events)) log(`[done] ${p.ref} — completed on the board; board_done recorded`);
    }
    if (intake([{ kind: "merge", ref: p.ref, stepId, dedupKey: `merged:${p.pr}`, ...(p.boardCloses ? { boardCloses: true } : {}) }]) > 0) {
      log(`[merge] queued ${p.ref} — PR #${p.pr} merged ${p.mergedAt}${task.completed ? " (task already completed)" : ""}`);
      merged++;
    } else {
      log(`[skip] PR #${p.pr} (${p.ref}) — merge already handled`);
      skipped++;
    }
  }
  // Every listed PR merged after `since`, so the newest one is past the old watermark. A failed
  // fetch holds it just below that PR so the next scan lists it again (`seen` dedups the rest).
  const newest = prs.filter((p) => failedAt === null || Date.parse(p.mergedAt) < failedAt).at(-1)?.mergedAt;
  if (newest) store.setMergeWatermark(newest);
  log(`merge catch-up done — ${merged} merged PR(s) replayed, ${skipped} skipped.`);
  return { merged, skipped };
}
