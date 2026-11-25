// Shared fixtures for the github-*.test.js files (split from the former github.test.js
// so no single test file costs ~75K of tokens to read). Not matched by the
// `test/*.test.js` glob `npm test` runs, so it is never itself executed as a test file.
import { createGithubAdapter } from "../src/trackers/github.js";

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

export const pipeline = [{ id: "code", sourceLabel: "agent:code", successLabel: "agent:review", failureLabel: "agent:blocked" }];

/** Build an adapter. Defaults to assigneeFilter:false so routing needs no /user fetch. */
export function adapter(pc = {}) {
  const providerConfig = { type: "github", token: "t", repository: "o/r", assigneeFilter: false, ...pc };
  return createGithubAdapter(/** @type {any} */ ({ trigger: "@agent", pipeline, providerConfig }), /** @type {any} */ (makeStore()));
}

/** @param {object} ev @param {Record<string,string>} [headers] */
export function evt(ev, headers = {}) {
  return { pathname: "/github/", headers: { "x-github-event": "issues", ...headers }, rawBody: JSON.stringify(ev) };
}

/** Stub fetch so blocked_by/blocking (and any other call) return the given fixtures, else an empty 200. */
export function withDeps(/** @type {(url:string)=>any} */ route) {
  const orig = global.fetch;
  // @ts-ignore - test stub
  global.fetch = async (url) => route(String(url)) ?? /** @type {any} */ ({ ok: true, status: 200, json: async () => [] });
  return () => {
    global.fetch = orig;
  };
}

// Used by both the `@agent` comment-trigger tests and the GitHub App auth tests.
export const heldPipeline = [
  { id: "triage", sourceLabel: "agent:triage", successLabel: "agent:code", failureLabel: "agent:blocked", holdLabel: "agent:held" },
  { id: "code", sourceLabel: "agent:code", successLabel: "agent:review", failureLabel: "agent:blocked", holdLabel: "agent:held" },
];
