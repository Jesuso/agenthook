import fs from "node:fs";
import path from "node:path";
import { readJson } from "./read-json.js";

/**
 * per-(ref,step) attempt counters: the changes-loop guard (attempts.json).
 * Bumped each dispatch; read before routing a `changes` back into a step so an
 * endless code↔review ping-pong (= endless `claude -p` spawns) gets capped → fail.
 * @param {string} dataDir
 * @returns {Pick<import('../types.js').Store, 'getAttempt'|'bumpAttempt'|'unbumpAttempt'|'clearAttempts'>}
 */
export function attemptsSlice(dataDir) {
  const attemptsFile = path.join(dataDir, "attempts.json");

  return {
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
    unbumpAttempt: (ref, stepId) => {
      const m = readJson(attemptsFile, {});
      if (!m[ref]?.[stepId]) return;
      m[ref][stepId] -= 1;
      if (m[ref][stepId] <= 0) delete m[ref][stepId];
      if (Object.keys(m[ref]).length === 0) delete m[ref];
      fs.writeFileSync(attemptsFile, JSON.stringify(m));
    },
    clearAttempts: (ref) => {
      const m = readJson(attemptsFile, {});
      if (ref in m) {
        delete m[ref];
        fs.writeFileSync(attemptsFile, JSON.stringify(m));
      }
    },
  };
}
