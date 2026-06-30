// Tiny JSON-file persistence shared by the engine and providers.
//   - secrets: handshake secrets keyed by webhook path (Asana). Mode 0600.
//   - seen:    dedup keys so one event triggers exactly one run.
//   - running: in-flight pipeline jobs (ref -> {stepId,pid,...}) for crash recovery.
//
// seen is reloaded from disk on every read (reloadSeen) because external tools
// (the `catchup` CLI) edit it out-of-band; the in-memory set would otherwise mask
// those edits and silently dedup-skip a re-dispatch.
//
// `running` is OUR OWN crash-recovery state, never a poll: on boot the engine reads
// it (a file, no network) to find jobs interrupted by a restart. Forward motion is
// always event-driven; recovering a half-run job is the one thing the board can't
// tell us (it can't distinguish "mid-run" from "fresh"), so we record it locally.
import fs from "node:fs";
import path from "node:path";

/**
 * @param {string} dataDir
 * @returns {import('./types.js').Store}
 */
export function createStore(dataDir) {
  const secretsFile = path.join(dataDir, "secrets.json");
  const seenFile = path.join(dataDir, "seen.json");
  const runningFile = path.join(dataDir, "running.json");
  const attemptsFile = path.join(dataDir, "attempts.json");
  const difficultyFile = path.join(dataDir, "difficulty.json");

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

    // --- in-flight pipeline jobs (crash recovery), keyed by task ref ---
    setRunning: (ref, info) => {
      const m = readJson(runningFile, {});
      m[ref] = info;
      fs.writeFileSync(runningFile, JSON.stringify(m));
    },
    clearRunning: (ref) => {
      const m = readJson(runningFile, {});
      if (ref in m) {
        delete m[ref];
        fs.writeFileSync(runningFile, JSON.stringify(m));
      }
    },
    listRunning: () => readJson(runningFile, {}),

    // --- per-(ref,step) attempt counters: the changes-loop guard (attempts.json) ---
    // Bumped each dispatch; read before routing a `changes` back into a step so an
    // endless code↔review ping-pong (= endless `claude -p` spawns) gets capped → fail.
    getAttempt: (ref, stepId) => {
      const m = readJson(attemptsFile, {});
      return m[ref]?.[stepId] || 0;
    },
    bumpAttempt: (ref, stepId) => {
      const m = readJson(attemptsFile, {});
      m[ref] = m[ref] || {};
      m[ref][stepId] = (m[ref][stepId] || 0) + 1;
      fs.writeFileSync(attemptsFile, JSON.stringify(m));
      return m[ref][stepId];
    },
    clearAttempts: (ref) => {
      const m = readJson(attemptsFile, {});
      if (ref in m) {
        delete m[ref];
        fs.writeFileSync(attemptsFile, JSON.stringify(m));
      }
    },

    // --- per-ref difficulty tag (difficulty.json): persisted from triage verdict ---
    // Keyed by ref; cleared alongside attempts when the task reaches a terminal state.
    getDifficulty: (ref) => {
      const m = readJson(difficultyFile, {});
      return m[ref];
    },
    setDifficulty: (ref, difficulty) => {
      const m = readJson(difficultyFile, {});
      m[ref] = difficulty;
      fs.writeFileSync(difficultyFile, JSON.stringify(m));
    },
    clearDifficulty: (ref) => {
      const m = readJson(difficultyFile, {});
      if (ref in m) {
        delete m[ref];
        fs.writeFileSync(difficultyFile, JSON.stringify(m));
      }
    },
  };
}
