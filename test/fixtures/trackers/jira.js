// Conformance fixture: Jira (status-bound steps, transitions, x-hub-signature HMAC, /myself as "us").
// See test/conformance/tracker.js for the fixture contract.
import { createJiraAdapter } from "../../../src/trackers/jira.js";
import { ok, respond, hmacHex, bodyOf } from "../../conformance/http.js";

export const name = "jira";
export const create = createJiraAdapter;
export const webhooks = true;
export const handshake = false;
export const assigneeScoped = true;

const SECRET = "jira-hook-secret";
const US = "acc-bot";
const BASE = "https://acme.atlassian.net/rest/api/2";
const STATUSES = ["Triage", "Code", "Review", "Blocked", "Held", "Backlog"];

/** CAH-1 = ours, CAH-2 = someone else's (both in Code); CAH-3 = ours, in the Backlog queue. */
const ISSUES = {
  "CAH-1": { status: "Code", assignee: US },
  "CAH-2": { status: "Code", assignee: "acc-other" },
  "CAH-3": { status: "Backlog", assignee: US },
};
export const refs = { ours: "CAH-1", notOurs: "CAH-2" };

export function makeCfg() {
  return {
    trigger: "@agent",
    pipeline: [
      { id: "triage", sourceStatus: "Triage", successStatus: "Code", failureStatus: "Blocked", holdStatus: "Held", queueStatus: "Backlog" },
      { id: "code", sourceStatus: "Code", successStatus: "Review", failureStatus: "Blocked", holdStatus: "Held" },
      { id: "review", manual: true, sourceStatus: "Review" },
    ],
    // No assigneeAccountId: "us" is derived from /myself, so the ownership lookup is a real fetch.
    providerConfig: { type: "jira", token: "t", email: "bot@example.com", site: "acme", projectKey: "CAH", webhookSecret: SECRET },
  };
}

/** @param {string} key */
const issue = (key) => {
  const it = ISSUES[/** @type {keyof typeof ISSUES} */ (key)];
  return {
    key,
    fields: {
      summary: `Issue ${key}`,
      description: "",
      status: { name: it.status, statusCategory: { key: "indeterminate" } },
      assignee: { accountId: it.assignee },
      issuetype: { name: "Task", hierarchyLevel: 0 },
    },
  };
};

/** @param {string} url @param {any} init */
export function fetch(url, init) {
  if (!url.startsWith(BASE)) return undefined;
  const u = new URL(url);
  const p = u.pathname.replace(/^\/rest\/api\/2/, "");
  const method = String(init.method || "GET").toUpperCase();
  let m;
  if (p === "/myself") return ok({ accountId: US });
  if ((m = p.match(/^\/issue\/([^/]+)\/transitions$/))) {
    if (method === "POST") return respond(204);
    return ok({ transitions: STATUSES.map((s) => ({ id: `t-${s}`, to: { name: s } })) });
  }
  if (p.match(/^\/issue\/[^/]+\/assignee$/)) return respond(204);
  if ((m = p.match(/^\/issue\/([^/]+)$/))) return m[1] in ISSUES ? ok(issue(m[1])) : respond(404, {});
  if (p === "/search/jql") {
    const status = /status = "([^"]+)"/.exec(u.searchParams.get("jql") || "")?.[1];
    const keys = Object.keys(ISSUES).filter((k) => ISSUES[/** @type {keyof typeof ISSUES} */ (k)].status === status);
    return ok({ issues: keys.map(issue), isLast: true });
  }
  if (p === "/project/CAH/statuses") return ok([{ name: "Task", statuses: STATUSES.map((s) => ({ name: s })) }]);
  return undefined;
}

/** The status the last transition POST moved `ref` to. @param {any} env @param {string} ref */
export function stageOf(env, ref) {
  /** @type {string|null} */
  let stage = null;
  for (const c of env.calls) {
    if (c.method === "POST" && c.url === `${BASE}/issue/${ref}/transitions`) stage = String(bodyOf(c)?.transition?.id).replace(/^t-/, "");
  }
  return stage;
}

/** A signed delivery of `ev`. @param {any} ev */
const signed = (ev) => {
  const raw = JSON.stringify(ev);
  return { pathname: "/jira/", headers: { "x-hub-signature": `sha256=${hmacHex(SECRET, raw)}` }, rawBody: raw };
};
const ping = { webhookEvent: "jira:issue_updated", issue: { key: "CAH-9", fields: {} } };
export const signedRequest = () => signed(ping);
export const badSignatureRequest = () => ({ ...signed(ping), headers: { "x-hub-signature": `sha256=${hmacHex("wrong", JSON.stringify(ping))}` } });

/** A status-change delivery moving `key` into Code. @param {string} key */
const movedToCode = (key) =>
  signed({
    webhookEvent: "jira:issue_updated",
    issue: issue(key),
    changelog: { id: `cl-${key}`, items: [{ field: "status", fieldId: "status", fromString: "Triage", toString: "Code" }] },
  });
export const ourEvent = () => ({ ctx: movedToCode("CAH-1"), expect: { stepId: "code", ref: "CAH-1" } });
export const notOursEvent = () => movedToCode("CAH-2");
