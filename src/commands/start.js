// `agenthook start` — boot a profile's receiver. Server owns the ingress lifecycle
// (see engine.js). Refuses to start if the profile is already running (pid alive).
import path from "node:path";
import { spawn } from "node:child_process";
import { loadConfig } from "../config.js";
import { createEngine } from "../engine.js";
import { readProfile } from "../heartbeat.js";

/** @param {any} args */
export async function start(args) {
  const cfg = loadConfig({ configPath: args.config });

  const existing = readProfile(cfg.name);
  if (existing.up) {
    throw new Error(`profile "${cfg.name}" is already running (pid ${existing.pid}). Run \`agenthook stop\` first.`);
  }

  if (args.detach) {
    const bin = path.join(cfg.installDir, "bin", "agenthook.js");
    const child = spawn(process.execPath, [bin, "start", "--config", cfg.configPath], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    console.log(`started "${cfg.name}" in background (pid ${child.pid}). Tail: agenthook status ${cfg.name}`);
    return;
  }

  await createEngine(cfg).serve();
  // serve() keeps the process alive via the open server + signal handlers.
}
