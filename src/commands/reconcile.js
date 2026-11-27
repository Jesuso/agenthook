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
// The reconcile body itself (`runReconcile`), the merge catch-up (`runMergeCatchup`) and
// `MERGE_LOOKBACK_MS` live in ../engine/reconcile.js — they're engine logic the boot sequence
// and the control ops also call; this file is just the CLI entry over them.
import { loadConfig } from "../config/index.js";
import { requireStarted } from "../profile.js";
import { createStore } from "../store/index.js";
import { createAdapter } from "../trackers/index.js";
import { runReconcile } from "../engine/reconcile.js";
import { controlRequest } from "../control/client.js";

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
