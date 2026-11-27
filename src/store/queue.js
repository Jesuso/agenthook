import fs from "node:fs";
import path from "node:path";
import { readJson } from "./read-json.js";

/**
 * queue.json identity: kind + ref + stepId (entries written before `merge` jobs have no
 * kind → pipeline); a `ci` job is one per run+attempt, so its dedupKey too.
 * @param {import('../types.js').Job} a @param {import('../types.js').Job} b
 */
const sameQueued = (a, b) =>
  (a.kind ?? "pipeline") === (b.kind ?? "pipeline") && a.ref === b.ref && a.stepId === b.stepId &&
  (a.kind !== "ci" || a.dedupKey === b.dedupKey);

/**
 * jobs waiting in the queue (queue.json), insertion-ordered, deduped by kind:ref:stepId
 * (kind keeps a `merge` job and the pipeline job for its completeOnMerge step apart).
 * `front`: a harness-breaker requeue goes back to index 0, so a restart keeps its place.
 * @param {string} dataDir
 * @returns {Pick<import('../types.js').Store, 'addQueued'|'removeQueued'|'listQueued'>}
 */
export function queueSlice(dataDir) {
  const queueFile = path.join(dataDir, "queue.json");

  return {
    addQueued: (job, { front = false } = {}) => {
      /** @type {import("../types.js").Job[]} */
      const l = readJson(queueFile, []);
      if (l.some((j) => sameQueued(j, job))) return;
      const entry = { ...job, queuedAt: job.queuedAt ?? new Date().toISOString() };
      if (front) l.unshift(entry);
      else l.push(entry);
      fs.writeFileSync(queueFile, JSON.stringify(l));
    },
    removeQueued: (job) => {
      /** @type {import("../types.js").Job[]} */
      const l = readJson(queueFile, []);
      const n = l.filter((j) => !sameQueued(j, job));
      if (n.length !== l.length) fs.writeFileSync(queueFile, JSON.stringify(n));
    },
    listQueued: () => readJson(queueFile, []),
  };
}
