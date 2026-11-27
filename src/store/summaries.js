import fs from "node:fs";
import path from "node:path";
import { readJson } from "./read-json.js";

/** summaries.json keeps at most this many refs (oldest newest-`at` dropped first). */
export const MAX_SUMMARY_REFS = 500;

/**
 * per-(ref, step) supervisor summaries (summaries.json): set per finished run. Outlive a
 * manual drain (the PR is still open); cleared on terminal fail/cancel and merge; capped
 * at MAX_SUMMARY_REFS refs.
 * @param {string} dataDir
 * @returns {Pick<import('../types/index.js').Store, 'getSummaries'|'setSummary'|'clearSummary'|'clearSummaries'>}
 */
export function summariesSlice(dataDir) {
  const summariesFile = path.join(dataDir, "summaries.json");

  return {
    getSummaries: (ref) => readJson(summariesFile, {})[ref],
    setSummary: (ref, stepId, rec) => {
      const m = readJson(summariesFile, {});
      m[ref] = { ...(m[ref] || {}), [stepId]: rec };
      const refs = Object.keys(m);
      if (refs.length > MAX_SUMMARY_REFS) {
        /** @param {string} r */
        const newest = (r) => Object.values(m[r] || {}).reduce((a, x) => (typeof x?.at === "string" && x.at > a ? x.at : a), "");
        refs.sort((a, b) => (newest(a) < newest(b) ? -1 : newest(a) > newest(b) ? 1 : 0));
        for (const r of refs.slice(0, refs.length - MAX_SUMMARY_REFS)) delete m[r];
      }
      fs.writeFileSync(summariesFile, JSON.stringify(m));
    },
    clearSummary: (ref, stepId) => {
      const m = readJson(summariesFile, {});
      if (!m[ref] || !(stepId in m[ref])) return;
      delete m[ref][stepId];
      if (!Object.keys(m[ref]).length) delete m[ref];
      fs.writeFileSync(summariesFile, JSON.stringify(m));
    },
    clearSummaries: (ref) => {
      const m = readJson(summariesFile, {});
      if (ref in m) {
        delete m[ref];
        fs.writeFileSync(summariesFile, JSON.stringify(m));
      }
    },
  };
}
