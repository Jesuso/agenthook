import fs from "node:fs";
import path from "node:path";
import { readJson } from "./read-json.js";

/**
 * file-overlap guard (opt-in): predicted paths, locks, waiting refs. Only written when
 * cfg.overlapGuard is on.
 * @param {string} dataDir
 * @returns {Pick<import('../types.js').Store, 'getPredictedPaths'|'setPredictedPaths'|'clearPredictedPaths'|'getLock'|'setLock'|'clearLock'|'listLocks'|'getOverlap'|'setOverlap'|'clearOverlap'|'listOverlap'>}
 */
export function overlapSlice(dataDir) {
  const pathsFile = path.join(dataDir, "paths.json");
  const locksFile = path.join(dataDir, "locks.json");
  const overlapFile = path.join(dataDir, "overlap.json");

  return {
    // paths.json: what a no-worktree step (triage) predicts the change will touch.
    getPredictedPaths: (ref) => readJson(pathsFile, {})[ref],
    setPredictedPaths: (ref, paths) => {
      const m = readJson(pathsFile, {});
      m[ref] = paths;
      fs.writeFileSync(pathsFile, JSON.stringify(m));
    },
    clearPredictedPaths: (ref) => {
      const m = readJson(pathsFile, {});
      if (ref in m) {
        delete m[ref];
        fs.writeFileSync(pathsFile, JSON.stringify(m));
      }
    },
    // locks.json: paths an in-flight ref holds; cleared when it leaves the pipeline.
    getLock: (ref) => readJson(locksFile, {})[ref],
    setLock: (ref, lock) => {
      const m = readJson(locksFile, {});
      m[ref] = lock;
      fs.writeFileSync(locksFile, JSON.stringify(m));
    },
    clearLock: (ref) => {
      const m = readJson(locksFile, {});
      if (ref in m) {
        delete m[ref];
        fs.writeFileSync(locksFile, JSON.stringify(m));
      }
    },
    listLocks: () => readJson(locksFile, {}),
    // overlap.json: refs resting in their source stage behind another ref's lock.
    // Separate from held.json (that one is the `@agent` resume).
    getOverlap: (ref) => readJson(overlapFile, {})[ref],
    setOverlap: (ref, info) => {
      const m = readJson(overlapFile, {});
      m[ref] = info;
      fs.writeFileSync(overlapFile, JSON.stringify(m));
    },
    clearOverlap: (ref) => {
      const m = readJson(overlapFile, {});
      if (ref in m) {
        delete m[ref];
        fs.writeFileSync(overlapFile, JSON.stringify(m));
      }
    },
    listOverlap: () => readJson(overlapFile, {}),
  };
}
