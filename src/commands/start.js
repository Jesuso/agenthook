// `agenthook start` — boot a profile's receiver. Server owns the ingress lifecycle
// (see engine.js). Refuses to start if the profile is already running (pid alive).
//
// `--reconcile-on-boot` is internal: a control-socket `restart` respawns with it so the
// new server runs one reconcile after boot. `--detach` forwards it to the child.
import { loadConfig } from "../config.js";
import { createEngine } from "../engine.js";
import { readProfile } from "../heartbeat.js";
import { claimStateDir } from "../profile.js";
import { startArgv, spawnDetached } from "../respawn.js";

/** @param {any} args */
export async function start(args) {
  const cfg = loadConfig({ configPath: args.config });
  const reconcileOnBoot = !!args["reconcile-on-boot"];

  const existing = readProfile(cfg.stateKey);
  if (existing.up) {
    throw new Error(`profile "${cfg.name}" is already running (pid ${existing.pid}). Run \`agenthook stop\` first.`);
  }

  if (args.detach) {
    // Check here, not only in the child: spawnDetached writes receiver.log into the state dir
    // (so the child would no longer see it fresh), and the refusal belongs in this terminal.
    claimStateDir(cfg);
    const { pid, logPath } = spawnDetached(cfg, { command: process.execPath, args: startArgv(cfg, { reconcileOnBoot }) });
    console.log(`started "${cfg.name}" in background (pid ${pid}). Log: ${logPath}`);
    return;
  }

  await createEngine(cfg, { reconcileOnBoot }).serve();
  // serve() keeps the process alive via the open server + signal handlers.
}
