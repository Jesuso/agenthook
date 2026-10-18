// Conformance fixture: local/offline tracker (a JSON board in dataDir). No network, no
// webhooks, no assignee scoping by design — the capability flags skip those checks.
// See test/conformance/tracker.js for the fixture contract.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLocalAdapter, localBoardPath } from "../../../src/trackers/local.js";

export const name = "local";
export const create = createLocalAdapter;
export const webhooks = false;
export const handshake = false;
export const assigneeScoped = false;
export const resume = false; // no `@agent` comment path on the local board
// No `fetch`: the adapter must never touch the network.

export const refs = { ours: "L1" };

export function makeCfg() {
  return {
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "ah-conformance-local-")),
    trigger: "@agent",
    pipeline: [
      { id: "triage", sourceStatus: "triage", successStatus: "code", failureStatus: "blocked", holdStatus: "held", queueStatus: "backlog" },
      { id: "code", sourceStatus: "code", successStatus: "review", failureStatus: "blocked", holdStatus: "held" },
      { id: "review", manual: true, sourceStatus: "review" },
    ],
    providerConfig: { type: "local" },
  };
}

/** L1 rests in code; L3 waits in the backlog queue. */
const SEEDED = { L1: "code", L3: "backlog" };

/** @param {any} env */
export function setup(env) {
  const board = Object.fromEntries(Object.entries(SEEDED).map(([ref, stage]) => [ref, { name: `local ${ref}`, stage }]));
  fs.writeFileSync(localBoardPath(env.cfg), JSON.stringify(board));
}

/** The stage `ref` now has on the board file, or null while it still sits where setup put it
 * (the board keeps no move history). @param {any} env @param {string} ref */
export function stageOf(env, ref) {
  const stage = JSON.parse(fs.readFileSync(localBoardPath(env.cfg), "utf8"))[ref]?.stage ?? null;
  return stage === SEEDED[/** @type {keyof typeof SEEDED} */ (ref)] ? null : stage;
}
