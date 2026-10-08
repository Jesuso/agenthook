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
import { controlSockPath } from "./paths.js";

// The installed package root (this file is src/config.js). Used only to read
// bundled templates — never for runtime state.
export const installDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Where all profiles keep their runtime state, one subdir per profile name.
// AGENTHOOK_HOME overrides the root (tests use it to stay out of the real ~/.agenthook).
export const registryDir = process.env.AGENTHOOK_HOME
  ? path.resolve(process.env.AGENTHOOK_HOME)
  : path.join(os.homedir(), ".agenthook");

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
function validName(name) {
  return !!name && typeof name === "string" && /^[A-Za-z0-9._-]+$/.test(name);
}

/** @param {any} name */
function assertName(name) {
  if (!validName(name)) throw new Error(NAME_ERROR);
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
 * @returns {{ name: string, configPath: string, configDir: string, stateDir: string, logDir: string }}
 */
export function peekConfig(opts = {}) {
  const { configPath, configDir, raw } = readRawConfig(opts.configPath);
  const name = raw?.name;
  assertName(name);
  const stateDir = path.join(registryDir, name);
  return { name, configPath, configDir, stateDir, logDir: path.join(stateDir, "logs") };
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

  const stateDir = path.join(registryDir, cfg.name);
  cfg.stateDir = stateDir;
  cfg.dataDir = stateDir;
  cfg.logDir = path.join(stateDir, "logs");
  cfg.publicUrlFile = path.join(stateDir, "public_url.txt");
  cfg.pidFile = path.join(stateDir, "server.pid");
  cfg.heartbeatFile = path.join(stateDir, "heartbeat.json");
  cfg.controlSock = controlSockPath(stateDir, cfg.name);

  // instructionsFile defaults to one beside the config; resolve relative to it.
  cfg.instructionsFile = resolvePath(cfg.instructionsFile || "./INSTRUCTIONS.md", configDir);

  // --- defaults ---
  cfg.trigger = cfg.trigger || "@agent";
  cfg.maxConcurrent = cfg.maxConcurrent || 1;
  cfg.port = cfg.port || 4123;
  cfg.claudeBin = cfg.claudeBin || "claude";
  cfg.overlapGuard = cfg.overlapGuard === true;
  cfg.ingress = cfg.ingress || { type: "manual" };
  if (!cfg.ingress.type) cfg.ingress.type = "manual";

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

  ensurePrivateDir(cfg.stateDir);
  ensurePrivateDir(cfg.logDir);
  return cfg;
}

/**
 * Ensure `dir` exists, private. A newly created dir is always born 0700 (POSIX);
 * the parent is created first, without a mode, so `recursive` mkdir doesn't also
 * stamp 0700 onto a freshly created `~/.agenthook` or other ancestor.
 *
 * An already-existing dir's mode is only checked/tightened when `tighten` is set
 * (the boot path, which runs once) — loadConfig runs on *every* command, so it
 * calls this create-only and never flips perms on an existing dir, silently or not.
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
  const tracker = cfg.tracker;
  if (!tracker?.type) errors.push(`config: "tracker.type" is required (e.g. "asana").`);
  if (!cfg.repoPath && cfg.repos == null) {
    errors.push(`config: "repoPath" is required (the repo agents work in), unless a "repos" block declares them.`);
  }

  if (cfg.repos != null) {
    if (!Array.isArray(cfg.repos) || !cfg.repos.length) {
      errors.push(`config: "repos" must be a non-empty array.`);
    } else {
      const ids = new Set();
      /** @type {Map<string, string>} route key → repo id */
      const keys = new Map();
      /** @type {string[]} */
      const defaults = [];
      cfg.repos.forEach((/** @type {any} */ r, /** @type {number} */ i) => {
        if (!r || typeof r !== "object") return void errors.push(`config: repos[${i}] must be an object.`);
        if (typeof r.id !== "string" || !/^[A-Za-z0-9._-]+$/.test(r.id)) {
          // Later messages name the repo by id; without a usable one, stop at this repo.
          return void errors.push(`config: repos[${i}].id is required and must match [A-Za-z0-9._-]+ (got ${JSON.stringify(r.id)}).`);
        }
        if (ids.has(r.id)) errors.push(`config: duplicate repos id "${r.id}".`);
        ids.add(r.id);
        if (typeof r.path !== "string" || !r.path) errors.push(`config: repos "${r.id}" requires a "path".`);
        if (r.match != null && !Array.isArray(r.match)) {
          errors.push(`config: repos "${r.id}".match must be an array of strings.`);
        } else {
          for (const m of r.match ?? []) {
            if (typeof m !== "string" || !m.trim()) {
              errors.push(`config: repos "${r.id}".match entries must be non-empty strings (got ${JSON.stringify(m)}).`);
              continue;
            }
            const k = m.trim().toLowerCase();
            if (keys.has(k) && keys.get(k) !== r.id) errors.push(`config: route key "${k}" is claimed by both repos "${keys.get(k)}" and "${r.id}".`);
            else keys.set(k, r.id);
          }
        }
        if (r.default != null && typeof r.default !== "boolean") errors.push(`config: repos "${r.id}".default must be a boolean.`);
        if (r.instructionsFile != null && typeof r.instructionsFile !== "string") errors.push(`config: repos "${r.id}".instructionsFile must be a string.`);
        if (r.worktreePrefix != null && typeof r.worktreePrefix !== "string") errors.push(`config: repos "${r.id}".worktreePrefix must be a string.`);
        if (r.default === true) defaults.push(r.id);
      });
      if (defaults.length > 1) errors.push(`config: at most one repo may set default:true (found ${defaults.join(", ")}).`);
    }
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
    if (step.maxMinutes != null && (typeof step.maxMinutes !== "number" || !Number.isFinite(step.maxMinutes) || step.maxMinutes < 0)) {
      errors.push(`config: pipeline step "${sid}" maxMinutes must be a number >= 0 (0 disables the cap).`);
    }
    if (step.idleMinutes != null && (typeof step.idleMinutes !== "number" || !Number.isFinite(step.idleMinutes) || step.idleMinutes <= 0)) {
      errors.push(`config: pipeline step "${sid}" idleMinutes must be a number > 0.`);
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

  if (cfg.sinks != null) {
    if (!Array.isArray(cfg.sinks)) errors.push(`config: sinks must be an array.`);
    else {
      /** @type {Record<string, string[]>} */
      const need = { slack: ["url"], webhook: ["url"], telegram: ["botToken", "chatId"] };
      cfg.sinks.forEach((/** @type {any} */ s, /** @type {number} */ i) => {
        if (!s || typeof s.type !== "string" || !Object.hasOwn(need, s.type)) {
          return void errors.push(`config: sinks[${i}].type must be one of slack, telegram, webhook (got ${JSON.stringify(s?.type)}).`);
        }
        for (const f of need[s.type]) {
          if (s[f] == null || s[f] === "") errors.push(`config: sinks[${i}] (${s.type}) requires "${f}".`);
        }
        if (s.events != null && (!Array.isArray(s.events) || s.events.some((/** @type {any} */ e) => typeof e !== "string"))) {
          errors.push(`config: sinks[${i}].events must be an array of strings.`);
        }
      });
    }
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

/** Config paths whose value is a secret — each should be a `${VAR}` ref, never a literal.
 * `[*]` expands every element of an array. */
export const SECRET_FIELDS = /** @type {const} */ ([
  "tracker.token",
  "tracker.webhookSecret",
  "forge.token",
  "forge.webhookSecret",
  "ingress.authtoken",
  "sinks[*].url",
  "sinks[*].botToken",
]);

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
      if (typeof node === "string" && node !== "" && !/^\$\{[A-Z0-9_]+\}$/.test(node)) out.push(at);
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
