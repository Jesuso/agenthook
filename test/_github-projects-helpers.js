// Shared fixtures for the github-projects-*.test.js files (split from the former
// github-projects.test.js so no single test file costs ~54K bytes to read — see #738). Not
// matched by the `test/*.test.js` glob `npm test` runs, so it is never itself executed as a
// test file.
import { createGithubProjectsAdapter } from "../src/trackers/github-projects.js";

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

export const pipeline = [{ id: "code", sourceStatus: "In Progress", successStatus: "In Review", failureStatus: "Blocked" }];

/** Build an adapter. Defaults to assigneeFilter:false so routing needs no `viewer` fetch. */
export function adapter(pc = {}) {
  const providerConfig = { type: "github-projects", token: "t", project: "acme/7", assigneeFilter: false, ...pc };
  return createGithubProjectsAdapter(/** @type {any} */ ({ trigger: "@agent", pipeline, providerConfig }), /** @type {any} */ (makeStore()));
}

export const PROJECT_ID = "PVT_proj";
export const STATUS_FIELD_ID = "PVTSSF_status";
export const STATUS_OPTIONS = { "In Progress": "opt_inprog", "In Review": "opt_review", Blocked: "opt_blocked" };

/** A fetch stub that answers each GraphQL operation by matching its query text. `opts`
 * tunes the canned item: its Status, assignee logins, viewer login. Returns the captured
 * mutation variables (or null) so advance assertions can read what was set. */
export function stubGraphql(opts = {}) {
  const { status = "In Progress", assignees = [], viewer = "bot", items, comments } = opts;
  const captured = { mutation: /** @type {any} */ (null), assigned: /** @type {any} */ (null), added: /** @type {any} */ (null), calls: 0 };
  const orig = global.fetch;
  const issueNode = {
    __typename: "Issue",
    id: "I_42",
    number: 42,
    title: "Wire up the thing",
    body: "do it",
    url: "https://github.com/acme/repo/issues/42",
    state: "OPEN",
    assignees: { nodes: assignees.map((/** @type {string} */ login) => ({ login })) },
  };
  const itemNodes = items || [{ id: "PVTI_42", content: issueNode, status: status ? { name: status } : null }];
  // @ts-ignore - test stub
  global.fetch = async (_url, init = {}) => {
    captured.calls++;
    const q = JSON.parse(String(init.body)).query;
    const vars = JSON.parse(String(init.body)).variables;
    /** @param {any} data */
    const ok = (data) => /** @type {any} */ ({ ok: true, status: 200, json: async () => ({ data }) });
    if (q.includes("updateProjectV2ItemFieldValue")) {
      captured.mutation = vars;
      return ok({ updateProjectV2ItemFieldValue: { projectV2Item: { id: vars.item } } });
    }
    if (q.includes("addAssigneesToAssignable")) {
      captured.assigned = vars;
      return ok({ addAssigneesToAssignable: { clientMutationId: "x" } });
    }
    if (q.includes("addProjectV2ItemById")) {
      captured.added = vars;
      return ok({ addProjectV2ItemById: { item: { id: "PVTI_new" } } });
    }
    if (q.includes("repository(owner")) return ok({ repository: { issue: { id: "I_new" } } });
    if (q.includes("items(first:100")) return ok({ node: { items: { nodes: itemNodes, pageInfo: { hasNextPage: false, endCursor: null } } } });
    if (q.includes("ProjectV2FieldCommon")) {
      // Resolve a field node id -> name. STATUS_FIELD_ID and the same-field-under-a-
      // different-id alias both name "Status"; a real other field names itself; an
      // unknown id resolves to null (caller falls through with a warning).
      const NAMES = /** @type {Record<string,string>} */ ({ [STATUS_FIELD_ID]: "Status", PVTSSF_status_alt: "Status", PVTSSF_priority: "Priority" });
      return ok({ node: { name: NAMES[vars.id] ?? null } });
    }
    if (q.includes("ProjectV2SingleSelectField")) {
      return ok({ node: { field: { id: STATUS_FIELD_ID, name: "Status", options: Object.entries(STATUS_OPTIONS).map(([name, id]) => ({ id, name })) } } });
    }
    if (q.includes("fieldValueByName")) return ok({ node: { id: itemNodes[0].id, content: issueNode, status: status ? { name: status } : null } });
    if (q.includes("comments(last:100")) return ok({ node: { comments: { nodes: comments ?? [] } } });
    if (q.includes("viewer")) return ok({ viewer: { login: viewer, id: "U_bot" } });
    if (q.includes("projectV2(number")) return ok({ organization: { projectV2: { id: PROJECT_ID } }, user: null });
    return ok({});
  };
  return { captured, restore: () => (global.fetch = orig) };
}

/** A `projects_v2_item` webhook delivery context. */
export function evt(ev, headers = {}) {
  return { pathname: "/github-projects/", headers: { "x-github-event": "projects_v2_item", ...headers }, rawBody: JSON.stringify(ev) };
}
