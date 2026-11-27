import fs from "node:fs";
import path from "node:path";
import { readJson } from "./read-json.js";

/**
 * State-based dedup keys (`step:<id>:<ref>`) are released when the run ends;
 * event-based ones (`secmove:`/`unblock:`/`reconcile:`/…) are unique per event and stay permanent.
 * @param {string} key
 */
export function isStateDedupKey(key) {
  return typeof key === "string" && key.startsWith("step:");
}

/**
 * dedup set (seen.json). Reloaded from disk on every read (reloadSeen) because external
 * tools (the `catchup` CLI) edit it out-of-band; the in-memory set would otherwise mask
 * those edits and silently dedup-skip a re-dispatch.
 * @param {string} dataDir
 * @returns {Pick<import('../types.js').Store, 'reloadSeen'|'hasSeen'|'markSeen'|'unmarkSeen'|'seenCount'|'seenFile'>}
 */
export function seenSlice(dataDir) {
  const seenFile = path.join(dataDir, "seen.json");

  let seen = new Set(readJson(seenFile, []));

  return {
    reloadSeen: () => {
      seen = new Set(readJson(seenFile, []));
    },
    hasSeen: (key) => seen.has(key),
    markSeen: (key) => {
      seen.add(key);
      fs.writeFileSync(seenFile, JSON.stringify([...seen]));
    },
    unmarkSeen: (key) => {
      seen.delete(key);
      fs.writeFileSync(seenFile, JSON.stringify([...seen]));
    },
    seenCount: () => seen.size,
    seenFile,
  };
}
