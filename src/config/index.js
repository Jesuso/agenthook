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
//
// Split by job across this folder: locations.js (where things live on disk), env.js
// (.env loading and file-sourced-key tracking), load.js (profile load/resolve), and
// validate/ (raw-config validation). This file is the only entry point.
export { installDir, registryDir, DEFAULT_PORT, discoverConfigPath, ensurePrivateDir } from "./locations.js";
export { fileEnvKeys, loadEnv, withoutFileEnv, respawnEnv } from "./env.js";
export { peekConfig, rawAgentBins, loadConfig } from "./load.js";
export { validName } from "./validate/common.js";
export { REMOTE_TRACKERS } from "./validate/harnesses.js";
export { validateRawConfig, SECRET_FIELDS, literalSecrets } from "./validate/index.js";
