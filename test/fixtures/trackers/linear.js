// Conformance fixture: Linear (team-workflow-state-bound steps over GraphQL, linear-signature
// HMAC + webhookTimestamp, `viewer` as "us"). See test/conformance/tracker.js for the fixture contract.
import { createLinearAdapter } from "../../../src/trackers/linear.js";
import { ok, hmacHex, bodyOf } from "../../conformance/http.js";

export const name = "linear";
export const create = createLinearAdapter;
export const webhooks = true;
export const handshake = false;
export const assigneeScoped = true;

const SECRET = "linear-hook-secret";
const US = "user-bot";
const TEAM = "team-eng";
const STATES = ["Triage", "Code", "Review", "Blocked", "Held", "Backlog"];

/** ENG-1 = ours, ENG-2 = someone else's (both in Code); ENG-3 = ours, in the Backlog queue. */
const ISSUES = {
  "ENG-1": { state: "Code", assignee: US },
  "ENG-2": { state: "Code", assignee: "user-other" },
  "ENG-3": { state: "Backlog", assignee: US },
};
export const refs = { ours: "ENG-1", notOurs: "ENG-2" };

export function makeCfg() {
  return {
    trigger: "@agent",
    pipeline: [
      { id: "triage", sourceStatus: "Triage", successStatus: "Code", failureStatus: "Blocked", holdStatus: "Held", queueStatus: "Backlog" },
      { id: "code", sourceStatus: "Code", successStatus: "Review", failureStatus: "Blocked", holdStatus: "Held" },
      { id: "review", manual: true, sourceStatus: "Review" },
    ],
    providerConfig: { type: "linear", token: "lin_api_t", team: "ENG", webhookSecret: SECRET },
  };
}

/** @param {string} key */
const issue = (key) => {
  const it = ISSUES[/** @type {keyof typeof ISSUES} */ (key)];
  return {
    id: `uuid-${key}`,
    identifier: key,
    title: `Issue ${key}`,
    description: "",
    url: `https://linear.app/acme/issue/${key}`,
    sortOrder: Number(key.split("-")[1]),
    assignee: { id: it.assignee },
    state: { id: `st-${it.state}`, name: it.state, type: "started" },
  };
};

/** @param {string} url @param {any} init */
export function fetch(url, init) {
  if (url !== "https://api.linear.app/graphql") return undefined;
  const { query, variables } = JSON.parse(init.body);
  if (query.includes("issueUpdate")) return ok({ data: { issueUpdate: { success: true } } });
  if (query.includes("viewer{ id }")) return ok({ data: { viewer: { id: US } } });
  if (query.includes("teams(filter")) {
    const nodes = STATES.map((s, i) => ({ id: `st-${s}`, name: s, type: "started", position: i }));
    return ok({ data: { teams: { nodes: [{ id: TEAM, key: "ENG", name: "Engineering", states: { nodes } }] } } });
  }
  if (query.includes("issues(first:100")) {
    const keys = Object.keys(ISSUES).filter((k) => `st-${ISSUES[/** @type {keyof typeof ISSUES} */ (k)].state}` === variables.state);
    return ok({ data: { issues: { nodes: keys.map(issue) } } });
  }
  if (query.includes("issue(id:")) {
    const key = String(variables.id).replace(/^uuid-/, "");
    return ok({ data: { issue: key in ISSUES ? issue(key) : null } });
  }
  return ok({ data: {} });
}

/** The state the last issueUpdate set on `ref`. @param {any} env @param {string} ref */
export function stageOf(env, ref) {
  /** @type {string|null} */
  let stage = null;
  for (const c of env.calls) {
    const b = bodyOf(c);
    if (b?.query?.includes("issueUpdate") && b.variables.id === ref && b.variables.input?.stateId) stage = String(b.variables.input.stateId).replace(/^st-/, "");
  }
  return stage;
}

/** A signed delivery of `ev`, stamped now. @param {any} ev @param {string} [secret] */
const signed = (ev, secret = SECRET) => {
  const raw = JSON.stringify({ ...ev, webhookTimestamp: Date.now() });
  return { pathname: "/linear/", headers: { "linear-signature": hmacHex(secret, raw) }, rawBody: raw };
};
const ping = { action: "update", type: "Issue", data: { id: "uuid-9", identifier: "ENG-9" } };
export const signedRequest = () => signed(ping);
export const badSignatureRequest = () => signed(ping, "wrong");

/** A state-change delivery moving `key` into Code. @param {string} key */
const movedToCode = (key) => {
  const it = ISSUES[/** @type {keyof typeof ISSUES} */ (key)];
  return signed({
    action: "update",
    type: "Issue",
    data: { id: `uuid-${key}`, identifier: key, teamId: TEAM, stateId: "st-Code", assigneeId: it.assignee, updatedAt: "2026-10-18T12:00:00.000Z" },
    updatedFrom: { stateId: "st-Triage", updatedAt: "2026-10-18T11:00:00.000Z" },
  });
};
export const ourEvent = () => ({ ctx: movedToCode("ENG-1"), expect: { stepId: "code", ref: "ENG-1" } });
export const notOursEvent = () => movedToCode("ENG-2");
