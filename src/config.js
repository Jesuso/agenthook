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
//     the config dir, the central state dir (~/.agenthook/<stateKey>), and the target repo.
//   - Runtime state is central and keyed by the profile's state key (`stateId`, else `name`), so a global
//     `agenthook ls` can see every profile without spelunking project dirs.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { controlSockPath } from "./paths.js";
import { identityErrors } from "./identity.js";
import { digestErrors } from "./digest-config.js";
import { pricingErrors } from "./pricing.js";
import { energyErrors } from "./energy.js";
import { quotaErrors } from "./quota.js";
import { sinkErrors } from "./sinks-config.js";
import { reposErrors } from "./repos-config.js";
import { AGENT_NAMES, AGENT_DEFAULT_BINS } from "./agents/names.js";
import { SANDBOX_NAMES, EGRESS_MODES, EGRESS_PROXY_ENV_KEYS } from "./sandbox/names.js";
import { egressEntryProblem } from "./sandbox/egress.js";
import { SECRET_FIELDS, isEnvRef } from "./ui/sensitive.js";

// The installed package root (this file is src/config.js). Used only to read
// bundled templates — never for runtime state.
export const installDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Where all profiles keep their runtime state, one subdir per profile name.
// AGENTHOOK_HOME overrides the root (tests use it to stay out of the real ~/.agenthook).
export const registryDir = process.env.AGENTHOOK_HOME
  ? path.resolve(process.env.AGENTHOOK_HOME)
  : path.join(os.homedir(), ".agenthook");

// A config with no `port` binds here. `claimedPorts` (port.js) assumes the same default
// for a registered profile whose config omits the key.
export const DEFAULT_PORT = 4123;

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
export function loadEnv(file) {
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

const NAME_ERROR = `config: "name" is required and must match [A-Za-z0-9._-]+ (it keys the state dir).`;

/** @param {any} name */
export function validName(name) {
  return !!name && typeof name === "string" && /^[A-Za-z0-9._-]+$/.test(name);
}

/** @param {any} name */
function assertName(name) {
  if (!validName(name)) throw new Error(NAME_ERROR);
}

const STATE_ID_ERROR = `config: "stateId" must match [A-Za-z0-9._-]+ (it keys the state dir; omit it to key by "name").`;

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
 * `pricing` = the file's valid `pricing` block (src/pricing.js), for `status` with the receiver down.
 * @returns {{ name: string, stateKey: string, configPath: string, configDir: string, stateDir: string, logDir: string, agentBins: string[], pricing?: Record<string, import('./pricing.js').Rate> }}
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
 * "claude"), every pipeline step's `bin`, and the default bin (AGENT_DEFAULT_BINS) of every
 * agent the profile or a step names. Literal values only — a `${VAR}` ref is unresolved
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
  return [...bins];
}

/**
 * @param {{ configPath?: string }} [opts]
 * @returns {import('./types.js').Config}
 */
export function loadConfig(opts = {}) {
  const { configPath, configDir } = readRawConfig(opts.configPath);

  // Env precedence: shell-exported wins, then .env beside the config, then cwd .env.
  // (Read the file again AFTER the .env load so a ${VAR} satisfied by that .env resolves.)
  loadEnv(path.join(configDir, ".env"));
  if (path.resolve(process.cwd()) !== configDir) loadEnv(path.join(process.cwd(), ".env"));
  const { raw } = readRawConfig(configPath);

  /** @type {string[]} */
  const missing = [];
  const cfg = interpolate(raw, missing);
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
  // so src/github-auth.js only ever sees the PEM.
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
  }

  return cfg;
}

/**
 * Ensure `dir` exists, private. A newly created dir is always born 0700 (POSIX);
 * the parent is created first, without a mode, so `recursive` mkdir doesn't also
 * stamp 0700 onto a freshly created `~/.agenthook` or other ancestor.
 *
 * An already-existing dir's mode is only checked/tightened when `tighten` is set
 * (the boot path, which runs once). loadConfig creates nothing — only real writers
 * (claimStateDir on boot, spawnDetached, rename, …) call this, create-only unless booting.
 * @param {string} dir
 * @param {{tighten?: boolean}} [opts]
 * @returns {{tightened: true, from: number} | {tightened: false}}
 */
export function ensurePrivateDir(dir, { tighten = false } = {}) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    fs.mkdirSync(dir, process.platform === "win32" ? undefined : { mode: 0o700 });
    return { tightened: false };
  }
  if (process.platform === "win32" || !tighten) return { tightened: false };
  const from = fs.statSync(dir).mode & 0o777;
  if ((from & 0o077) !== 0) {
    fs.chmodSync(dir, 0o700);
    return { tightened: true, from };
  }
  return { tightened: false };
}

/** Per-step queue-stage keys, each paired with the source key it must not equal. */
const QUEUE_KEYS = /** @type {const} */ ([
  ["queueSectionGid", "sourceSectionGid"],
  ["queueStatus", "sourceStatus"],
  ["queueLabel", "sourceLabel"],
]);

/** A step `env` key: a portable shell variable name. */
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
// An agentEnvPassthrough entry: a variable name, optionally a PREFIX* (src/agent-env.js).
const ENV_PATTERN_RE = /^[A-Za-z_][A-Za-z0-9_]*\*?$/;

/**
 * `${v}` for a user-supplied value rendered into a message — but an object whose toString is
 * not callable (e.g. `{"toString":1}`) makes String() throw, so fall back to its JSON (a JSON
 * value always stringifies). Identical to `${v}` for every value that doesn't throw.
 * @param {any} v
 */
function label(v) {
  try {
    return String(v);
  } catch {
    return JSON.stringify(v);
  }
}

/** @param {unknown} v @returns {boolean} */
const isAgentName = (v) => typeof v === "string" && /** @type {readonly string[]} */ (AGENT_NAMES).includes(v);

/**
 * Structural validation of a config object WITHOUT resolving it: pure (no fs, no env, no
 * path resolution), never throws for any JSON value, and collects every error in check
 * order rather than stopping at the first. `${VAR}` strings are opaque values. loadConfig
 * runs it on the interpolated config and throws `errors[0]`; the UI config editor runs it
 * on the raw file (secrets never leave the env). The two checks that need resolved paths —
 * repos sharing a path, a repoPath matching no declared repo — stay in resolveRepos.
 * @param {any} raw
 * @returns {{ ok: true } | { ok: false, errors: string[] }}
 */
export function validateRawConfig(raw) {
  /** @type {string[]} */
  const errors = [];
  // Only a null/undefined root would crash the property reads below; any other non-object
  // simply fails the named-key checks (as loadConfig always has).
  if (raw == null) return { ok: false, errors: [`config: the config must be a JSON object.`] };
  const cfg = raw;

  if (!validName(cfg.name)) errors.push(NAME_ERROR);
  if (cfg.stateId !== undefined && !validName(cfg.stateId)) errors.push(STATE_ID_ERROR);
  const tracker = cfg.tracker;
  if (!tracker?.type) errors.push(`config: "tracker.type" is required (e.g. "asana").`);
  if (!cfg.repoPath && cfg.repos == null) {
    errors.push(`config: "repoPath" is required (the repo agents work in), unless a "repos" block declares them.`);
  }

  errors.push(...reposErrors(cfg.repos));

  if (cfg.agent != null && !isAgentName(cfg.agent)) {
    errors.push(`config: "agent" ${JSON.stringify(cfg.agent)} is not a known agent (${AGENT_NAMES.join(", ")}).`);
  }

  if (cfg.agentProvider != null && (typeof cfg.agentProvider !== "string" || !cfg.agentProvider.trim())) {
    errors.push(`config: "agentProvider" must be a non-empty string.`);
  }

  if (cfg.agentEnvPassthrough != null) {
    if (!Array.isArray(cfg.agentEnvPassthrough)) errors.push(`config: "agentEnvPassthrough" must be an array of variable names, PREFIX*, or "*".`);
    else {
      for (const n of cfg.agentEnvPassthrough) {
        if (n !== "*" && (typeof n !== "string" || !ENV_PATTERN_RE.test(n))) errors.push(`config: "agentEnvPassthrough" entry ${JSON.stringify(n)} must be a variable name, a PREFIX*, or "*".`);
      }
    }
  }

  if (cfg.githubRunToken != null && typeof cfg.githubRunToken !== "boolean") {
    errors.push(`config: "githubRunToken" must be true or false.`);
  }

  if (cfg.overlapGuard != null && typeof cfg.overlapGuard !== "boolean") {
    errors.push(`config: "overlapGuard" must be true or false.`);
  }

  const pipeline = Array.isArray(tracker?.pipeline) && tracker.pipeline.length ? tracker.pipeline : null;
  if (!pipeline) {
    errors.push(`config: "tracker.pipeline" is required (a non-empty array of steps).`);
  }
  const ids = new Set();
  (pipeline ?? []).forEach((/** @type {any} */ step, /** @type {number} */ i) => {
    if (!step || typeof step !== "object") return void errors.push(`config: tracker.pipeline[${i}] must be an object.`);
    const sid = label(step.id);
    if (!step.id) errors.push(`config: every pipeline step needs an "id".`);
    else if (ids.has(step.id)) errors.push(`config: duplicate pipeline step id "${sid}".`);
    ids.add(step.id);
    if (step.maxAttempts != null && (!Number.isInteger(step.maxAttempts) || step.maxAttempts < 1)) {
      errors.push(`config: pipeline step "${sid}" maxAttempts must be a positive integer.`);
    }
    if (step.maxConcurrent != null) {
      if (!Number.isInteger(step.maxConcurrent) || step.maxConcurrent < 1) {
        errors.push(`config: pipeline step "${sid}" maxConcurrent must be a positive integer.`);
      } else if (step.manual) {
        errors.push(`config: pipeline step "${sid}" maxConcurrent has no effect on a manual step (no agent runs).`);
      }
    }
    if (step.maxMinutes != null && (typeof step.maxMinutes !== "number" || !Number.isFinite(step.maxMinutes) || step.maxMinutes < 0)) {
      errors.push(`config: pipeline step "${sid}" maxMinutes must be a number >= 0 (0 disables the cap).`);
    }
    if (step.idleMinutes != null && (typeof step.idleMinutes !== "number" || !Number.isFinite(step.idleMinutes) || step.idleMinutes <= 0)) {
      errors.push(`config: pipeline step "${sid}" idleMinutes must be a number > 0.`);
    }
    if (step.agent != null) {
      if (!isAgentName(step.agent)) {
        errors.push(`config: pipeline step "${sid}" agent ${JSON.stringify(step.agent)} is not a known agent (${AGENT_NAMES.join(", ")}).`);
      } else if (step.manual) {
        errors.push(`config: pipeline step "${sid}" agent has no effect on a manual step (no agent runs).`);
      }
    }
    if (step.bin != null && (typeof step.bin !== "string" || !step.bin.trim())) {
      errors.push(`config: pipeline step "${sid}" bin must be a non-empty string (a name on PATH or an absolute path).`);
    }
    if (step.provider != null) {
      if (typeof step.provider !== "string" || !step.provider.trim()) {
        errors.push(`config: pipeline step "${sid}" provider must be a non-empty string.`);
      } else if (step.manual) {
        errors.push(`config: pipeline step "${sid}" provider has no effect on a manual step (no agent runs).`);
      }
    }
    if (step.toolsets != null) {
      if (!Array.isArray(step.toolsets) || !step.toolsets.length || step.toolsets.some((/** @type {unknown} */ t) => typeof t !== "string" || !t.trim())) {
        errors.push(`config: pipeline step "${sid}" toolsets must be a non-empty array of non-empty strings.`);
      } else if (step.manual) {
        errors.push(`config: pipeline step "${sid}" toolsets has no effect on a manual step (no agent runs).`);
      }
    }
    for (const key of /** @type {const} */ (["allow", "deny"])) {
      if (step[key] == null) continue;
      if (step.manual) {
        errors.push(`config: pipeline step "${sid}" ${key} has no effect on a manual step (no agent runs).`);
        continue;
      }
      errors.push(...policyErrors(step[key], `config: pipeline step "${sid}" ${key}`));
    }
    if (step.isolated != null) {
      if (typeof step.isolated !== "boolean") {
        errors.push(`config: pipeline step "${sid}" isolated must be true or false.`);
      } else if (step.manual) {
        errors.push(`config: pipeline step "${sid}" isolated has no effect on a manual step (no agent runs).`);
      }
    }
    if (step.energy != null) {
      if (typeof step.energy !== "boolean") {
        errors.push(`config: pipeline step "${sid}" energy must be true or false.`);
      } else if (step.manual) {
        errors.push(`config: pipeline step "${sid}" energy has no effect on a manual step (no agent runs).`);
      } else if (step.energy && cfg.energy == null) {
        errors.push(`config: pipeline step "${sid}" energy:true needs a profile "energy" block ({usdPerKwh, source}).`);
      }
    }
    if (step.sandbox != null) {
      if (typeof step.sandbox !== "boolean") {
        errors.push(`config: pipeline step "${sid}" sandbox must be true or false.`);
      } else if (step.manual) {
        errors.push(`config: pipeline step "${sid}" sandbox has no effect on a manual step (no agent runs).`);
      }
    }
    if (step.egress != null) {
      if (step.manual) errors.push(`config: pipeline step "${sid}" egress has no effect on a manual step (no agent runs).`);
      else if (step.sandbox === false) errors.push(`config: pipeline step "${sid}" egress has no effect: the step runs on the host ("sandbox": false).`);
      else if (cfg.sandbox == null) errors.push(`config: pipeline step "${sid}" egress needs a profile "sandbox" (egress is enforced by the sandbox's network).`);
      errors.push(...egressErrors(step.egress, `pipeline step "${sid}" egress`));
    }
    if (step.services != null) {
      const list = step.services;
      if (!Array.isArray(list) || list.some((/** @type {unknown} */ n) => typeof n !== "string")) errors.push(`config: pipeline step "${sid}" services must be a list of sandbox.services names.`);
      else if (step.manual) errors.push(`config: pipeline step "${sid}" services has no effect on a manual step (no agent runs).`);
      else if (step.sandbox === false) errors.push(`config: pipeline step "${sid}" services needs the sandbox: the step runs on the host ("sandbox": false).`);
      else if (cfg.sandbox == null) errors.push(`config: pipeline step "${sid}" services needs a profile "sandbox" (services run beside the sandboxed agent).`);
      else {
        if (list.length > MAX_STEP_SERVICES) errors.push(`config: pipeline step "${sid}" services lists ${list.length} services (at most ${MAX_STEP_SERVICES}).`);
        const catalog = cfg.sandbox.services;
        for (const [i, n] of list.entries()) {
          if (list.indexOf(n) !== i) errors.push(`config: pipeline step "${sid}" services lists ${JSON.stringify(n)} twice.`);
          else if (!catalog || typeof catalog !== "object" || !Object.hasOwn(catalog, n)) errors.push(`config: pipeline step "${sid}" services ${JSON.stringify(n)} is not in sandbox.services.`);
        }
      }
    }
    if (step.env != null) {
      if (typeof step.env !== "object" || Array.isArray(step.env)) {
        errors.push(`config: pipeline step "${sid}" env must be an object of NAME: "value" strings.`);
      } else {
        for (const [k, v] of Object.entries(step.env)) {
          if (!ENV_KEY_RE.test(k)) errors.push(`config: pipeline step "${sid}" env key ${JSON.stringify(k)} is not a valid variable name.`);
          else if (k === "AGENTHOOK_VERDICT_FILE") errors.push(`config: pipeline step "${sid}" env key AGENTHOOK_VERDICT_FILE is reserved (the receiver sets it).`);
          if (typeof v !== "string") errors.push(`config: pipeline step "${sid}" env.${k} must be a string.`);
        }
      }
    }
    if (step.lite != null) {
      const h = step.lite.descriptionHeadings;
      if (!Array.isArray(h) || !h.length || !h.every((x) => typeof x === "string" && x.trim())) {
        errors.push(`config: pipeline step "${sid}" lite.descriptionHeadings must be a non-empty array of strings.`);
      }
    }
    if (step.completeOnMerge && !step.manual) {
      errors.push(`config: pipeline step "${sid}" completeOnMerge requires manual:true (no agent runs on a merge).`);
    }
    if (step.requireVerdict != null) {
      if (typeof step.requireVerdict !== "boolean") {
        errors.push(`config: pipeline step "${sid}" requireVerdict must be a boolean.`);
      } else if (step.manual) {
        errors.push(`config: pipeline step "${sid}" requireVerdict has no effect on a manual step (no agent runs).`);
      }
    }
    // Queue stage (opt-in backlog lane the engine pulls from when a slot frees). A manual
    // step runs no agent, so it has nothing to pull into; a queue equal to the step's own
    // source would pull an item into the stage it already rests in (a self-loop).
    for (const [qk, sk] of QUEUE_KEYS) {
      if (step[qk] == null) continue;
      if (step.manual) errors.push(`config: pipeline step "${sid}" ${qk} is not allowed on a manual step (no agent to pull into).`);
      else if (step[sk] != null && label(step[qk]).trim().toLowerCase() === label(step[sk]).trim().toLowerCase()) {
        errors.push(`config: pipeline step "${sid}" ${qk} must differ from its own ${sk} (it would self-loop).`);
      }
    }
  });

  const onMerge = (pipeline ?? []).filter((/** @type {any} */ s) => s && typeof s === "object" && s.completeOnMerge);
  if (onMerge.length > 1) {
    errors.push(`config: only one pipeline step may set completeOnMerge (found ${onMerge.map((/** @type {any} */ s) => label(s.id)).join(", ")}).`);
  }

  errors.push(...sinkErrors(cfg.sinks));
  errors.push(...identityErrors(cfg.ui));
  errors.push(...digestErrors(cfg.digest));
  errors.push(...pricingErrors(cfg.pricing));
  errors.push(...energyErrors(cfg.energy));
  errors.push(...quotaErrors(cfg.quota));
  errors.push(...sandboxErrors(cfg.sandbox));

  // GitHub App auth (src/github-auth.js). Under it the identity can't be derived from the token
  // (an installation token is the App's bot), so the tracker's assigneeLogin is required —
  // fail closed rather than fall back to /user or `viewer`.
  if (tracker?.auth != null) {
    if (tracker.type !== "github" && tracker.type !== "github-projects") errors.push(`config: "tracker.auth" is only supported on the github and github-projects trackers.`);
    else {
      errors.push(...githubAuthErrors(tracker.auth, "tracker.auth"));
      const login = tracker.assigneeLogin;
      if (tracker.auth?.type === "app" && (typeof login !== "string" || !login.trim())) {
        errors.push(`config: GitHub App auth needs "tracker.assigneeLogin" — the human login the App acts for (scoping and the @agent author check use it; it is never derived from the App token).`);
      }
    }
  }
  if (cfg.forge?.auth != null) {
    if (cfg.forge.type !== "github") errors.push(`config: "forge.auth" is only supported on the github forge.`);
    else errors.push(...githubAuthErrors(cfg.forge.auth, "forge.auth"));
  }

  // Optional forge axis (PR awareness). Absent = undefined, nothing changes.
  if (cfg.forge && !cfg.forge.type) errors.push(`config: "forge.type" is required when a forge block is set (e.g. "github").`);
  // No ciTarget lookup against a missing pipeline: that would only add a spurious "not a step id".
  if (cfg.forge?.ciTarget != null && pipeline) {
    const t = pipeline.find((/** @type {any} */ s) => s && typeof s === "object" && s.id === cfg.forge.ciTarget);
    if (!t) errors.push(`config: forge.ciTarget "${label(cfg.forge.ciTarget)}" is not a pipeline step id.`);
    else if (t.manual) errors.push(`config: forge.ciTarget "${label(t.id)}" is a manual step (a red-CI bounce needs an agent step).`);
  }

  return errors.length ? { ok: false, errors } : { ok: true };
}

/**
 * Structural errors in the optional `sandbox` block (src/sandbox/). Pure.
 * @param {any} sb @returns {string[]}
 */
function sandboxErrors(sb) {
  if (sb == null) return [];
  if (typeof sb !== "object" || Array.isArray(sb)) return [`config: "sandbox" must be an object ({ "type": "docker" | "podman", … }).`];
  /** @type {string[]} */
  const errors = [];
  if (sb.type == null || sb.type === "") errors.push(`config: "sandbox.type" is required when a sandbox block is set (${SANDBOX_NAMES.join(" or ")}).`);
  else if (!(/** @type {readonly unknown[]} */ (SANDBOX_NAMES).includes(sb.type))) errors.push(`config: "sandbox.type" ${JSON.stringify(sb.type)} is not a known sandbox (${SANDBOX_NAMES.join(", ")}).`);
  if (sb.image != null && (typeof sb.image !== "string" || !sb.image.trim())) errors.push(`config: "sandbox.image" must be a non-empty string.`);
  if (sb.memory != null && (typeof sb.memory !== "string" || !/^\d+[kmg]?$/i.test(sb.memory))) errors.push(`config: "sandbox.memory" must be a size like "4g", "512m" or bytes.`);
  if (sb.cpus != null && (typeof sb.cpus !== "number" || !Number.isFinite(sb.cpus) || sb.cpus <= 0)) errors.push(`config: "sandbox.cpus" must be a number > 0.`);
  if (sb.egress != null) errors.push(...egressErrors(sb.egress, `"sandbox.egress"`));
  if (sb.services != null) {
    if (typeof sb.services !== "object" || Array.isArray(sb.services)) errors.push(`config: "sandbox.services" must be an object of name: { "image", … }.`);
    else for (const [name, svc] of Object.entries(sb.services)) errors.push(...serviceErrors(name, svc));
  }
  return errors;
}

/** A Service name: a DNS label, the hostname the agent reaches it at. */
const SERVICE_NAME_RE = /^[a-z][a-z0-9-]{0,30}$/;

/** Service env names the runtime CLI itself reads: service env values pass by name through the
 * client's own env, so these would redirect or reconfigure the docker/podman call. */
const RUNTIME_CLIENT_ENV_RE = /^(PATH|HOME|TMPDIR|SHELL|(DOCKER|CONTAINER|CONTAINERS|PODMAN|XDG|LD|DYLD)_.*)$/;

/** The most services one step may use. */
const MAX_STEP_SERVICES = 8;

/**
 * Why an image reference doesn't pin a version (a bare name or `:latest`), or undefined. A
 * registry port (`host:5000/img`) is not a tag. Pure. @param {string} ref @returns {string|undefined}
 */
function unpinnedImage(ref) {
  if (/@[a-z0-9]+:[A-Fa-f0-9]+$/.test(ref)) return undefined;
  const last = ref.slice(ref.lastIndexOf("/") + 1);
  const i = last.lastIndexOf(":");
  if (i < 0 || i === last.length - 1) return "has no tag";
  if (last.slice(i + 1) === "latest") return "is :latest";
  return undefined;
}

/**
 * Structural errors in one `sandbox.services.<name>` entry (src/sandbox/container.js). Pure.
 * @param {string} name @param {any} svc @returns {string[]}
 */
function serviceErrors(name, svc) {
  const at = `"sandbox.services.${name}"`;
  /** @type {string[]} */
  const errors = [];
  if (!SERVICE_NAME_RE.test(name)) errors.push(`config: sandbox service name ${JSON.stringify(name)} must be a DNS label (a-z, 0-9, -; starts with a letter; at most 31 chars).`);
  else if (name === "proxy") errors.push(`config: sandbox service name "proxy" is reserved (the egress proxy).`);
  if (typeof svc !== "object" || svc === null || Array.isArray(svc)) return [...errors, `config: ${at} must be an object ({ "image", … }).`];
  if (typeof svc.image !== "string" || !svc.image.trim()) errors.push(`config: ${at} image is required (a non-empty string with an explicit tag or digest).`);
  else {
    const why = unpinnedImage(svc.image);
    if (why) errors.push(`config: ${at} image ${JSON.stringify(svc.image)} ${why} — pin a tag or digest (e.g. "postgres:16.4"); service images are never pulled.`);
  }
  for (const key of ["env", "agentEnv"]) {
    const env = svc[key];
    if (env == null) continue;
    if (typeof env !== "object" || Array.isArray(env)) {
      errors.push(`config: ${at} ${key} must be an object of NAME: "value" strings.`);
      continue;
    }
    for (const [k, v] of Object.entries(env)) {
      if (!ENV_KEY_RE.test(k)) errors.push(`config: ${at} ${key} key ${JSON.stringify(k)} is not a valid variable name.`);
      else if (key === "agentEnv" && k === "AGENTHOOK_VERDICT_FILE") errors.push(`config: ${at} agentEnv key AGENTHOOK_VERDICT_FILE is reserved (the receiver sets it).`);
      else if (key === "agentEnv" && /** @type {readonly string[]} */ (EGRESS_PROXY_ENV_KEYS).includes(k)) errors.push(`config: ${at} agentEnv key ${k} is reserved (the sandbox's egress proxy sets it).`);
      else if (key === "env" && RUNTIME_CLIENT_ENV_RE.test(k)) errors.push(`config: ${at} env key ${k} is reserved: service env reaches the docker/podman client that starts the service, and ${k} would reconfigure it.`);
      if (typeof v !== "string") errors.push(`config: ${at} ${key}.${k} must be a literal string.`);
    }
  }
  if (svc.wait != null) {
    const w = svc.wait;
    if (typeof w !== "object" || Array.isArray(w)) errors.push(`config: ${at} wait must be an object ({ "cmd": [...], "timeoutS" }).`);
    else {
      if (!Array.isArray(w.cmd) || !w.cmd.length || w.cmd.some((/** @type {unknown} */ c) => typeof c !== "string")) errors.push(`config: ${at} wait.cmd must be a non-empty array of strings (an argv).`);
      if (w.timeoutS != null && (typeof w.timeoutS !== "number" || !Number.isFinite(w.timeoutS) || w.timeoutS <= 0)) errors.push(`config: ${at} wait.timeoutS must be a number > 0.`);
    }
  }
  if (svc.memory != null && (typeof svc.memory !== "string" || !/^\d+[kmg]?$/i.test(svc.memory))) errors.push(`config: ${at} memory must be a size like "1g", "512m" or bytes.`);
  if (svc.cpus != null && (typeof svc.cpus !== "number" || !Number.isFinite(svc.cpus) || svc.cpus <= 0)) errors.push(`config: ${at} cpus must be a number > 0.`);
  return errors;
}

/**
 * Structural errors in an `egress` block (`sandbox.egress` or a step's): the mode, and every
 * `allow`/`deny` entry a valid rule or a known `@preset`. Pure.
 * @param {any} eg @param {string} at  e.g. `"sandbox.egress"` or `pipeline step "code" egress`
 * @returns {string[]}
 */
function egressErrors(eg, at) {
  if (typeof eg !== "object" || Array.isArray(eg) || eg === null) return [`config: ${at} must be an object ({ "mode", "allow", "deny" }).`];
  /** @type {string[]} */
  const errors = [];
  if (eg.mode != null && !(/** @type {readonly unknown[]} */ (EGRESS_MODES).includes(eg.mode))) errors.push(`config: ${at} mode ${JSON.stringify(eg.mode)} must be one of ${EGRESS_MODES.join(", ")}.`);
  for (const key of ["allow", "deny"]) {
    const list = eg[key];
    if (list == null) continue;
    if (!Array.isArray(list)) {
      errors.push(`config: ${at} ${key} must be a list of host rules or @presets.`);
      continue;
    }
    for (const entry of list) {
      const problem = egressEntryProblem(entry);
      if (problem) errors.push(`config: ${at} ${key} entry ${JSON.stringify(entry)}: ${problem}.`);
    }
  }
  return errors;
}

/**
 * Errors in a step's `allow` / `deny` policy (`at` = `config: pipeline step "<id>" allow`). Pure.
 * Entries become claude permission rules (`Bash(<cmd>)`, `Edit(//<cwd>/<path>)`), so `(` `)` `,`
 * and newlines are refused; paths must stay cwd-relative (no leading `/` or `~`, no drive
 * letter, no `..` segment).
 * @param {any} policy @param {string} at @returns {string[]}
 */
function policyErrors(policy, at) {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) return [`${at} must be an object ({ "commands"?: [...], "paths"?: [...] }).`];
  const unknown = Object.keys(policy).filter((k) => k !== "commands" && k !== "paths");
  if (unknown.length) return [`${at} has unknown key(s) ${unknown.map((k) => JSON.stringify(k)).join(", ")} (only "commands" and "paths").`];
  if (policy.commands == null && policy.paths == null) return [`${at} must set "commands" or "paths".`];
  /** @type {string[]} */
  const errors = [];
  /** @param {unknown} v */
  const ruleSafe = (v) => typeof v === "string" && v !== "" && v.trim() === v && !/[\n\r(),]/.test(v);
  for (const key of /** @type {const} */ (["commands", "paths"])) {
    const list = policy[key];
    if (list == null) continue;
    if (!Array.isArray(list) || !list.length) {
      errors.push(`${at}.${key} must be a non-empty array of strings.`);
      continue;
    }
    for (const v of list) {
      if (!ruleSafe(v)) errors.push(`${at}.${key} entry ${JSON.stringify(v)} must be a non-empty trimmed string with no newline, "(", ")" or ",".`);
      else if (key === "paths" && (/^[/~]/.test(v) || /^[A-Za-z]:/.test(v) || v.split(/[/\\]/).includes(".."))) {
        errors.push(`${at}.paths entry ${JSON.stringify(v)} must be relative to the run's cwd (no leading "/" or "~", no drive letter, no ".." segment).`);
      }
    }
  }
  return errors;
}

/**
 * Structural errors in a GitHub `auth` block (`tracker.auth` / `forge.auth`). Pure.
 * @param {any} auth @param {string} at @returns {string[]}
 */
function githubAuthErrors(auth, at) {
  if (!auth || typeof auth !== "object" || Array.isArray(auth)) return [`config: "${at}" must be an object ({ "type": "app", … }).`];
  if (auth.type !== "app") return [`config: "${at}.type" must be "app" (a GitHub App).`];
  /** @type {string[]} */
  const out = [];
  /** @param {any} v */
  const filled = (v) => (typeof v === "string" && v.trim() !== "") || (typeof v === "number" && Number.isFinite(v));
  if (!filled(auth.appId)) out.push(`config: "${at}.appId" is required (the GitHub App's id).`);
  if (!filled(auth.installationId)) out.push(`config: "${at}.installationId" is required (the App's installation on the repo/org).`);
  const hasKey = typeof auth.privateKey === "string" && auth.privateKey.trim() !== "";
  const hasPath = typeof auth.privateKeyPath === "string" && auth.privateKeyPath.trim() !== "";
  if (hasKey === hasPath) out.push(`config: "${at}" needs exactly one of "privateKey" (the PEM, e.g. "\${GITHUB_APP_PRIVATE_KEY}") or "privateKeyPath".`);
  return out;
}

/** The list lives in src/ui/sensitive.js (the config editor bundles it); re-exported for the server side. */
export { SECRET_FIELDS };

/**
 * The concrete paths (e.g. "tracker.token", "sinks[1].botToken") of SECRET_FIELDS holding a
 * literal: a non-empty string that is not exactly one `${VAR}` ref. Pure — never reads env.
 * Non-strings (`webhookSecret: false` opt-out, null), "" and missing fields are not reported.
 * @param {any} raw @returns {string[]}
 */
export function literalSecrets(raw) {
  /** @type {string[]} */
  const out = [];
  /** @param {any} node @param {string[]} segs @param {string} at */
  const walk = (node, segs, at) => {
    if (!segs.length) {
      if (typeof node === "string" && node !== "" && !isEnvRef(node)) out.push(at);
      return;
    }
    if (!node || typeof node !== "object") return;
    const [seg, ...rest] = segs;
    if (seg.endsWith("[*]")) {
      const key = seg.slice(0, -3);
      const arr = node[key];
      if (Array.isArray(arr)) arr.forEach((el, i) => walk(el, rest, `${at ? `${at}.` : ""}${key}[${i}]`));
      return;
    }
    if (Object.hasOwn(node, seg)) walk(node[seg], rest, at ? `${at}.${seg}` : seg);
  };
  for (const field of SECRET_FIELDS) walk(raw, field.split("."), "");
  return out;
}
