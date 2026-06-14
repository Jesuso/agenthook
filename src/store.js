// Tiny JSON-file persistence shared by the engine and providers.
//   - secrets: handshake secrets keyed by webhook path (Asana). Mode 0600.
//   - seen:    dedup keys so one event triggers exactly one run.
//
// seen is reloaded from disk on every read (reloadSeen) because external tools
// (the `catchup` CLI) edit it out-of-band; the in-memory set would otherwise mask
// those edits and silently dedup-skip a re-dispatch.
import fs from "node:fs";
import path from "node:path";

/**
 * @param {string} dataDir
 * @returns {import('./types.js').Store}
 */
export function createStore(dataDir) {
  const secretsFile = path.join(dataDir, "secrets.json");
  const seenFile = path.join(dataDir, "seen.json");

  /** @param {string} f @param {any} fallback */
  const readJson = (f, fallback) => {
    try {
      return JSON.parse(fs.readFileSync(f, "utf8"));
    } catch {
      return fallback;
    }
  };

  let secrets = readJson(secretsFile, {});
  let seen = new Set(readJson(seenFile, []));

  return {
    // --- handshake secrets, keyed by webhook path ---
    getSecret: (key) => secrets[key],
    setSecret: (key, value) => {
      secrets[key] = value;
      fs.writeFileSync(secretsFile, JSON.stringify(secrets), { mode: 0o600 });
    },
    secretCount: () => Object.keys(secrets).length,

    // --- dedup set ---
    reloadSeen: () => {
      seen = new Set(readJson(seenFile, []));
    },
    hasSeen: (key) => seen.has(key),
    markSeen: (key) => {
      seen.add(key);
      fs.writeFileSync(seenFile, JSON.stringify([...seen]));
    },
    unmarkSeen: (key) => {
      seen.delete(key);
      fs.writeFileSync(seenFile, JSON.stringify([...seen]));
    },
    seenCount: () => seen.size,
    seenFile,
  };
}
