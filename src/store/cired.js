import fs from "node:fs";
import path from "node:path";
import { readJson } from "./read-json.js";

/**
 * per-ref parked red-CI bounce (cired.json): set by a `ci` job, taken on run exit
 * (dispatch applies them when that run exits).
 * @param {string} dataDir
 * @returns {Pick<import('../types/index.js').Store, 'setCiRed'|'takeCiRed'>}
 */
export function ciRedSlice(dataDir) {
  const ciRedFile = path.join(dataDir, "cired.json");

  return {
    setCiRed: (ref, b) => {
      const m = readJson(ciRedFile, {});
      m[ref] = b;
      fs.writeFileSync(ciRedFile, JSON.stringify(m));
    },
    takeCiRed: (ref) => {
      const m = readJson(ciRedFile, {});
      const b = m[ref];
      if (b) {
        delete m[ref];
        fs.writeFileSync(ciRedFile, JSON.stringify(m));
      }
      return b;
    },
  };
}
