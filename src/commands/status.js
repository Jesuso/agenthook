// `agenthook status [name]` — detail for one profile. With no name, uses the
// profile discovered from the current dir's agenthook.config.json.
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../config.js";
import { readProfile } from "../heartbeat.js";
import { ago } from "./ls.js";

/** @param {any} args */
export async function status(args) {
  let name = args._[0];
  let logDir = null;
  if (!name) {
    const cfg = loadConfig({ configPath: args.config });
    name = cfg.name;
    logDir = cfg.logDir;
  }

  const p = readProfile(name);
  if (!p.heartbeat && !p.pid) {
    console.log(`no such profile "${name}" (nothing under ~/.agenthook/${name}).`);
    return;
  }
  const hb = p.heartbeat || {};
  logDir = logDir || path.join(p.dir, "logs");

  console.log(`profile : ${name}`);
  console.log(`status  : ${p.up ? `UP (pid ${p.pid})` : "down"}`);
  console.log(`tracker : ${hb.tracker || "?"}`);
  console.log(`ingress : ${hb.ingress || "?"}${hb.url ? `  ${hb.url}` : ""}`);
  console.log(`port    : ${hb.port || "?"}`);
  console.log(`repo    : ${hb.repoPath || "?"}`);
  console.log(`auto    : ${hb.fullAuto ? "fullAuto (--dangerously-skip-permissions)" : "permissioned"}`);
  if (hb.queue) console.log(`queue   : ${hb.queue.active} running, ${hb.queue.queued} queued`);
  if (hb.seen != null) console.log(`seen    : ${hb.seen} item(s)`);
  if (hb.startedAt) console.log(`started : ${ago(hb.startedAt)}`);
  if (hb.lastEvent) {
    const e = hb.lastEvent;
    console.log(`last    : ${e.kind} ${e.ref}${e.text ? ` "${e.text.slice(0, 60)}"` : ""} (${ago(e.at)})`);
  }

  // Most recent run logs.
  try {
    const logs = fs
      .readdirSync(logDir)
      .filter((f) => f.endsWith(".log"))
      .sort()
      .slice(-5);
    if (logs.length) {
      console.log(`\nrecent runs (${logDir}):`);
      for (const l of logs) console.log(`  ${l}`);
    }
  } catch {
    /* no logs yet */
  }
}
