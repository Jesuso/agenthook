import fs from "node:fs";
import path from "node:path";
import { readJson } from "./read-json.js";

/**
 * merge catch-up watermark (merge-watermark.json): `{mergedAt}` of the newest merged
 * agent PR the explicit merge catch-up (`runMergeCatchup`) listed, so the next one only
 * asks the forge for later merges.
 * @param {string} dataDir
 * @returns {Pick<import('../types/index.js').Store, 'getMergeWatermark'|'setMergeWatermark'>}
 */
export function mergeWatermarkSlice(dataDir) {
  const mergeWatermarkFile = path.join(dataDir, "merge-watermark.json");

  return {
    getMergeWatermark: () => {
      const v = readJson(mergeWatermarkFile, {})?.mergedAt;
      return typeof v === "string" && v ? v : null;
    },
    setMergeWatermark: (iso) => {
      fs.writeFileSync(mergeWatermarkFile, JSON.stringify({ mergedAt: iso }));
    },
  };
}
