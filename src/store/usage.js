import fs from "node:fs";
import path from "node:path";

/**
 * per-run token/cost records (usage.jsonl): append-only, one JSON per line. Distinct
 * from the rewritten state files elsewhere: a finished run appends exactly one record,
 * so concurrent agents never read-modify-write the same file.
 * @param {string} dataDir
 * @returns {Pick<import('../types.js').Store, 'recordUsage'|'readUsage'>}
 */
export function usageSlice(dataDir) {
  const usageFile = path.join(dataDir, "usage.jsonl");

  return {
    recordUsage: (rec) => {
      fs.appendFileSync(usageFile, JSON.stringify(rec) + "\n");
    },
    readUsage: () => {
      let raw;
      try {
        raw = fs.readFileSync(usageFile, "utf8");
      } catch {
        return [];
      }
      const out = [];
      for (const line of raw.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        try {
          out.push(JSON.parse(t));
        } catch {
          /* tolerate a trailing/garbage line (e.g. a partial append) */
        }
      }
      return out;
    },
  };
}
