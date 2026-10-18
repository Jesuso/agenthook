// The engine's exit paths: the shutdown/teardown factory (graceful drain, forced exit,
// fatal handler) plus the pure-ish pieces it and decommission use — webhook unregister,
// the exit wait, and teardown's once-only respawn/archive tail.
import fs from "node:fs";
import path from "node:path";
import { restartSpawnArgs, spawnDetached } from "../respawn.js";
import { moveStateDir } from "../state-move.js";
import { archiveStateDir } from "../archive.js";
import { crashRecord } from "./recovery.js";

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
 * The engine's exit paths over the shared engine state: `shutdown` (first signal drains, a
 * second force-kills), `forceExit`, `teardown` (shared by both) and `onFatal` (last resort).
 * @param {{
 *   cfg: import('../types.js').Config,
 *   state: import('./context.js').EngineState,
 *   queue: ReturnType<typeof import('../queue.js').createQueue>,
 *   ingress: import('../types.js').Ingress,
 *   heartbeat: ReturnType<typeof import('../heartbeat.js').createHeartbeat>,
 *   children: Set<import('node:child_process').ChildProcess>,
 *   store: import('../types.js').Store,
 *   quotaPacer: {stop(): void},
 *   isRestartPending: () => boolean,
 *   isDecommissionPending: () => boolean,
 * }} deps
 */
export function createExits({ cfg, state, queue, ingress, heartbeat, children, store, quotaPacer, isRestartPending, isDecommissionPending }) {
  /** Final teardown shared by graceful + forced exit. */
  function teardown() {
    quotaPacer.stop();
    heartbeat.clear();
    state.control?.close();
    try {
      fs.rmSync(cfg.pidFile, { force: true });
    } catch {
      /* ignore */
    }
    // Restart: spawn the successor (after an optional move); decommission: archive the state
    // dir. Exactly once, after the pidfile, control socket and listener are released and before
    // either exit path below. No events/heartbeat after this point.
    if ((state.respawnOnExit || state.archiveOnExit) && !state.finished) {
      state.finished = true;
      finishTeardown({ cfg, respawn: state.respawnOnExit, moveTo: state.moveOnExit, archive: state.archiveOnExit });
    }
    state.server.close(() => process.exit(0));
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
      state.respawnOnExit = false;
      state.moveOnExit = undefined;
    }
    if (!archive) state.archiveOnExit = false;
    if (state.draining) {
      forceExit(`${signal || "signal"} during drain`);
      return;
    }
    state.draining = true;
    if (respawn) {
      state.respawnOnExit = true;
      state.moveOnExit = moveTo;
    }
    if (archive) state.archiveOnExit = true;

    // Stop new work reaching the queue, then close the front door so no fresh
    // events arrive. In-flight `claude -p` children keep running untouched.
    queue.close();
    try {
      await ingress.down();
    } catch (e) {
      console.error("[ingress] down failed:", e.message);
    }
    state.server.close(); // stop accepting new connections; in-flight handlers finish

    const { active, queued } = queue.state();
    if (isRestartPending() || isDecommissionPending()) {
      const what = isRestartPending() ? "restart" : "decommission";
      if (active > 0) {
        console.log(`\n[shutdown] ${signal || ""} — ${what} cancelled; waiting for ${active} running agent(s); send the signal again to force-kill`);
        heartbeat.update({ draining: true, queue: queue.state() });
      }
      await waitForExit(queue, true);
      const how = state.respawnOnExit ? "restarting" : state.archiveOnExit ? "archiving" : "exiting";
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

  return { teardown, forceExit, shutdown, onFatal };
}
