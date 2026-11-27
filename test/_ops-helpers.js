// Shared fixtures for the ops-*.test.js files (split from the former ops.test.js
// so no single test file costs too much context to read — see #717 precedent with
// dispatch.test.js). Not matched by the `test/*.test.js` glob `npm test` runs, so
// it is never itself executed as a test file.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createOps } from "../src/ops.js";
import { createStore } from "../src/store/index.js";
import { createQueue } from "../src/queue.js";

/** @param {{adapter?: any, forge?: any, locked?: boolean, pipeline?: any[], killed?: Set<string>, tracker?: any, onEpicChanged?: (reset: () => void) => void, reload?: () => Promise<{changed: string[], note: string}>}} [o] */
export function setup({ adapter = {}, forge = null, locked = false, pipeline, killed = new Set(), accept = true, queueRun, tracker, onEpicChanged, harnessing, reload } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthook-ops-"));
  const cfg = /** @type {any} */ ({
    name: "t",
    provider: "github",
    stateDir: dir,
    dataDir: dir,
    tracker,
    pipeline: pipeline ?? [{ id: "triage", queueLabel: "backlog" }, { id: "code" }, { id: "done", manual: true }],
  });
  const store = createStore(dir);
  /** @type {any[]} */ const intaken = [];
  /** @type {any[]} */ const events = [];
  /** @type {any[]} */ const beats = [];
  const queue = createQueue(1, queueRun ?? (() => new Promise(() => {})), undefined, { onAdd: (j) => store.addQueued(j), onRemove: (j) => store.removeQueued(j) }, {}, harnessing);
  /** @type {string[]} */ const pulls = [];
  /** @type {string[]} */ const left = [];
  const ops = createOps({
    cfg, store, forge, queue,
    leavePipeline: (ref) => left.push(ref),
    adapter: /** @type {any} */ (adapter),
    cancelRun: (ref) => killed.has(ref),
    intake: (jobs, o) => (intaken.push([jobs, o]), accept ? jobs.length : 0),
    emit: (e, ref, step, x) => events.push([e, ref, step, x]),
    heartbeat: { update: (p) => beats.push(p) },
    pull: async () => void pulls.push("pull"),
    isLocked: () => locked,
    onEpicChanged,
    reload,
  });
  const audit = () => fs.readFileSync(path.join(dir, "control-audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  return { dir, cfg, store, queue, ops, intaken, events, beats, audit, pulls, left };
}
