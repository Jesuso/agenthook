import fs from "node:fs";
import path from "node:path";
import { readJson } from "./read-json.js";

/**
 * per-ref held step (held.json): written on a `hold` verdict.
 * Names the step an owner's `@agent` reply resumes. Cleared when any step for the
 * ref starts again (the resume, or a manual drag-back) and on a terminal state.
 * @param {string} dataDir
 * @returns {Pick<import('../types/state.js').Store, 'getHeld'|'setHeld'|'clearHeld'>}
 */
export function heldSlice(dataDir) {
  const heldFile = path.join(dataDir, "held.json");

  return {
    getHeld: (ref) => {
      const m = readJson(heldFile, {});
      return m[ref];
    },
    setHeld: (ref, info) => {
      const m = readJson(heldFile, {});
      m[ref] = info;
      fs.writeFileSync(heldFile, JSON.stringify(m));
    },
    clearHeld: (ref) => {
      const m = readJson(heldFile, {});
      if (ref in m) {
        delete m[ref];
        fs.writeFileSync(heldFile, JSON.stringify(m));
      }
    },
  };
}
