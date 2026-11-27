// Profile load/resolve: locate and parse the raw config, resolve multi-repo routing, and turn
// the validated raw object into an absolute, secret-filled runtime Config.
import fs from "node:fs";
import path from "node:path";
import { controlSockPath } from "../paths.js";
import { AGENT_DEFAULT_BINS } from "../agents/names.js";
import { pricingErrors } from "../shared/pricing.js";
import { installDir, registryDir, DEFAULT_PORT, CONFIG_NAME, resolvePath, discoverConfigPath } from "./locations.js";
import { loadEnv, overlayDotEnv, interpolate } from "./env.js";
import { validName, NAME_ERROR, STATE_ID_ERROR } from "./validate/common.js";
import { validateRawConfig } from "./validate/index.js";

/** @param {any} name */
function assertName(name) {
  if (!validName(name)) throw new Error(NAME_ERROR);
}

/**
 * Resolve `repos` (multi-repo routing, src/repos.js) in place. No block → one synthesized
 * `default` repo at repoPath (single-repo, unchanged). A declared block has already passed
 * validateRawConfig's structural checks; this normalises it and runs the two checks that need
 * resolved paths — no two repos may share a path, and a legacy repoPath must name a declared
 * repo — then repoPath becomes the default repo's path (else the first repo's, for the ops
 * readers only).
 * @param {any} cfg @param {string} configDir
 */
function resolveRepos(cfg, configDir) {
  if (cfg.repos == null) {
    cfg.repos = [{ id: "default", path: cfg.repoPath, match: [], default: true }];
    cfg.multiRepo = false;
    return;
  }
  const paths = new Map();
  cfg.repos = cfg.repos.map((/** @type {any} */ r) => {
    const p = path.resolve(resolvePath(r.path, configDir));
    if (paths.has(p)) throw new Error(`config: repos "${r.id}" and "${paths.get(p)}" share the path ${p}.`);
    paths.set(p, r.id);
    /** @type {string[]} */
    const match = [];
    for (const m of r.match ?? []) {
      const k = m.trim().toLowerCase();
      if (!match.includes(k)) match.push(k);
    }
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

/** Locate the config (explicit path or cwd discovery) and parse its JSON as-is: no env
 * interpolation, no validation beyond "it parses". Shared by loadConfig and peekConfig.
 * @param {string|undefined} explicit @returns {{ configPath: string, configDir: string, raw: any }} */
function readRawConfig(explicit) {
  const configPath = explicit ? path.resolve(explicit) : discoverConfigPath();
  if (!configPath || !fs.existsSync(configPath)) {
    throw new Error(
      `no ${CONFIG_NAME} found (looked up from ${process.cwd()}). ` +
        `Run \`agenthook init\` to create one, or pass --config <path>.`,
    );
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (e) {
    throw new Error(`could not parse ${configPath}: ${e.message}`);
  }
  return { configPath, configDir: path.dirname(configPath), raw };
}

/**
 * The profile's identity and state-dir paths WITHOUT resolving secrets. For read-only
 * commands (`agents`, `status`) that only need to know which ~/.agenthook/<name> to read:
 * they must work from any checkout, including one where the `${VAR}` refs in the config
 * (forge/tracker tokens) are unset — a worktree without a .env, a CI box, a teammate's
 * shell. loadConfig would throw "unset environment variable(s)" there, which read as a
 * daemon outage with zero agents. Validates only that the file exists, parses, and names
 * a profile; everything else stays loadConfig's job.
 * @param {{ configPath?: string }} [opts]
 * `agentBins` = the agent binaries the file names (see `rawAgentBins`), for `agents`' ps match.
 * `pricing` = the file's valid `pricing` block (src/shared/pricing.js), for `status` with the receiver down.
 * @returns {{ name: string, stateKey: string, configPath: string, configDir: string, stateDir: string, logDir: string, agentBins: string[], pricing?: Record<string, import('../shared/pricing.js').Rate> }}
 */
export function peekConfig(opts = {}) {
  const { configPath, configDir, raw } = readRawConfig(opts.configPath);
  const name = raw?.name;
  assertName(name);
  if (raw.stateId !== undefined && !validName(raw.stateId)) throw new Error(STATE_ID_ERROR);
  const stateKey = raw.stateId ?? name;
  const stateDir = path.join(registryDir, stateKey);
  // `pricing` holds no secrets or ${VAR}s; an invalid block is dropped (`status` falls back to the built-in rates).
  const pricing = raw.pricing != null && !pricingErrors(raw.pricing).length ? raw.pricing : undefined;
  return { name, stateKey, configPath, configDir, stateDir, logDir: path.join(stateDir, "logs"), agentBins: rawAgentBins(raw), pricing };
}

/**
 * The distinct agent binaries a raw (uninterpolated) config names: `claudeBin` (default
 * "claude"), every pipeline step's and harness's `bin`, and the default bin (AGENT_DEFAULT_BINS)
 * of every agent the profile, a step or a harness names. Literal values only — a `${VAR}` ref is unresolved
 * here, so it is skipped (and the default "claude" kept). Pure.
 * @param {any} raw @returns {string[]}
 */
export function rawAgentBins(raw) {
  const literal = (/** @type {any} */ v) => typeof v === "string" && v.trim() !== "" && !v.includes("${");
  const bins = new Set([literal(raw?.claudeBin) ? raw.claudeBin.trim() : "claude"]);
  const addAgent = (/** @type {any} */ a) => {
    if (literal(a) && Object.hasOwn(AGENT_DEFAULT_BINS, a)) bins.add(AGENT_DEFAULT_BINS[/** @type {keyof typeof AGENT_DEFAULT_BINS} */ (a)]);
  };
  addAgent(raw?.agent);
  const pipeline = raw?.tracker?.pipeline;
  if (Array.isArray(pipeline)) {
    for (const s of pipeline) {
      if (literal(s?.bin)) bins.add(s.bin.trim());
      addAgent(s?.agent);
    }
  }
  if (raw?.harnesses && typeof raw.harnesses === "object") {
    for (const h of Object.values(raw.harnesses)) {
      if (literal(h?.bin)) bins.add(h.bin.trim());
      addAgent(h?.agent);
    }
  }
  return [...bins];
}

/**
 * @param {{ configPath?: string, env?: NodeJS.ProcessEnv }} [opts]
 * `opts.env` (optional): validate against THIS env instead of process.env — `loadEnv` is
 * skipped and the `.env` files are re-read into a local copy (same precedence), so neither
 * process.env nor fileEnvKeys is touched. The restart preflight passes `respawnEnv()` so the
 * check reflects the fresh process the respawn will become.
 * @returns {import('../types.js').Config}
 */
export function loadConfig(opts = {}) {
  const { configPath, configDir } = readRawConfig(opts.configPath);

  // Env precedence: shell-exported wins, then .env beside the config, then cwd .env.
  // (Read the file again AFTER the .env load so a ${VAR} satisfied by that .env resolves.)
  /** @type {NodeJS.ProcessEnv | undefined} */
  let env;
  if (opts.env != null) {
    // `opts.env` = the env a detached respawn will see (typically `respawnEnv()`), already
    // minus file-sourced keys: rebuild the same precedence from the .env files WITHOUT
    // touching process.env or fileEnvKeys — the check must reflect the fresh boot, not the
    // stale file values this process still holds in memory (a key removed from .env can
    // only be seen as removed by re-reading the file).
    env = { ...opts.env };
    overlayDotEnv(env, path.join(configDir, ".env"));
    if (path.resolve(process.cwd()) !== configDir) overlayDotEnv(env, path.join(process.cwd(), ".env"));
  } else {
    loadEnv(path.join(configDir, ".env"));
    if (path.resolve(process.cwd()) !== configDir) loadEnv(path.join(process.cwd(), ".env"));
  }
  const { raw } = readRawConfig(configPath);

  /** @type {string[]} */
  const missing = [];
  const cfg = interpolate(raw, missing, "", env);
  if (missing.length) {
    throw new Error(`unset environment variable(s) referenced by ${configPath}:\n  - ` + missing.join("\n  - "));
  }

  const v = validateRawConfig(cfg);
  if (!v.ok) throw new Error(v.errors[0]);

  // --- the four locations, kept distinct ---
  cfg.installDir = installDir;
  cfg.configPath = configPath;
  cfg.configDir = configDir;
  if (cfg.repoPath) cfg.repoPath = resolvePath(cfg.repoPath, configDir);
  resolveRepos(cfg, configDir);

  // stateId (optional) keys the state dir so `name` can be relabelled without moving state.
  cfg.stateKey = cfg.stateId ?? cfg.name;
  const stateDir = path.join(registryDir, cfg.stateKey);
  cfg.stateDir = stateDir;
  cfg.dataDir = stateDir;
  cfg.logDir = path.join(stateDir, "logs");
  cfg.publicUrlFile = path.join(stateDir, "public_url.txt");
  cfg.pidFile = path.join(stateDir, "server.pid");
  cfg.heartbeatFile = path.join(stateDir, "heartbeat.json");
  cfg.controlSock = controlSockPath(stateDir, cfg.stateKey);

  // instructionsFile defaults to one beside the config; resolve relative to it.
  cfg.instructionsFile = resolvePath(cfg.instructionsFile || "./INSTRUCTIONS.md", configDir);

  // The Digest's SOUL file defaults to one beside the config, like instructionsFile.
  cfg.digest = { ...(cfg.digest && typeof cfg.digest === "object" ? cfg.digest : {}), soul: resolvePath(cfg.digest?.soul || "./SOUL.md", configDir) };

  // --- defaults ---
  cfg.trigger = cfg.trigger || "@agent";
  cfg.maxConcurrent = cfg.maxConcurrent || 1;
  cfg.port = cfg.port || DEFAULT_PORT;
  cfg.claudeBin = cfg.claudeBin || "claude";
  cfg.overlapGuard = cfg.overlapGuard === true;
  cfg.ingress = cfg.ingress || { type: "manual" };
  if (!cfg.ingress.type) cfg.ingress.type = "manual";

  // GitHub App auth: a privateKeyPath is read (relative to the config file) into privateKey,
  // so src/github/auth.js only ever sees the PEM.
  for (const [at, block] of /** @type {const} */ ([["tracker.auth", cfg.tracker], ["forge.auth", cfg.forge]])) {
    const auth = block?.auth;
    if (auth?.type !== "app" || !auth.privateKeyPath) continue;
    auth.privateKeyPath = resolvePath(auth.privateKeyPath, configDir);
    try {
      auth.privateKey = fs.readFileSync(auth.privateKeyPath, "utf8");
    } catch (e) {
      throw new Error(`config: cannot read "${at}.privateKeyPath" ${auth.privateKeyPath}: ${e.message}`);
    }
  }

  // The active tracker's config block, mirrored to providerConfig so adapters
  // (which read cfg.providerConfig.token/userGid/…) stay unchanged. `type` carries
  // the adapter key; token/webhookSecret are already interpolated from env above.
  cfg.provider = cfg.tracker.type; // registry key
  cfg.providerConfig = cfg.tracker;

  // The pipeline is the execution model: an ordered list of steps, each bound to a
  // source section (validated above). Resolve each step's instructionsFile against the
  // config dir.
  cfg.pipeline = cfg.tracker.pipeline;
  for (const step of cfg.pipeline) {
    if (step.instructionsFile) step.instructionsFile = resolvePath(step.instructionsFile, configDir);
    if (step.opencodeConfig) step.opencodeConfig = resolvePath(step.opencodeConfig, configDir);
    if (step.piConfigDir) step.piConfigDir = resolvePath(step.piConfigDir, configDir);
  }

  // A harness's opencodeConfig/piConfigDir is sandbox-only, like a step's own; resolve it the same way.
  for (const h of Object.values(cfg.harnesses ?? {})) {
    if (h.opencodeConfig) h.opencodeConfig = resolvePath(h.opencodeConfig, configDir);
    if (h.piConfigDir) h.piConfigDir = resolvePath(h.piConfigDir, configDir);
  }

  return cfg;
}
