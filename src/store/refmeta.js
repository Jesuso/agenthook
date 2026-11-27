import fs from "node:fs";
import path from "node:path";
import { readJson } from "./read-json.js";

/**
 * per-ref display metadata (refmeta.json): human id, title, PR number + terminal state,
 * tracker URL. Written by dispatch and the `prs` op (receiver-side only); read by
 * agents/status/events. Shallow merge so the PR lookup and the fetchTask write can land
 * independently; a `null` value deletes that key (a re-run drops a stale `prState`),
 * `undefined` is skipped.
 * @param {string} dataDir
 * @returns {Pick<import('../types.js').Store, 'getRefMeta'|'setRefMeta'|'listRefMeta'>}
 */
export function refmetaSlice(dataDir) {
  const refmetaFile = path.join(dataDir, "refmeta.json");

  return {
    getRefMeta: (ref) => readJson(refmetaFile, {})[ref],
    setRefMeta: (ref, patch) => {
      const m = readJson(refmetaFile, {});
      const cur = m[ref] || {};
      for (const [k, v] of Object.entries(patch)) {
        if (v === null) delete cur[k];
        else if (v !== undefined) cur[k] = v;
      }
      m[ref] = cur;
      fs.writeFileSync(refmetaFile, JSON.stringify(m));
    },
    listRefMeta: () => readJson(refmetaFile, {}),
  };
}
