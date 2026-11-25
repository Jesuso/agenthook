// Shared fixtures for the asana-*.test.js files (split from the former asana.test.js
// so no single test file costs too many tokens to read — see #738). Not matched by the
// `test/*.test.js` glob `npm test` runs, so it is never itself executed as a test file.
import { createAsanaAdapter } from "../src/trackers/asana.js";

/** Minimal in-memory Store stub. */
export function makeStore() {
  const m = new Map();
  return {
    getSecret: (k) => m.get(k),
    setSecret: (k, v) => m.set(k, v),
    secretCount: () => m.size,
    reloadSeen() {},
    hasSeen: () => false,
    markSeen() {},
    unmarkSeen() {},
    seenCount: () => 0,
    seenFile: "",
    setRunning() {},
    clearRunning() {},
    listRunning: () => ({}),
    getAttempt: () => 0,
    bumpAttempt: () => 0,
    unbumpAttempt: () => {},
    clearAttempts() {},
  };
}

/** A stubbed 200 JSON response. @param {any} data */
export const ok = (data) => /** @type {any} */ ({ ok: true, status: 200, json: async () => data });

// The default pipeline binds one `code` step; assigneeFilter:false keeps routing offline (no
// assignee gate), exactly as github-webhook.test.js sidesteps the /user lookup.
export const pipeline = [{ id: "code", sourceSectionGid: "S1", successSectionGid: "S2", failureSectionGid: "S3" }];

/** Build a pipeline-bound adapter. Defaults to assigneeFilter:false so routing needs no assignee gate.
 * @param {Record<string, any>} [pc] */
export function routed(pc = {}) {
  const providerConfig = { type: "asana", token: "t", assigneeFilter: false, ...pc };
  return createAsanaAdapter(/** @type {any} */ ({ trigger: "@agent", pipeline, providerConfig }), /** @type {any} */ (makeStore()));
}

/** Build an adapter over a custom pipeline. @param {any[]} pl @param {Record<string, any>} [pc] */
export function withPipeline(pl, pc = {}) {
  const providerConfig = { type: "asana", token: "t", assigneeFilter: false, ...pc };
  return createAsanaAdapter(/** @type {any} */ ({ trigger: "@agent", pipeline: pl, providerConfig }), /** @type {any} */ (makeStore()));
}

/** Run `fn` with global.fetch stubbed by `stub`, restoring it after.
 * @param {(url: string, init: any) => any} stub @param {() => Promise<any>} fn */
export async function withFetch(stub, fn) {
  const orig = global.fetch;
  // @ts-ignore - test stub
  global.fetch = async (url, init = {}) => stub(String(url), init);
  try {
    return await fn();
  } finally {
    global.fetch = orig;
  }
}

// Release fixture: blocker B1 completes; its dependents cover every eligibility branch.
// Only D1 (ours, open, resting in a non-manual source section, no other open blocker) fires.
export const releasePipeline = [
  { id: "code", sourceSectionGid: "S1", successSectionGid: "S2", failureSectionGid: "S3" },
  { id: "done", sourceSectionGid: "S2", manual: true },
];
export const releaseDependents = [
  { gid: "D1", completed: false, assignee: { gid: "U" }, memberships: [{ section: { gid: "S1" } }] }, // eligible
  { gid: "D2", completed: false, assignee: { gid: "OTHER" }, memberships: [{ section: { gid: "S1" } }] }, // not ours
  { gid: "D3", completed: true, assignee: { gid: "U" }, memberships: [{ section: { gid: "S1" } }] }, // completed
  { gid: "D4", completed: false, assignee: { gid: "U" }, memberships: [{ section: { gid: "S2" } }] }, // manual step's source
  { gid: "D5", completed: false, assignee: { gid: "U" }, memberships: [{ section: { gid: "ZZ" } }] }, // not a source section
  { gid: "D6", completed: false, assignee: { gid: "U" }, memberships: [{ section: { gid: "S1" } }] }, // another open blocker
];
/** @param {boolean} blockerCompleted @param {string[]} urls */
export const releaseStub = (blockerCompleted, urls) => (/** @type {string} */ u) => {
  urls.push(u);
  if (u.includes("/tasks/B1/dependents")) return ok({ data: releaseDependents });
  if (u.includes("/tasks/B1?")) return ok({ data: { completed: blockerCompleted } });
  if (u.includes("/tasks/D6/dependencies")) return ok({ data: [{ gid: "B1", completed: true }, { gid: "B2", completed: false }] });
  if (u.includes("/dependencies")) return ok({ data: [{ gid: "B1", completed: true }] });
  return ok({});
};
export const changedEvent = JSON.stringify({ events: [{ action: "changed", resource: { resource_type: "task", gid: "B1" }, change: { field: "completed", action: "changed" } }] });
