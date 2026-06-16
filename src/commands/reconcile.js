// `agenthook reconcile` — the ONLY board poll, and it is user-explicit by design.
// Forward motion is event-driven; this exists to recover from a webhook the server
// missed while down (a task left resting in a step's source section with no event to
// fire it). It lists resting tasks, then replays each as a forged, signed event
// through the live server — reusing the whole dispatch path, exactly like `catchup`.
//
// Tasks currently mid-step (in the local running record) are skipped so a reconcile
// never double-runs in-flight work.
import { loadConfig } from "../config.js";
import { createStore } from "../store.js";
import { createAdapter } from "../trackers/index.js";
import { isPipeline } from "../pipeline.js";

/** @param {any} args */
export async function reconcile(args) {
  const cfg = loadConfig({ configPath: args.config });
  const store = createStore(cfg.dataDir);
  const adapter = createAdapter(cfg, store);

  if (!isPipeline(cfg)) die(`reconcile is for pipeline configs; "${cfg.name}" has no tracker.pipeline.`);
  if (typeof adapter.listResting !== "function" || typeof adapter.forgeCatchup !== "function") {
    die(`tracker "${cfg.provider}" does not support reconcile.`);
  }

  const resting = await adapter.listResting();
  if (!resting.length) {
    console.log("board clean — no resting tasks to reconcile.");
    return;
  }
  const running = store.listRunning();
  store.reloadSeen();

  let dispatched = 0;
  for (const job of resting) {
    if (job.ref in running) {
      console.log(`[skip] ${job.ref} is mid-step (${running[job.ref].stepId}) — not replaying`);
      continue;
    }
    // The server computes this dedup key from the forged event; clear it so the
    // replay isn't dedup-skipped (the task is genuinely still waiting).
    const serverKey = `step:${job.stepId}:${job.ref}`;
    if (store.hasSeen(serverKey)) store.unmarkSeen(serverKey);

    const forged = adapter.forgeCatchup(job.ref);
    try {
      const res = await fetch(`http://127.0.0.1:${cfg.port}${forged.path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...forged.headers },
        body: forged.body,
      });
      if (res.status !== 200) throw new Error(`server returned ${res.status}`);
      console.log(`[reconcile] replayed ${job.ref} -> step ${job.stepId}`);
      dispatched++;
    } catch (e) {
      die(`could not reach server on 127.0.0.1:${cfg.port} (${e.message}). Is "${cfg.name}" running?`);
    }
  }
  console.log(`reconcile done — ${dispatched} task(s) replayed, ${resting.length - dispatched} skipped.`);
}

/** @param {string} msg @returns {never} */
function die(msg) {
  console.error(msg);
  process.exit(1);
}
