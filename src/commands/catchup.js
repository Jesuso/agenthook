// `agenthook catchup <ref> [--force]` — replay one item the receiver missed while
// down. Webhooks fire on a TRANSITION (a task moving into a section), not a state, so
// a missed move can't be polled back; instead we forge the exact signed event the
// tracker would have sent and POST it to the live server, which re-reads the task's
// live section and routes it to the matching step. Reuses the whole dispatch path
// (dedup, worktree, PR). See docs/architecture.md. (`reconcile` does this in bulk.)
import { loadConfig } from "../config.js";
import { createStore } from "../store.js";
import { createAdapter } from "../trackers/index.js";

/** @param {any} args */
export async function catchup(args) {
  const cfg = loadConfig({ configPath: args.config });
  const store = createStore(cfg.dataDir);
  const adapter = createAdapter(cfg, store);

  const ref = args._[0];
  if (!ref) die("usage: agenthook catchup <ref> [--force]");
  if (typeof adapter.forgeCatchup !== "function") die(`tracker "${cfg.provider}" has no catchup support`);

  const forged = adapter.forgeCatchup(ref);
  store.reloadSeen();
  if (store.hasSeen(forged.dedupKey) && !args.force) {
    die(`${ref} already seen — the server would dedup-skip it. Re-run with --force.`);
  }
  let removed = false;
  if (store.hasSeen(forged.dedupKey) && args.force) {
    store.unmarkSeen(forged.dedupKey);
    removed = true;
    console.log(`[force] cleared dedup key ${forged.dedupKey}`);
  }
  try {
    const res = await fetch(`http://127.0.0.1:${cfg.port}${forged.path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...forged.headers },
      body: forged.body,
    });
    console.log(`POST ${forged.path} -> ${res.status}`);
    if (res.status !== 200) throw new Error(`server returned ${res.status}`);
    console.log(`dispatched ${ref}. The server routes it to the step its current section maps to.`);
  } catch (e) {
    if (removed) {
      store.markSeen(forged.dedupKey);
      console.error(`[rollback] restored dedup key (state unchanged)`);
    }
    die(`could not reach server on 127.0.0.1:${cfg.port} (${e.message}). Is "${cfg.name}" running?`);
  }
}

/** @param {string} msg @returns {never} */
function die(msg) {
  console.error(msg);
  process.exit(1);
}
