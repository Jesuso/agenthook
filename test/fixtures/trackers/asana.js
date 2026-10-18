// Conformance fixture: Asana (section-bound steps, per-path handshake secret, X-Hook-Signature).
// See test/conformance/tracker.js for the fixture contract.
import { createAsanaAdapter } from "../../../src/trackers/asana.js";
import { ok, notFound, hmacHex, bodyOf } from "../../conformance/http.js";

export const name = "asana";
export const create = createAsanaAdapter;
export const webhooks = true;
export const handshake = true;
export const assigneeScoped = true;
export const resume = true;

const SECRET = "asana-hook-secret";
const US = "U1";
const S = { triage: "S_TRIAGE", code: "S_CODE", review: "S_REVIEW", blocked: "S_BLOCKED", held: "S_HELD", backlog: "S_BACKLOG" };

/** G1 = ours, G2 = someone else's (both resting in code); G3 = ours, queued. */
const TASKS = {
  G1: { section: S.code, assignee: US },
  G2: { section: S.code, assignee: "U9" },
  G3: { section: S.backlog, assignee: US },
};
export const refs = { ours: "G1", notOurs: "G2" };

export function makeCfg() {
  return {
    trigger: "@agent",
    pipeline: [
      { id: "triage", sourceSectionGid: S.triage, successSectionGid: S.code, failureSectionGid: S.blocked, holdSectionGid: S.held, queueSectionGid: S.backlog },
      { id: "code", sourceSectionGid: S.code, successSectionGid: S.review, failureSectionGid: S.blocked, holdSectionGid: S.held },
      { id: "review", manual: true, sourceSectionGid: S.review },
    ],
    providerConfig: { type: "asana", token: "t", userGid: US, workspaceGid: "W1", projectGid: "P1" },
  };
}

/** The handshake already happened: the project hook's secret is on file. @param {any} env */
export function setup(env) {
  env.store.setSecret("/mytasks", SECRET);
}

/** @param {string} gid */
const taskData = (gid) => {
  const t = TASKS[/** @type {keyof typeof TASKS} */ (gid)];
  return { gid, name: `Task ${gid}`, notes: "", permalink_url: `https://app.asana.com/0/P1/${gid}`, completed: false, assignee: { gid: t.assignee }, memberships: [{ section: { gid: t.section } }], custom_fields: [] };
};

/** @param {string} url @param {any} init @param {any} env */
export function fetch(url, init, env) {
  const u = new URL(url);
  const p = u.pathname.replace(/^\/api\/1\.0/, "");
  const method = String(init.method || "GET").toUpperCase();
  let m;
  if ((m = p.match(/^\/sections\/([^/]+)\/addTask$/)) && method === "POST") return ok({ data: {} });
  if ((m = p.match(/^\/stories\/([^/]+)$/))) return env?.story?.gid === m[1] ? ok({ data: env.story }) : notFound();
  if ((m = p.match(/^\/sections\/([^/]+)\/tasks$/))) {
    const gid = m[1];
    return ok({ data: Object.keys(TASKS).filter((k) => TASKS[/** @type {keyof typeof TASKS} */ (k)].section === gid).map(taskData) });
  }
  if (p.match(/^\/tasks\/[^/]+\/(dependencies|dependents)$/)) return ok({ data: [] });
  if ((m = p.match(/^\/tasks\/([^/]+)$/)) && method === "GET") return m[1] in TASKS ? ok({ data: taskData(m[1]) }) : notFound();
  if (p === "/projects/P1/sections") return ok({ data: Object.values(S).map((gid) => ({ gid, name: gid })) });
  return undefined;
}

/** The section the last addTask moved `ref` into. @param {any} env @param {string} ref */
export function stageOf(env, ref) {
  /** @type {string|null} */
  let stage = null;
  for (const c of env.calls) {
    const m = c.method === "POST" && c.url.match(/\/sections\/([^/]+)\/addTask$/);
    if (m && bodyOf(c)?.data?.task === ref) stage = m[1];
  }
  return stage;
}

const body = JSON.stringify({ events: [] });
export const signedRequest = () => ({ pathname: "/mytasks/", headers: { "x-hook-signature": hmacHex(SECRET, body) }, rawBody: body });
export const badSignatureRequest = () => ({ pathname: "/mytasks/", headers: { "x-hook-signature": hmacHex("wrong", body) }, rawBody: body });
export const handshakeRequest = () => ({ pathname: "/mytasks/", headers: { "x-hook-secret": "fresh-secret" }, rawBody: "" });

/** A task-added delivery. @param {string} gid */
const added = (gid) => {
  const raw = JSON.stringify({ events: [{ action: "added", resource: { resource_type: "task", gid } }] });
  return { pathname: "/mytasks/", headers: { "x-hook-signature": hmacHex(SECRET, raw) }, rawBody: raw };
};
export const ourEvent = () => ({ ctx: added("G1"), expect: { stepId: "code", ref: "G1" } });
export const notOursEvent = () => added("G2");

/** A comment story on G1, served by fetch() off env.story. @param {any} env @param {{author: string, body: string}} o */
export function commentEvent(env, { author, body: text }) {
  env.story = { gid: "ST1", resource_subtype: "comment_added", text, target: { gid: "G1" }, created_by: { gid: author === "owner" ? US : "U9" } };
  const raw = JSON.stringify({ events: [{ action: "added", resource: { resource_type: "story", gid: "ST1" }, parent: { resource_type: "task", gid: "G1" } }] });
  return { pathname: "/mytasks/", headers: { "x-hook-signature": hmacHex(SECRET, raw) }, rawBody: raw };
}
