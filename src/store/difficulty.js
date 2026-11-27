import fs from "node:fs";
import path from "node:path";
import { readJson } from "./read-json.js";

/**
 * per-ref difficulty tag (difficulty.json): persisted from triage verdict.
 * Keyed by ref; cleared alongside attempts when the task reaches a terminal state.
 * @param {string} dataDir
 * @returns {Pick<import('../types/state.js').Store, 'getDifficulty'|'setDifficulty'|'clearDifficulty'>}
 */
export function difficultySlice(dataDir) {
  const difficultyFile = path.join(dataDir, "difficulty.json");

  return {
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
