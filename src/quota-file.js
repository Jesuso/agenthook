// `<stateDir>/quota.json` — the last Claude quota reading (src/quota.js), written by the receiver
// after each Claude run. Its own file because heartbeat.json is deleted on stop, and the readout
// (`ah status`, MCP `status`/`tick`, the UI) must work with the receiver down.
import fs from "node:fs";
import path from "node:path";
import { normalizeQuota } from "./quota.js";

export const QUOTA_FILE = "quota.json";

/** The persisted reading, validated; null when absent or garbage.
 * @param {string} stateDir @returns {import('./quota.js').QuotaReading|null} */
export function readQuota(stateDir) {
  try {
    return normalizeQuota(JSON.parse(fs.readFileSync(path.join(stateDir, QUOTA_FILE), "utf8")));
  } catch {
    return null;
  }
}

/** Persist a reading atomically (temp + rename, so a reader never sees a torn file).
 * @param {string} stateDir @param {import('./quota.js').QuotaReading} q */
export function writeQuota(stateDir, q) {
  const file = path.join(stateDir, QUOTA_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(q, null, 2));
  fs.renameSync(tmp, file);
}
