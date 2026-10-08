// Per-profile heartbeat: each running server writes a small JSON status into its
// central state dir (~/.agenthook/<name>/heartbeat.json) so `agenthook ls`/`status`
// can report every profile without touching the live process. Liveness is the
// pidfile pid being alive; the heartbeat carries the rest (port, url, queue, …).
import fs from "node:fs";
import path from "node:path";
import { registryDir } from "./config.js";
import { reposOf } from "./repos.js";

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

/** "owner/name" from a block's `repository`, else `owner` + `repo`. @param {any} b */
const repoOf = (b) => (b?.repository ? String(b.repository) : b?.owner && b?.repo ? `${b.owner}/${b.repo}` : null);

/**
 * The GitHub repository a profile's PRs live in — the forge's, else a github /
 * github-projects tracker's — so a config-less reader (`ah ui`) can build PR links.
 * @param {import('./types.js').Config} cfg
 * @returns {string|null}
 */
export function repositoryOf(cfg) {
  const fromForge = repoOf(cfg.forge);
  if (fromForge) return fromForge;
  if (cfg.provider === "github" || cfg.provider === "github-projects") return repoOf(cfg.providerConfig);
  return null;
}

/**
 * The write allowlist for the v2 instructions editor (`PUT /api/instructions`): every
 * standing-instructions file the pipeline actually reads, grouped by role. Precedence
 * when one path serves several roles is step > default > repo — first occurrence wins
 * the scope, later roles only add their ids. Pure (no fs); paths are already absolute
 * from config.js, `path.resolve` is defensive for hand-built test fixtures.
 * @param {import('./types.js').Config} cfg
 * @returns {{ path: string, scope: 'step'|'default'|'repo', ids: string[] }[]}
 */
export function instructionTargets(cfg) {
  /** @type {Map<string, { path: string, scope: 'step'|'default'|'repo', ids: string[] }>} */
  const byPath = new Map();
  /** @param {string} p @param {'step'|'default'|'repo'} scope @param {string} id */
  const add = (p, scope, id) => {
    const resolved = path.resolve(p);
    const existing = byPath.get(resolved);
    if (existing) {
      if (!existing.ids.includes(id)) existing.ids.push(id);
    } else {
      byPath.set(resolved, { path: resolved, scope, ids: [id] });
    }
  };

  const steps = (cfg.pipeline || []).filter((s) => !s.manual);
  for (const step of steps) {
    if (step.instructionsFile) add(step.instructionsFile, "step", step.id);
  }
  for (const step of steps) {
    if (!step.instructionsFile) add(cfg.instructionsFile, "default", step.id);
  }
  for (const repo of reposOf(cfg)) {
    if (repo.instructionsFile) add(repo.instructionsFile, "repo", repo.id);
  }

  return [...byPath.values()];
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
    stateKey: cfg.stateKey,
    pid: process.pid,
    port: cfg.port,
    url: null,
    tracker: cfg.provider,
    ingress: cfg.ingress?.type || "manual",
    fullAuto: !!cfg.fullAuto,
    maxConcurrent: cfg.maxConcurrent,
    repoPath: cfg.repoPath,
    configPath: cfg.configPath,
    instructions: instructionTargets(cfg),
    repos: reposOf(cfg).map((r) => ({ id: r.id, path: r.path })),
    repository: repositoryOf(cfg),
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

/** Read one profile's heartbeat + liveness. `registry` is overridable for tests.
 * @param {string} name @param {string} [registry] */
export function readProfile(name, registry = registryDir) {
  const dir = path.join(registry, name);
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

/** List every profile that has a state dir under ~/.agenthook. @param {string} [registry] */
export function listProfiles(registry = registryDir) {
  /** @type {string[]} */
  let names = [];
  try {
    names = fs
      .readdirSync(registry, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    /* registry not created yet */
  }
  return names.sort().map((n) => readProfile(n, registry));
}
