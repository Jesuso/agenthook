// Ask the active provider whether one item is finished. Provider-blind: it goes
// through the same adapter the engine uses, so it works for Asana, GitHub, or any
// adapter that implements fetchTask(ref) -> { completed }.
//
//   node scripts/_done-check.mjs <ref>   -> prints "true" | "false" | "unknown"
//
// "unknown" (never "false") on any error, so cleanup never deletes a worktree on
// a transient API failure — it just falls back to the PR-state signal.
import { loadConfig } from "../src/config.js";
import { createStore } from "../src/store.js";
import { createAdapter } from "../src/providers/index.js";

const ref = process.argv[2];
try {
  const cfg = loadConfig();
  const adapter = createAdapter(cfg, createStore(cfg.dataDir));
  const task = await adapter.fetchTask(ref);
  process.stdout.write(task?.completed === true ? "true" : "false");
} catch {
  process.stdout.write("unknown");
}
