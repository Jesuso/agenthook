import fs from "node:fs";
import path from "node:path";
import { readJson } from "./read-json.js";

/**
 * in-flight pipeline jobs (crash recovery), keyed by task ref (running.json).
 * `running` is OUR OWN crash-recovery state, never a poll: on boot the engine reads
 * it (a file, no network) to find jobs interrupted by a restart.
 * @param {string} dataDir
 * @returns {Pick<import('../types/index.js').Store, 'setRunning'|'clearRunning'|'listRunning'>}
 */
export function runningSlice(dataDir) {
  const runningFile = path.join(dataDir, "running.json");

  return {
    setRunning: (ref, info) => {
      const m = readJson(runningFile, {});
      m[ref] = info;
      fs.writeFileSync(runningFile, JSON.stringify(m));
    },
    clearRunning: (ref) => {
      const m = readJson(runningFile, {});
      if (ref in m) {
        delete m[ref];
        fs.writeFileSync(runningFile, JSON.stringify(m));
      }
    },
    listRunning: () => readJson(runningFile, {}),
  };
}
