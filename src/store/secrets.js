import fs from "node:fs";
import path from "node:path";
import { readJson } from "./read-json.js";

/**
 * handshake secrets, keyed by webhook path. secrets.json, mode 0600.
 * @param {string} dataDir
 * @returns {Pick<import('../types/index.js').Store, 'getSecret'|'setSecret'|'secretCount'>}
 */
export function secretsSlice(dataDir) {
  const secretsFile = path.join(dataDir, "secrets.json");

  let secrets = readJson(secretsFile, {});

  return {
    getSecret: (key) => secrets[key],
    setSecret: (key, value) => {
      secrets[key] = value;
      fs.writeFileSync(secretsFile, JSON.stringify(secrets), { mode: 0o600 });
    },
    secretCount: () => Object.keys(secrets).length,
  };
}
