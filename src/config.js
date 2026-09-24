// Loads an agenthook.config.json profile and resolves it into an absolute,
// secret-filled runtime Config.
//
// v2 model (see docs/agenthook-v2.md):
//   - Config lives in a project dir as `agenthook.config.json` (cwd auto-discovery,
//     walking up like tsconfig.json), or anywhere via an explicit path.
//   - Secrets are NEVER literals in a shared file: any string value may carry
//     `${VAR}` refs that resolve from the environment (a `.env` beside the config
//     and one in cwd are auto-loaded first; shell-exported vars win).
//   - Four distinct locations, never conflated: the install dir (read-only package),
//     the config dir, the central state dir (~/.agenthook/<name>), and the target repo.
//   - Runtime state is central and keyed by the profile `name`, so a global
//     `agenthook ls` can see every profile without spelunking project dirs.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The installed package root (this file is src/config.js). Used only to read
// bundled templates — never for runtime state.
export const installDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Where all profiles keep their runtime state, one subdir per profile name.
export const registryDir = path.join(os.homedir(), ".agenthook");

const CONFIG_NAME = "agenthook.config.json";

/** Expand ~ and resolve a path against a base dir (absolute paths pass through).
 * @param {string} p @param {string} base */
function resolvePath(p, base) {
  if (p.startsWith("~")) p = path.join(os.homedir(), p.slice(1));
  return path.isAbsolute(p) ? p : path.resolve(base, p);
}

/** Walk up from `start` looking for agenthook.config.json. @param {string} start */
export function discoverConfigPath(start = process.cwd()) {
  let dir = path.resolve(start);
  for (;;) {
    const candidate = path.join(dir, CONFIG_NAME);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null; // hit filesystem root
    dir = parent;
  }
}

/** Load a .env file into process.env without clobbering already-set vars. @param {string} file */
function loadEnv(file) {
  if (typeof process.loadEnvFile === "function" && fs.existsSync(file)) {
    try {
      process.loadEnvFile(file); // Node ≥ 20.12: does not overwrite existing vars
    } catch {
      /* malformed .env is non-fatal */
    }
  }
}

/** Recursively interpolate ${VAR} refs in every string of a JSON value.
 * Throws listing every unresolved var so misconfig fails loud, not silent.
 * @param {any} node @param {string[]} missing @param {string} pathLabel @returns {any} */
function interpolate(node, missing, pathLabel = "") {
  if (typeof node === "string") {
    return node.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name) => {
      const v = process.env[name];
      if (v == null || v === "") {
        missing.push(`${name} (at ${pathLabel || "<root>"})`);
        return "";
      }
      return v;
    });
  }
  if (Array.isArray(node)) return node.map((v, i) => interpolate(v, missing, `${pathLabel}[${i}]`));
  if (node && typeof node === "object") {
    /** @type {Record<string, any>} */
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = interpolate(v, missing, pathLabel ? `${pathLabel}.${k}` : k);
    return out;
  }
  return node;
}

/**
 * Resolve `repos` (multi-repo routing, src/repos.js) in place. No block → one synthesized
 * `default` repo at repoPath (single-repo, unchanged). A declared block is validated up
 * front — ids, paths and route keys must be unique, at most one default — and repoPath
 * becomes the default repo's path (else the first repo's, for the ops readers only).
 * @param {any} cfg @param {string} configDir
 */
function resolveRepos(cfg, configDir) {
  if (cfg.repos == null) {
    cfg.repos = [{ id: "default", path: cfg.repoPath, match: [], default: true }];
    cfg.multiRepo = false;
    return;
  }
  if (!Array.isArray(cfg.repos) || !cfg.repos.length) throw new Error(`config: "repos" must be a non-empty array.`);
  const ids = new Set();
  const paths = new Map();
  /** @type {Map<string, string>} route key → repo id */
  const keys = new Map();
  cfg.repos = cfg.repos.map((/** @type {any} */ r, /** @type {number} */ i) => {
    if (!r || typeof r !== "object") throw new Error(`config: repos[${i}] must be an object.`);
    if (typeof r.id !== "string" || !/^[A-Za-z0-9._-]+$/.test(r.id)) {
      throw new Error(`config: repos[${i}].id is required and must match [A-Za-z0-9._-]+ (got ${JSON.stringify(r.id)}).`);
    }
    if (ids.has(r.id)) throw new Error(`config: duplicate repos id "${r.id}".`);
    ids.add(r.id);
    if (typeof r.path !== "string" || !r.path) throw new Error(`config: repos "${r.id}" requires a "path".`);
    const p = path.resolve(resolvePath(r.path, configDir));
    if (paths.has(p)) throw new Error(`config: repos "${r.id}" and "${paths.get(p)}" share the path ${p}.`);
    paths.set(p, r.id);
    if (r.match != null && !Array.isArray(r.match)) throw new Error(`config: repos "${r.id}".match must be an array of strings.`);
    /** @type {string[]} */
    const match = [];
    for (const m of r.match ?? []) {
      if (typeof m !== "string" || !m.trim()) throw new Error(`config: repos "${r.id}".match entries must be non-empty strings (got ${JSON.stringify(m)}).`);
      const k = m.trim().toLowerCase();
      if (keys.has(k) && keys.get(k) !== r.id) throw new Error(`config: route key "${k}" is claimed by both repos "${keys.get(k)}" and "${r.id}".`);
      keys.set(k, r.id);
      if (!match.includes(k)) match.push(k);
    }
    if (r.default != null && typeof r.default !== "boolean") throw new Error(`config: repos "${r.id}".default must be a boolean.`);
    if (r.instructionsFile != null && typeof r.instructionsFile !== "string") throw new Error(`config: repos "${r.id}".instructionsFile must be a string.`);
    if (r.worktreePrefix != null && typeof r.worktreePrefix !== "string") throw new Error(`config: repos "${r.id}".worktreePrefix must be a string.`);
    return {
      id: r.id,
      path: p,
      match,
      ...(r.default ? { default: true } : {}),
      ...(r.instructionsFile ? { instructionsFile: resolvePath(r.instructionsFile, configDir) } : {}),
      ...(r.worktreePrefix ? { worktreePrefix: r.worktreePrefix } : {}),
    };
  });
  const defaults = cfg.repos.filter((/** @type {any} */ r) => r.default);
  if (defaults.length > 1) throw new Error(`config: at most one repo may set default:true (found ${defaults.map((/** @type {any} */ r) => r.id).join(", ")}).`);
  // A legacy repoPath alongside `repos` names the default when none is marked.
  if (cfg.repoPath && !defaults.length) {
    const hit = cfg.repos.find((/** @type {any} */ r) => r.path === path.resolve(cfg.repoPath));
    if (!hit) {
      throw new Error(`config: repoPath ${cfg.repoPath} is not one of the declared repos — mark one repo default:true, or point repoPath at a declared repo's path.`);
    }
    hit.default = true;
    defaults.push(hit);
  }
  cfg.repoPath = (defaults[0] ?? cfg.repos[0]).path;
  cfg.multiRepo = true;
}

/**
 * @param {{ configPath?: string }} [opts]
 * @returns {import('./types.js').Config}
 */
export function loadConfig(opts = {}) {
  const configPath = opts.configPath ? path.resolve(opts.configPath) : discoverConfigPath();
  if (!configPath || !fs.existsSync(configPath)) {
    throw new Error(
      `no ${CONFIG_NAME} found (looked up from ${process.cwd()}). ` +
        `Run \`agenthook init\` to create one, or pass --config <path>.`,
    );
  }
  const configDir = path.dirname(configPath);

  // Env precedence: shell-exported wins, then .env beside the config, then cwd .env.
  loadEnv(path.join(configDir, ".env"));
  if (path.resolve(process.cwd()) !== configDir) loadEnv(path.join(process.cwd(), ".env"));

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (e) {
    throw new Error(`could not parse ${configPath}: ${e.message}`);
  }

  /** @type {string[]} */
  const missing = [];
  const cfg = interpolate(raw, missing);
  if (missing.length) {
    throw new Error(`unset environment variable(s) referenced by ${configPath}:\n  - ` + missing.join("\n  - "));
  }

  if (!cfg.name || !/^[A-Za-z0-9._-]+$/.test(cfg.name)) {
    throw new Error(`config: "name" is required and must match [A-Za-z0-9._-]+ (it keys the state dir).`);
  }
  if (!cfg.tracker?.type) throw new Error(`config: "tracker.type" is required (e.g. "asana").`);
  if (!cfg.repoPath && cfg.repos == null) {
    throw new Error(`config: "repoPath" is required (the repo agents work in), unless a "repos" block declares them.`);
  }

  // --- the four locations, kept distinct ---
  cfg.installDir = installDir;
  cfg.configPath = configPath;
  cfg.configDir = configDir;
  if (cfg.repoPath) cfg.repoPath = resolvePath(cfg.repoPath, configDir);
  resolveRepos(cfg, configDir);

  const stateDir = path.join(registryDir, cfg.name);
  cfg.stateDir = stateDir;
  cfg.dataDir = stateDir;
  cfg.logDir = path.join(stateDir, "logs");
  cfg.publicUrlFile = path.join(stateDir, "public_url.txt");
  cfg.pidFile = path.join(stateDir, "server.pid");
  cfg.heartbeatFile = path.join(stateDir, "heartbeat.json");

  // instructionsFile defaults to one beside the config; resolve relative to it.
  cfg.instructionsFile = resolvePath(cfg.instructionsFile || "./INSTRUCTIONS.md", configDir);

  // --- defaults ---
  cfg.trigger = cfg.trigger || "@agent";
  cfg.maxConcurrent = cfg.maxConcurrent || 1;
  cfg.port = cfg.port || 4123;
  cfg.claudeBin = cfg.claudeBin || "claude";
  if (cfg.overlapGuard != null && typeof cfg.overlapGuard !== "boolean") {
    throw new Error(`config: "overlapGuard" must be true or false.`);
  }
  cfg.overlapGuard = cfg.overlapGuard === true;
  cfg.ingress = cfg.ingress || { type: "manual" };
  if (!cfg.ingress.type) cfg.ingress.type = "manual";

  // The active tracker's config block, mirrored to providerConfig so adapters
  // (which read cfg.providerConfig.token/userGid/…) stay unchanged. `type` carries
  // the adapter key; token/webhookSecret are already interpolated from env above.
  cfg.provider = cfg.tracker.type; // registry key
  cfg.providerConfig = cfg.tracker;

  // The pipeline is the execution model: an ordered list of steps, each bound to a
  // source section. Required. Resolve each step's instructionsFile against the config
  // dir and validate ids up front so a typo fails loud at load, not mid-dispatch.
  cfg.pipeline = Array.isArray(cfg.tracker.pipeline) && cfg.tracker.pipeline.length ? cfg.tracker.pipeline : null;
  if (!cfg.pipeline) {
    throw new Error(`config: "tracker.pipeline" is required (a non-empty array of steps).`);
  }
  const ids = new Set();
  for (const step of cfg.pipeline) {
    if (!step.id) throw new Error(`config: every pipeline step needs an "id".`);
    if (ids.has(step.id)) throw new Error(`config: duplicate pipeline step id "${step.id}".`);
    ids.add(step.id);
    if (step.instructionsFile) step.instructionsFile = resolvePath(step.instructionsFile, configDir);
    if (step.maxAttempts != null && (!Number.isInteger(step.maxAttempts) || step.maxAttempts < 1)) {
      throw new Error(`config: pipeline step "${step.id}" maxAttempts must be a positive integer.`);
    }
    if (step.lite != null) {
      const h = step.lite.descriptionHeadings;
      if (!Array.isArray(h) || !h.length || !h.every((x) => typeof x === "string" && x.trim())) {
        throw new Error(`config: pipeline step "${step.id}" lite.descriptionHeadings must be a non-empty array of strings.`);
      }
    }
    if (step.completeOnMerge && !step.manual) {
      throw new Error(`config: pipeline step "${step.id}" completeOnMerge requires manual:true (no agent runs on a merge).`);
    }
    // Queue stage (opt-in backlog lane the engine pulls from when a slot frees). A manual
    // step runs no agent, so it has nothing to pull into; a queue equal to the step's own
    // source would pull an item into the stage it already rests in (a self-loop).
    const queueKeys = /** @type {const} */ ([
      ["queueSectionGid", "sourceSectionGid"],
      ["queueStatus", "sourceStatus"],
      ["queueLabel", "sourceLabel"],
    ]);
    for (const [qk, sk] of queueKeys) {
      if (step[qk] == null) continue;
      if (step.manual) throw new Error(`config: pipeline step "${step.id}" ${qk} is not allowed on a manual step (no agent to pull into).`);
      if (step[sk] != null && String(step[qk]).trim().toLowerCase() === String(step[sk]).trim().toLowerCase()) {
        throw new Error(`config: pipeline step "${step.id}" ${qk} must differ from its own ${sk} (it would self-loop).`);
      }
    }
  }

  const onMerge = cfg.pipeline.filter((/** @type {import('./types.js').Step} */ s) => s.completeOnMerge);
  if (onMerge.length > 1) {
    throw new Error(`config: only one pipeline step may set completeOnMerge (found ${onMerge.map((/** @type {any} */ s) => s.id).join(", ")}).`);
  }

  if (cfg.sinks != null) {
    if (!Array.isArray(cfg.sinks)) throw new Error(`config: sinks must be an array.`);
    /** @type {Record<string, string[]>} */
    const need = { slack: ["url"], webhook: ["url"], telegram: ["botToken", "chatId"] };
    cfg.sinks.forEach((/** @type {any} */ s, /** @type {number} */ i) => {
      if (!s || !need[s.type]) {
        throw new Error(`config: sinks[${i}].type must be one of slack, telegram, webhook (got ${JSON.stringify(s?.type)}).`);
      }
      for (const f of need[s.type]) {
        if (s[f] == null || s[f] === "") throw new Error(`config: sinks[${i}] (${s.type}) requires "${f}".`);
      }
      if (s.events != null && (!Array.isArray(s.events) || s.events.some((/** @type {any} */ e) => typeof e !== "string"))) {
        throw new Error(`config: sinks[${i}].events must be an array of strings.`);
      }
    });
  }

  // Optional forge axis (PR awareness). Absent = undefined, nothing changes.
  if (cfg.forge && !cfg.forge.type) throw new Error(`config: "forge.type" is required when a forge block is set (e.g. "github").`);
  if (cfg.forge?.ciTarget != null) {
    const t = cfg.pipeline.find((/** @type {import('./types.js').Step} */ s) => s.id === cfg.forge.ciTarget);
    if (!t) throw new Error(`config: forge.ciTarget "${cfg.forge.ciTarget}" is not a pipeline step id.`);
    if (t.manual) throw new Error(`config: forge.ciTarget "${t.id}" is a manual step (a red-CI bounce needs an agent step).`);
  }

  fs.mkdirSync(cfg.stateDir, { recursive: true });
  fs.mkdirSync(cfg.logDir, { recursive: true });
  return cfg;
}
