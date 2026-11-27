// `.env` loading and file-sourced-key tracking, plus the pure env/interpolation helpers
// loadConfig needs to resolve `${VAR}` refs against either process.env or a caller-supplied env.
import fs from "node:fs";
import util from "node:util";

/** Keys a `loadEnv` call has actually set from a .env file, each with the value it set. A key
 * already present in `process.env` before the call (shell-exported, or set by an earlier
 * `loadEnv`) is never recorded. Accumulates across calls — `loadConfig` calls `loadEnv` twice,
 * and `validateConfig` calls `loadConfig` again later — so `withoutFileEnv` below always sees
 * every file-sourced key this process has ever loaded. */
export const fileEnvKeys = new Map();

/** Load a .env file into process.env without clobbering already-set vars; records every key it
 * actually sets into `fileEnvKeys`, so a later detached respawn (`detachedEnv`, src/respawn.js)
 * can tell a file-sourced value from a shell-exported one and strip it to force a re-read.
 * @param {string} file */
export function loadEnv(file) {
  if (typeof process.loadEnvFile !== "function" || !fs.existsSync(file)) return;
  const before = new Set(Object.keys(process.env));
  try {
    process.loadEnvFile(file); // Node ≥ 20.12: does not overwrite existing vars
  } catch {
    return; /* malformed .env is non-fatal */
  }
  for (const k of Object.keys(process.env)) {
    if (!before.has(k)) fileEnvKeys.set(k, process.env[k]);
  }
}

/**
 * A copy of `env` without every key `fileKeys` recorded as file-sourced whose current value
 * still equals the value recorded then — so a detached child drops it and reads `.env` itself
 * instead of inheriting a stale value. A key the process changed since (or removed from the
 * file, which `loadEnvFile` can't un-set) is left to the caller's own judgement if its value
 * moved on; a key a shell exported was never recorded, so it always stays. Pure.
 * @param {NodeJS.ProcessEnv} env @param {Map<string,string>} [fileKeys]
 * @returns {NodeJS.ProcessEnv}
 */
export function withoutFileEnv(env, fileKeys = fileEnvKeys) {
  const out = { ...env };
  for (const [k, v] of fileKeys) {
    if (out[k] === v) delete out[k];
  }
  return out;
}

/**
 * The env a detached respawn will see, before the fresh process re-reads `.env` itself:
 * `env` minus every unchanged file-sourced key (src/respawn.js applies its own
 * AGENTHOOK_SERVICE removal on top). Use as `loadConfig({ ..., env: respawnEnv() })` when a
 * check must validate against the respawn, not this process's stale in-memory values.
 * Pure.
 * @param {NodeJS.ProcessEnv} [env] @returns {NodeJS.ProcessEnv}
 */
export function respawnEnv(env = process.env) {
  return withoutFileEnv(env);
}

/** Recursively interpolate ${VAR} refs in every string of a JSON value.
 * `//` comment keys are copied through verbatim — not expanded, not required — at any depth.
 * Reads from `env` (default process.env) so a caller can validate against a different env —
 * e.g. the env a detached respawn will see — without touching process.env. Throws listing
 * every unresolved var (via the `missing` out-param) so misconfig fails loud, not silent.
 * @param {any} node @param {string[]} missing @param {string} pathLabel @param {NodeJS.ProcessEnv} [env] @returns {any} */
export function interpolate(node, missing, pathLabel = "", env = process.env) {
  if (typeof node === "string") {
    return node.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name) => {
      const v = env[name];
      if (v == null || v === "") {
        missing.push(`${name} (at ${pathLabel || "<root>"})`);
        return "";
      }
      return v;
    });
  }
  if (Array.isArray(node)) return node.map((v, i) => interpolate(v, missing, `${pathLabel}[${i}]`, env));
  if (node && typeof node === "object") {
    /** @type {Record<string, any>} */
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (k.startsWith("//")) { out[k] = v; continue; } // comment key: verbatim, not walked
      out[k] = interpolate(v, missing, pathLabel ? `${pathLabel}.${k}` : k, env);
    }
    return out;
  }
  return node;
}

/** Overlay a .env file onto a local env object without overwriting keys it already has and
 * without touching process.env — the file half of loadConfig's precedence for the `opts.env`
 * path. A missing file is skipped; a malformed one is non-fatal, like loadEnv.
 * @param {NodeJS.ProcessEnv} target @param {string} file */
export function overlayDotEnv(target, file) {
  let parsed;
  try {
    parsed = util.parseEnv(fs.readFileSync(file, "utf8"));
  } catch {
    return; /* missing or malformed .env: non-fatal, like loadEnv */
  }
  for (const [k, v] of Object.entries(parsed)) {
    if (target[k] == null) target[k] = v;
  }
}
