// The engine's boot sequence (`serve()`). The real order — listen + control socket + pidfile
// come BEFORE any webhook scrub/register (a registered hook POSTs a handshake at once):
//   quota reading → sandbox?.check() → ingress.up(port) → write publicUrl → server.listen →
//   startControl → write pidfile → (ephemeral) tracker.unregisterWebhooks → tracker.ensureLabels? →
//   tracker.registerWebhook (retried: transient errors forever on a 5 s→5 min backoff, a 404 three
//   times; SIGINT/SIGTERM abort the wait) → forge? (ephemeral scrub, register; best-effort) → sandbox?.reap() →
//   recoverInterrupted → restoreQueued → puller.pull → reconcile + merge catch-up (reconcileOnBoot only) →
//   SIGINT/SIGTERM handlers. A failure after ingress.up downs the ingress and closes control.
import fs from "node:fs";
import { ensurePrivateDir } from "../config.js";
import { planRestore } from "../queue.js";
import { startControl } from "../control.js";
import { readQuota } from "../quota-file.js";
import { runMergeCatchup, runReconcile } from "../commands/reconcile.js";
import { recoverInterrupted } from "./recovery.js";
import { fullAutoBanner } from "./banner.js";
import { retryTrackerCall } from "./boot-retry.js";

/**
 * Re-enqueue jobs that were waiting (queue.json) when the receiver died. Bypasses
 * intake: their `seen` key is already marked. Must run AFTER recoverInterrupted so
 * refs that were in running.json at boot (`runningRefs`, captured before recovery
 * clears them) went to the failure lane and are dropped. Entries stay in queue.json
 * (addQueued dedups) until they start. Local reads only.
 * @param {{cfg: import('../types.js').Config, store: import('../types.js').Store, queue: ReturnType<typeof import('../queue.js').createQueue>, emit: (event: string, ref: string, step: string, extra?: Record<string, any>) => void}} deps
 * @param {string[]} runningRefs
 */
function restoreQueued({ cfg, store, queue, emit }, runningRefs) {
  const { keep, drop } = planRestore(store.listQueued(), runningRefs, (cfg.pipeline || []).map((s) => s.id));
  for (const j of drop) store.removeQueued(j);
  if (!keep.length) return;
  console.log(`[restore] ${keep.length} queued job(s) re-enqueued`);
  for (const j of keep) {
    if (queue.enqueue(j)) emit("enqueued", j.ref, j.stepId, { restored: true });
  }
}

/**
 * @param {{
 *   cfg: import('../types.js').Config,
 *   state: import('./context.js').EngineState,
 *   store: import('../types.js').Store,
 *   adapter: import('../types.js').Adapter,
 *   forge: import('../types.js').Forge | null,
 *   ingress: import('../types.js').Ingress,
 *   sandbox: import('../types.js').Sandbox | null,
 *   heartbeat: ReturnType<typeof import('../heartbeat.js').createHeartbeat>,
 *   queue: ReturnType<typeof import('../queue.js').createQueue>,
 *   puller: ReturnType<typeof import('../pull.js').createPuller>,
 *   quotaPacer: {reading(q: any): void},
 *   emit: (event: string, ref: string, step: string, extra?: Record<string, any>) => void,
 *   intake: (jobs: import('../types.js').Job[], opts?: {force?: boolean}) => number,
 *   releaseOverlap?: (blocker: string) => void,
 *   startedAt: string,
 *   restart: (args: any) => Promise<any>,
 *   decommission: (args: any) => Promise<any>,
 *   ops: Record<string, (args: any) => Promise<any>>,
 *   shutdown: (signal: string) => unknown,
 *   reconcileOnBoot: boolean,
 *   retry?: {sleep?: (ms: number, signal?: AbortSignal) => Promise<void>, delays?: {transient?: (attempt: number) => number, notFound?: number[]}},
 * }} deps
 * @returns {() => Promise<void>}
 */
export function createServe(deps) {
  const { cfg, state, store, adapter, forge, ingress, sandbox, heartbeat, puller, quotaPacer, emit, intake, releaseOverlap, startedAt, restart, decommission, ops, shutdown, reconcileOnBoot, retry = {} } = deps;
  return async function serve() {
    const meta = ingress.describe();
    console.log(`[boot] profile "${cfg.name}" — tracker ${cfg.provider}, ingress ${meta.name}${forge ? `, forge ${forge.describe().name}` : ""}${sandbox ? `, sandbox ${sandbox.describe().name}` : ""}`);

    for (const dir of [cfg.stateDir, cfg.logDir]) {
      const result = ensurePrivateDir(dir, { tighten: true });
      if (result.tightened) console.error(`[boot] tightened ${dir} permissions 0${result.from.toString(8)} → 0700`);
    }

    // fullAuto runs agents with their CLI's skip-permissions flag: loud at every boot unless every
    // step is sandboxed. Warn only. See docs/sandbox.md.
    const banner = fullAutoBanner(cfg);
    if (banner) console.error(banner);

    if (cfg.overlapGuard && !(cfg.pipeline || []).some((s) => s.drainWorktree) && !forge) {
      // Locks release on a drain, a fail, or a forge merge. Without a drain step or a
      // forge, a ref that finishes cleanly keeps its lock and its waiters wait forever.
      console.error(
        "\n  ⚠  overlapGuard is ON but no step has drainWorktree and no forge is configured —\n" +
          "     file-overlap locks never release on success (only on fail). Add a drain step\n" +
          "     or a forge block, or turn overlapGuard off.\n",
      );
    }

    // The persisted quota reading, evaluated once before any work is admitted (a pause holds
    // the restored queue and the boot pull too).
    quotaPacer.reading(readQuota(cfg.stateDir));

    // A configured sandbox that isn't there must never mean "run on the host": refuse to boot,
    // before anything is brought up.
    if (sandbox) {
      const c = await sandbox.check();
      if (!c.ok) throw new Error(`sandbox (${sandbox.describe().name}) unavailable: ${c.reason}`);
    }

    let ingressUp = false;
    try {
      const { url } = await ingress.up(cfg.port);
      ingressUp = true;
      fs.writeFileSync(cfg.publicUrlFile, url);
      heartbeat.update({ url });
      ingress.onExit?.((reason) => heartbeat.update({ ingressDown: { at: new Date().toISOString(), reason } }));

      // Listen BEFORE registering: registering a webhook makes the tracker immediately
      // POST a handshake/ping to the public URL, which must reach a live server (Asana
      // needs the X-Hook-Secret echoed back, or it fails the hook with a 502).
      await new Promise((resolve) => state.server.listen(cfg.port, "127.0.0.1", () => resolve(undefined)));
      state.control = await startControl(cfg, { startedAt, adapter, restart, decommission, commands: ops }); // owner check reads the OLD pidfile — must run before the write below
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
      // The one tracker call boot can't skip. A tracker outage must not kill the receiver: retry
      // it (src/engine/boot-retry.js) and say so in the heartbeat, so `status` shows
      // `starting (…)` instead of UP. The real signal handlers come last; until then a
      // SIGINT/SIGTERM (`agenthook stop`) aborts the wait and the catch below downs the ingress.
      const aborter = new AbortController();
      /** @param {NodeJS.Signals} sig */
      const onSignal = (sig) => aborter.abort(new Error(`boot aborted by ${sig} while waiting for the tracker`));
      process.once("SIGINT", onSignal);
      process.once("SIGTERM", onSignal);
      let waited = false;
      try {
        await retryTrackerCall(() => adapter.registerWebhook(url), {
          ...retry,
          signal: aborter.signal,
          onWaiting: () => {
            if (!waited) heartbeat.update({ starting: "tracker unavailable" });
            waited = true;
          },
        });
      } finally {
        process.removeListener("SIGINT", onSignal);
        process.removeListener("SIGTERM", onSignal);
      }
      if (waited) heartbeat.update({ starting: null });

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

      // A run that outlived a killed receiver keeps editing its worktree (and could write a
      // verdict for a run the board shows as failed): remove it before failing its record.
      // Best-effort — the runs fail below either way, and a later reap finishes the job.
      if (sandbox) {
        try {
          const reaped = await sandbox.reap();
          if (reaped.containers.length || reaped.networks.length) {
            const left = reaped.runs.length ? `run ${reaped.runs.join(", ")}` : "a previous run";
            console.log(`[recover] reaped ${reaped.containers.length} container(s), ${reaped.networks.length} network(s) left by ${left}`);
            emit("sandbox_reaped", "", "", { containers: reaped.containers.length, networks: reaped.networks.length, runs: reaped.runs });
          }
        } catch (e) {
          console.error("[recover] sandbox reap failed (continuing):", e.message);
        }
      }
      // Self-heal from LOCAL state only (no board poll — see recoverInterrupted).
      const runningRefs = Object.keys(store.listRunning());
      await recoverInterrupted(store, adapter, emit, releaseOverlap);
      restoreQueued(deps, runningRefs);
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
        // Then PRs merged in the gap (their forge webhook never arrived). Never throws by
        // contract; the try is belt-and-braces so it can't abort boot either.
        try {
          const { merged, skipped } = await runMergeCatchup(cfg, { store, adapter, forge, intake, log: (m) => console.log(`[boot] ${m}`) });
          console.log(`[boot] post-restart merge catch-up — ${merged} replayed, ${skipped} skipped`);
        } catch (e) {
          console.error("[boot] post-restart merge catch-up failed (continuing):", e.message);
        }
      }
    } catch (e) {
      // Boot failed after the tunnel came up — tear it down so it doesn't orphan
      // (an orphaned ngrok endpoint causes ERR_NGROK_334 on the next start).
      if (ingressUp) await ingress.down().catch(() => {});
      state.control?.close();
      throw e;
    }

    console.log(`${store.secretCount()} secret(s), ${store.seenCount()} item(s) seen`);
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
  };
}
