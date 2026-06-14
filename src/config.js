// Loads config.json, auto-loads .env, resolves ~ and relative paths, and resolves
// every secret (provider token, webhook secret) from the environment. config.json
// holds only non-secret wiring; secrets live in .env or the real environment.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Pull .env into process.env before anything reads a secret. Shell-exported vars
// already present win — loadEnvFile does not overwrite them. (Node ≥ 20.12.)
const envFile = path.join(root, ".env");
if (typeof process.loadEnvFile === "function" && fs.existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

// Default env var holding each provider's API token. Override per provider with
// providers.<name>.tokenEnv.
/** @type {Record<string, string>} */
const DEFAULT_TOKEN_ENV = { asana: "ASANA_TOKEN", github: "GITHUB_TOKEN" };

/** @param {string} [p] */
const expand = (p) => {
  if (!p) return p;
  if (p.startsWith("~")) p = path.join(os.homedir(), p.slice(1));
  return path.isAbsolute(p) ? p : path.join(root, p);
};

// env var first, then a token FILE if the user opted into that legacy path.
/** @param {string} [envName] @param {string} [file] @returns {string|undefined} */
const resolveSecret = (envName, file) => {
  const fromEnv = envName ? process.env[envName] : undefined;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  if (file && fs.existsSync(file)) return fs.readFileSync(file, "utf8").trim();
  return undefined;
};

/** @returns {import('./types.js').Config} */
export function loadConfig() {
  const file = path.join(root, "config.json");
  if (!fs.existsSync(file)) {
    throw new Error(`config.json not found. Copy config.example.json -> config.json and fill it in.`);
  }
  const cfg = JSON.parse(fs.readFileSync(file, "utf8"));

  if (!cfg.provider) throw new Error("config: `provider` is required (e.g. \"asana\" or \"github\").");
  const pcfg = cfg.providers?.[cfg.provider];
  if (!pcfg) throw new Error(`config: providers.${cfg.provider} block is missing.`);

  // Resolve filesystem paths up front so the rest of the app deals in absolutes.
  cfg.root = root;
  cfg.repoPath = expand(cfg.repoPath);
  cfg.dataDir = expand(cfg.dataDir);
  cfg.logDir = expand(cfg.logDir);
  cfg.instructionsFile = expand(cfg.instructionsFile);
  cfg.publicUrlFile = expand(cfg.publicUrlFile);
  if (pcfg.tokenFile) pcfg.tokenFile = expand(pcfg.tokenFile);

  // Resolve secrets from the environment (.env or shell). tokenFile is a fallback.
  const tokenEnv = pcfg.tokenEnv || DEFAULT_TOKEN_ENV[cfg.provider] || "";
  pcfg.token = resolveSecret(tokenEnv, pcfg.tokenFile);
  if (!pcfg.token) {
    throw new Error(
      `no API token for provider "${cfg.provider}". Set ${tokenEnv || "<tokenEnv>"} in .env ` +
        `(copy .env.example) or your shell — or set providers.${cfg.provider}.tokenFile.`,
    );
  }
  // Webhook secret (GitHub-style): env wins, config.json value is a fallback.
  const wsEnv = pcfg.webhookSecretEnv || "WEBHOOK_SECRET";
  pcfg.webhookSecret = resolveSecret(wsEnv) || pcfg.webhookSecret;

  cfg.providerConfig = pcfg;
  cfg.trigger = cfg.trigger || "@agent";
  cfg.maxConcurrent = cfg.maxConcurrent || 1;
  cfg.port = cfg.port || 4123;

  fs.mkdirSync(cfg.dataDir, { recursive: true });
  fs.mkdirSync(cfg.logDir, { recursive: true });
  return cfg;
}
