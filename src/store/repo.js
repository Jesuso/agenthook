import fs from "node:fs";
import path from "node:path";
import { readJson } from "./read-json.js";

/**
 * per-ref sticky repo id (repo.json): written when a multi-repo ref first routes.
 * Keyed by ref; cleared alongside difficulty when the task reaches a terminal state.
 * @param {string} dataDir
 * @returns {Pick<import('../types/index.js').Store, 'getRepo'|'setRepo'|'clearRepo'>}
 */
export function repoSlice(dataDir) {
  const repoFile = path.join(dataDir, "repo.json");

  return {
    getRepo: (ref) => {
      const m = readJson(repoFile, {});
      return m[ref];
    },
    setRepo: (ref, repoId) => {
      const m = readJson(repoFile, {});
      m[ref] = repoId;
      fs.writeFileSync(repoFile, JSON.stringify(m));
    },
    clearRepo: (ref) => {
      const m = readJson(repoFile, {});
      if (ref in m) {
        delete m[ref];
        fs.writeFileSync(repoFile, JSON.stringify(m));
      }
    },
  };
}
