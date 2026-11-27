import fs from "node:fs";
import path from "node:path";
import { readJson } from "./read-json.js";

/**
 * operator runtime overrides (overrides.json): {paused?, maxConcurrent?, harnesses?}
 * @param {string} dataDir
 * @returns {Pick<import('../types/index.js').Store, 'getOverrides'|'setOverrides'>}
 */
export function overridesSlice(dataDir) {
  const overridesFile = path.join(dataDir, "overrides.json");

  return {
    getOverrides: () => {
      const o = readJson(overridesFile, {});
      return o && typeof o === "object" && !Array.isArray(o) ? o : {};
    },
    setOverrides: (o) => {
      if (!o || !Object.keys(o).length) {
        fs.rmSync(overridesFile, { force: true });
        return;
      }
      fs.writeFileSync(overridesFile, JSON.stringify(o));
    },
  };
}
