import fs from "node:fs";
import path from "node:path";
import { readJson } from "./read-json.js";

/**
 * per-ref review findings (findings.json): set on a `changes` bounce, read by the target step.
 * @param {string} dataDir
 * @returns {Pick<import('../types.js').Store, 'getFindings'|'setFindings'|'clearFindings'>}
 */
export function findingsSlice(dataDir) {
  const findingsFile = path.join(dataDir, "findings.json");

  return {
    getFindings: (ref) => readJson(findingsFile, {})[ref],
    setFindings: (ref, f) => {
      const m = readJson(findingsFile, {});
      m[ref] = f;
      fs.writeFileSync(findingsFile, JSON.stringify(m));
    },
    clearFindings: (ref) => {
      const m = readJson(findingsFile, {});
      if (ref in m) {
        delete m[ref];
        fs.writeFileSync(findingsFile, JSON.stringify(m));
      }
    },
  };
}
