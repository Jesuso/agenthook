// Conformance fixture: GitHub Projects v2 (Status-option-bound steps over GraphQL,
// x-hub-signature-256, `viewer` as "us"). See test/conformance/tracker.js for the fixture contract.
import { createGithubProjectsAdapter } from "../../../src/trackers/github-projects.js";
import { ok, hmacHex, bodyOf } from "../../conformance/http.js";

export const name = "github-projects";
export const create = createGithubProjectsAdapter;
export const webhooks = true;
export const handshake = false;
export const assigneeScoped = true;
export const resume = false; // no `@agent` comment path on Projects v2

const SECRET = "projects-hook-secret";
const US = "agent-bot";
const STATUSES = ["Triage", "Code", "Review", "Blocked", "Held", "Backlog"];
const STATUS_FIELD = "PVTSSF_status";

/** #7 = ours, #8 = someone else's (both in Code); #9 = ours, in the Backlog queue. */
const CARDS = [
  { n: 7, status: "Code", assignee: US },
  { n: 8, status: "Code", assignee: "someone-else" },
  { n: 9, status: "Backlog", assignee: US },
];
export const refs = { ours: "7", notOurs: "8" };

export function makeCfg() {
  return {
    trigger: "@agent",
    pipeline: [
      { id: "triage", sourceStatus: "Triage", successStatus: "Code", failureStatus: "Blocked", holdStatus: "Held", queueStatus: "Backlog" },
      { id: "code", sourceStatus: "Code", successStatus: "Review", failureStatus: "Blocked", holdStatus: "Held" },
      { id: "review", manual: true, sourceStatus: "Review" },
    ],
    // No assigneeLogin: "us" is the GraphQL `viewer`, so the ownership lookup is a real fetch.
    providerConfig: { type: "github-projects", token: "t", project: "acme/3", webhookSecret: SECRET },
  };
}

/** A project item node in the ITEM_FIELDS shape. @param {{n: number, status: string, assignee: string}} c */
const node = (c) => ({
  id: `PVTI_${c.n}`,
  content: {
    __typename: "Issue", id: `I_${c.n}`, number: c.n, title: `Issue ${c.n}`, body: "", url: `https://github.com/acme/widgets/issues/${c.n}`, state: "OPEN",
    assignees: { nodes: [{ login: c.assignee }] }, issueType: null, labels: { nodes: [] }, repository: { nameWithOwner: "acme/widgets" }, parent: null,
  },
  status: { name: c.status },
});

/** @param {string} url @param {any} init */
export function fetch(url, init) {
  if (url !== "https://api.github.com/graphql") return undefined;
  const { query, variables } = JSON.parse(init.body);
  if (query.includes("updateProjectV2ItemFieldValue")) return ok({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: variables.item } } } });
  if (query.includes("organization(login")) return ok({ data: { organization: { projectV2: { id: "PVT_3" } }, user: null } });
  if (query.includes("viewer{ login")) return ok({ data: { viewer: { login: US } } });
  if (query.includes("ProjectV2FieldCommon")) return ok({ data: { node: { name: "Status" } } });
  if (query.includes('field(name:"Status")')) return ok({ data: { node: { field: { id: STATUS_FIELD, name: "Status", options: STATUSES.map((s) => ({ id: `opt-${s}`, name: s })) } } } });
  if (query.includes("items(first:100")) return ok({ data: { node: { items: { nodes: CARDS.map(node), pageInfo: { hasNextPage: false, endCursor: null } } } } });
  if (query.includes("on ProjectV2Item {")) {
    const c = CARDS.find((x) => `PVTI_${x.n}` === variables.id);
    return ok({ data: { node: c ? node(c) : null } });
  }
  return ok({ data: {} });
}

/** The Status the last updateProjectV2ItemFieldValue set on `ref`'s card. @param {any} env @param {string} ref */
export function stageOf(env, ref) {
  /** @type {string|null} */
  let stage = null;
  for (const c of env.calls) {
    const b = bodyOf(c);
    if (b?.query?.includes("updateProjectV2ItemFieldValue") && b.variables.item === `PVTI_${ref}`) stage = String(b.variables.option).replace(/^opt-/, "");
  }
  return stage;
}

/** A signed `projects_v2_item` delivery of `ev`. @param {any} ev @param {string} [secret] */
const signed = (ev, secret = SECRET) => {
  const raw = JSON.stringify(ev);
  return { pathname: "/github-projects/", headers: { "x-github-event": "projects_v2_item", "x-github-delivery": "d-1", "x-hub-signature-256": `sha256=${hmacHex(secret, raw)}` }, rawBody: raw };
};
const ping = { action: "reordered", projects_v2_item: { node_id: "PVTI_1" } };
export const signedRequest = () => signed(ping);
export const badSignatureRequest = () => signed(ping, "wrong");

/** A Status edit on `n`'s card. @param {number} n */
const statusEdited = (n) =>
  signed({ action: "edited", projects_v2_item: { node_id: `PVTI_${n}`, content_type: "Issue" }, changes: { field_value: { field_type: "single_select", field_node_id: STATUS_FIELD } } });
export const ourEvent = () => ({ ctx: statusEdited(7), expect: { stepId: "code", ref: "7" } });
export const notOursEvent = () => statusEdited(8);
