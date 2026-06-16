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
  if (!cfg.repoPath) throw new Error(`config: "repoPath" is required (the repo agents work in).`);

  // --- the four locations, kept distinct ---
  cfg.installDir = installDir;
  cfg.configPath = configPath;
  cfg.configDir = configDir;
  cfg.repoPath = resolvePath(cfg.repoPath, configDir);

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
  }

  fs.mkdirSync(cfg.stateDir, { recursive: true });
  fs.mkdirSync(cfg.logDir, { recursive: true });
  return cfg;
}
