// `agenthook digest [name] [--json]` — write + print a profile's Digest from the CLI process,
// no receiver needed: runs the same `createDigester` (src/digest.js) directly against the
// profile's own config + state dir. Not audited to control-audit.jsonl (that's the receiver's
// `digest` control op, src/ops.js) — this path never opens control.sock.
import { defaultProfileKey, pickProfile } from "../agent-api.js";
import { loadConfig } from "../config.js";
import { repositoryOf } from "../heartbeat.js";
import { createEmitter } from "../events.js";
import { createDigester } from "../digest.js";

/** @param {any} args @param {{registry?: string, run?: (bin: string, args: string[], cwd: string) => Promise<string>, now?: () => number}} [deps] */
export async function digest(args, deps = {}) {
  const picked = pickProfile(args._[0], defaultProfileKey(args.config), deps.registry);
  if ("error" in picked) {
    console.error(picked.error);
    process.exitCode = 1;
    return;
  }
  const { entry } = picked;
  if (!entry.configPath || entry.configMissing) {
    console.error(`profile "${entry.stateKey}" has no usable config (${entry.configPath ?? "none recorded"})`);
    process.exitCode = 1;
    return;
  }

  /** @type {any} */
  let cfg;
  try {
    cfg = loadConfig({ configPath: entry.configPath });
  } catch (e) {
    console.error(`cannot load config for "${entry.stateKey}": ${e.message}`);
    process.exitCode = 1;
    return;
  }
  // A changed stateId could point this config at a different state dir — never write a digest
  // into a profile it doesn't belong to.
  if (cfg.stateDir !== entry.dir) {
    console.error(`"${entry.stateKey}"'s config now resolves to a different state dir (${cfg.stateDir}) than its profile (${entry.dir}); refusing to write there`);
    process.exitCode = 1;
    return;
  }

  // The receiver stays the single writer of events.jsonl while it's up.
  const emit = entry.up ? undefined : createEmitter(cfg.dataDir);
  const digester = createDigester({ cfg, emit, repository: repositoryOf(cfg), run: deps.run, now: deps.now });

  /** @type {any} */
  let rec;
  try {
    rec = await digester.request();
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
    return;
  }

  if (args.json) {
    console.log(JSON.stringify(rec));
    return;
  }
  console.log(rec.text);
  console.log(`generated ${rec.generatedAt}${rec.costUsd !== undefined ? ` · $${rec.costUsd.toFixed(2)}` : ""}`);
}
