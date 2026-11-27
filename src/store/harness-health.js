import fs from "node:fs";
import path from "node:path";
import { readJson } from "./read-json.js";

/**
 * harness health breaker (harness-health.json): {down: {[name]: {until, strikes, reason, cause}}, unharnessedUntil?}
 * @param {string} dataDir
 * @returns {Pick<import('../types/state.js').Store, 'getHarnessHealth'|'setHarnessHealth'>}
 */
export function harnessHealthSlice(dataDir) {
  const harnessHealthFile = path.join(dataDir, "harness-health.json");

  return {
    getHarnessHealth: () => {
      const r = readJson(harnessHealthFile, {});
      const down = r?.down && typeof r.down === "object" && !Array.isArray(r.down) ? r.down : {};
      const unharnessedUntil = typeof r?.unharnessedUntil === "string" && r.unharnessedUntil ? r.unharnessedUntil : null;
      return { down, unharnessedUntil };
    },
    setHarnessHealth: (down, unharnessedUntil) => {
      fs.writeFileSync(harnessHealthFile, JSON.stringify({ down, ...(unharnessedUntil ? { unharnessedUntil } : {}) }));
    },
  };
}
