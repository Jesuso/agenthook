// Per-profile heartbeat: each running server writes a small JSON status into its
// central state dir (~/.agenthook/<name>/heartbeat.json) so `agenthook ls`/`status`
// can report every profile without touching the live process. Liveness is the
// pidfile pid being alive; the heartbeat carries the rest (port, url, queue, …).
import fs from "node:fs";
import path from "node:path";
import { registryDir } from "./config.js";

/** @param {number} pid */
export function isAlive(pid) {
  if (!pid || Number.isNaN(pid)) return false;
  try {
    process.kill(pid, 0); // signal 0 = existence check, no actual signal
    return true;
  } catch (e) {
    return e.code === "EPERM"; // exists but not ours
  }
}

/**
 * A heartbeat writer bound to one config. Holds the merged record in memory and
 * flushes the whole thing on every update.
 * @param {import('./types.js').Config} cfg
 */
export function createHeartbeat(cfg) {
  /** @type {Record<string, any>} */
  let state = {
    name: cfg.name,
    pid: process.pid,
    port: cfg.port,
    url: null,
    tracker: cfg.provider,
    ingress: cfg.ingress?.type || "manual",
    fullAuto: !!cfg.fullAuto,
    repoPath: cfg.repoPath,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    queue: { active: 0, queued: 0 },
    lastEvent: null,
  };

  const flush = () => {
    state.updatedAt = new Date().toISOString();
    try {
      fs.writeFileSync(cfg.heartbeatFile, JSON.stringify(state, null, 2));
    } catch {
      /* state dir may be gone during shutdown */
    }
  };

  flush();
  return {
    /** @param {Record<string, any>} partial */
    update(partial) {
      state = { ...state, ...partial };
      flush();
    },
    clear() {
      try {
        fs.rmSync(cfg.heartbeatFile, { force: true });
      } catch {
        /* ignore */
      }
    },
  };
}

/** Read one profile's heartbeat + liveness. @param {string} name */
export function readProfile(name) {
  const dir = path.join(registryDir, name);
  const hbFile = path.join(dir, "heartbeat.json");
  const pidFile = path.join(dir, "server.pid");
  /** @type {any} */
  let hb = null;
  try {
    hb = JSON.parse(fs.readFileSync(hbFile, "utf8"));
  } catch {
    /* no heartbeat */
  }
  let pid = 0;
  try {
    pid = Number(fs.readFileSync(pidFile, "utf8").trim());
  } catch {
    /* no pidfile */
  }
  return { name, dir, pid, up: isAlive(pid), heartbeat: hb };
}

/** List every profile that has a state dir under ~/.agenthook. */
export function listProfiles() {
  /** @type {string[]} */
  let names = [];
  try {
    names = fs
      .readdirSync(registryDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    /* registry not created yet */
  }
  return names.sort().map(readProfile);
}
