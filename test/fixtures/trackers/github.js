// Conformance fixture: GitHub Issues (label-bound steps, x-hub-signature-256, /user as "us").
// See test/conformance/tracker.js for the fixture contract.
import { createGithubAdapter } from "../../../src/trackers/github.js";
import { ok, notFound, hmacHex, bodyOf } from "../../conformance/http.js";

export const name = "github";
export const create = createGithubAdapter;
export const webhooks = true;
export const handshake = false;
export const assigneeScoped = true;

const SECRET = "github-hook-secret";
const US = "agent-bot";
const REPO = "https://api.github.com/repos/acme/widgets";
const L = { triage: "agent:triage", code: "agent:code", review: "agent:review", blocked: "agent:blocked", held: "agent:held", queue: "agent:queue" };

/** #7 = ours, #8 = someone else's (both labelled code); #9 = ours, queued. */
const ISSUES = {
  7: { label: L.code, assignee: US },
  8: { label: L.code, assignee: "someone-else" },
  9: { label: L.queue, assignee: US },
};
export const refs = { ours: "7", notOurs: "8" };

export function makeCfg() {
  return {
    trigger: "@agent",
    pipeline: [
      { id: "triage", sourceLabel: L.triage, successLabel: L.code, failureLabel: L.blocked, holdLabel: L.held, queueLabel: L.queue },
      { id: "code", sourceLabel: L.code, successLabel: L.review, failureLabel: L.blocked, holdLabel: L.held },
      { id: "review", manual: true, sourceLabel: L.review },
    ],
    // No assigneeLogin: "us" is derived from /user, so the ownership lookup is a real fetch.
    providerConfig: { type: "github", token: "t", repository: "acme/widgets", webhookSecret: SECRET },
  };
}

/** @param {string} n */
const issue = (n) => {
  const it = ISSUES[/** @type {keyof typeof ISSUES} */ (Number(n))];
  return { number: Number(n), title: `Issue ${n}`, body: "", html_url: `https://github.com/acme/widgets/issues/${n}`, state: "open", labels: [{ name: it.label }], assignee: { login: it.assignee }, assignees: [{ login: it.assignee }] };
};

/** @param {string} url @param {any} init */
export function fetch(url, init) {
  const method = String(init.method || "GET").toUpperCase();
  if (url === "https://api.github.com/user") return ok({ login: US });
  if (!url.startsWith(REPO)) return undefined;
  const u = new URL(url);
  const p = u.pathname.replace(/^\/repos\/acme\/widgets/, "");
  let m;
  if (p.match(/^\/issues\/\d+\/labels(\/.*)?$/) && (method === "POST" || method === "DELETE")) return ok([]);
  if (p.match(/^\/issues\/\d+\/assignees$/)) return ok({});
  if (p.match(/^\/issues\/\d+\/dependencies\/(blocked_by|blocking)$/)) return ok([]);
  if ((m = p.match(/^\/issues\/(\d+)$/)) && method === "GET") return m[1] in ISSUES ? ok(issue(m[1])) : notFound();
  if (p === "/issues") {
    const label = u.searchParams.get("labels");
    return ok(label ? Object.keys(ISSUES).filter((n) => ISSUES[/** @type {keyof typeof ISSUES} */ (Number(n))].label === label).map(issue) : []);
  }
  if (p === "/labels") return ok(Object.values(L).map((name) => ({ name })));
  return undefined;
}

/** The label the last add-labels POST put on `ref`. @param {any} env @param {string} ref */
export function stageOf(env, ref) {
  /** @type {string|null} */
  let stage = null;
  for (const c of env.calls) if (c.method === "POST" && c.url === `${REPO}/issues/${ref}/labels`) stage = bodyOf(c)?.labels?.[0] ?? null;
  return stage;
}

/** A signed `issues` delivery of `ev`. @param {any} ev @param {string} [secret] */
const signed = (ev, secret = SECRET) => {
  const raw = JSON.stringify(ev);
  return { pathname: "/github/", headers: { "x-github-event": "issues", "x-github-delivery": "d-1", "x-hub-signature-256": `sha256=${hmacHex(secret, raw)}` }, rawBody: raw };
};
const ping = { action: "edited", issue: { number: 1 } };
export const signedRequest = () => signed(ping);
export const badSignatureRequest = () => signed(ping, "wrong");

/** `labeled` with the code step's source label. @param {string} n */
const labeledCode = (n) => signed({ action: "labeled", label: { name: L.code }, issue: issue(n) });
export const ourEvent = () => ({ ctx: labeledCode("7"), expect: { stepId: "code", ref: "7" } });
export const notOursEvent = () => labeledCode("8");
