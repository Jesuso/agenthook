// GitHub Issues adapter — the section-driven pipeline model mapped onto issue
// LABELS. GitHub issues have no board sections, so a step binds a `sourceLabel`
// and an issue carrying that label is "in" that step. On a verdict the receiver
// SWAPS the label (remove the finished step's sourceLabel, add the target label),
// and that label change is itself the webhook event that fires the next step.
//
// Implements the same interface as asana.js (see that file for the canonical
// doc-comment). GitHub specifics:
//   - Auth: a Personal Access Token (classic or fine-grained) as `Bearer <token>`.
//     Needs `repo` (read/write issues) + `admin:repo_hook` (create the webhook),
//     or the fine-grained equivalents (Issues: RW, Webhooks: RW, Metadata: R).
//     GITHUB_TOKEN is the only secret a user supplies. Or a GitHub App (`auth: {type:
//     "app", …}`, src/github-auth.js) with the same repository permissions; then
//     assigneeLogin is required (an installation token has no user).
//   - Webhook: auto-created via REST like Asana, but signed with an agenthook-
//     GENERATED secret like Jira (or an explicit tracker.webhookSecret; `false`
//     disables verification). Verified via `x-hub-signature-256: sha256=<hex>`.
//   - One repo webhook on the `issues` event delivers opened / reopened / labeled /
//     assigned; all route to the step whose sourceLabel the issue now carries. The
//     payload's labels/assignees are a SNAPSHOT a delayed delivery can carry stale (the
//     issue may have already moved to/left a step by the time it arrives), so routing
//     re-reads the live issue rather than trusting the payload — see liveIssue below.
//     The same hook's `issue_comment` event carries the `@agent` resume: an OWNER-authored
//     comment starting with cfg.trigger on a held issue re-runs the step that held.
//   - The assignee "us" is the token owner's login, read once from /user and cached
//     (so no login is pasted). Scoping is FAIL CLOSED — see scopeToUser below.
//   - Epics: an issue is an epic when its custom type matches tracker.epicType (default
//     "Epic") or it carries tracker.epicLabel (default "epic"); its tickets are its
//     native GitHub sub-issues (ADR 0004). The same hook's `sub_issues` event and the
//     `issues` `typed`/`untyped` actions become a read-only `epic_changed` signal job
//     (see epicChangeFromEvent) — never a pipeline job, never a board write.
import crypto from "node:crypto";
import { startsWithTrigger, resumeJob } from "../pipeline.js";
import { verifyHubSignature } from "../hmac.js";
import { checkOwner, MoveRefusedError } from "./owner.js";
import { createGithubAuth, githubFetch } from "../github-auth.js";
import { githubRunCredentials, originUrl } from "../github-run-token.js";
import { parseGithubRemote } from "../forges/github.js";

/** Is `issue` an epic — its type matches `epicType`, OR it carries `epicLabel` (any
 * case). A plain parent with sub-issues but no type/label is never an epic.
 * @param {any} issue @param {string} epicType @param {string} epicLabel @returns {boolean} */
export function isEpicIssue(issue, epicType, epicLabel) {
  if (issue?.type?.name === epicType) return true;
  const want = String(epicLabel || "").trim().toLowerCase();
  if (!want) return false;
  return (issue?.labels || []).some((/** @type {any} */ l) => String(typeof l === "string" ? l : l?.name).trim().toLowerCase() === want);
}

const SUB_ISSUE_ACTIONS = new Set(["sub_issue_added", "sub_issue_removed", "parent_issue_added", "parent_issue_removed"]);

/** The epic whose structure a delivery changed, or null. Pure — drives the `epic_changed`
 * signal. `sub_issues` (any of its four actions) → the parent, only when it lives in our repo
 * AND is an epic (a plain or cross-repo parent is not an epic we list); `issues`
 * `typed`/`untyped` → the issue, when the (added/removed) type is `epicType` or the issue is
 * still an epic (e.g. via its label).
 * @param {string} kind  the `x-github-event` header @param {any} ev  the parsed payload
 * @param {{epicType: string, epicLabel: string, repoApiUrl: string}} o
 * @returns {string|null} */
export function epicChangeFromEvent(kind, ev, { epicType, epicLabel, repoApiUrl }) {
  if (kind === "sub_issues") {
    if (!SUB_ISSUE_ACTIONS.has(ev?.action)) return null;
    const parent = ev.parent_issue;
    if (parent?.number == null) return null;
    const parentRepo = parent.repository_url ?? ev.parent_issue_repo?.url;
    if (typeof parentRepo !== "string" || parentRepo.toLowerCase() !== repoApiUrl.toLowerCase()) return null;
    return isEpicIssue(parent, epicType, epicLabel) ? String(parent.number) : null;
  }
  if (kind === "issues" && (ev?.action === "typed" || ev?.action === "untyped")) {
    const issue = ev.issue;
    if (issue?.number == null || issue.pull_request) return null;
    if (ev.type?.name === epicType || isEpicIssue(issue, epicType, epicLabel)) return String(issue.number);
  }
  return null;
}

/** Rows that ARE epics (typed or labelled), PRs dropped, deduped by number. Pure —
 * drives listEpics. @param {any[]} items @param {string} epicType @param {string} epicLabel
 * @returns {import('../types.js').Epic[]} */
export function mapEpics(items, epicType, epicLabel) {
  /** @type {import('../types.js').Epic[]} */
  const out = [];
  const seen = new Set();
  for (const it of Array.isArray(items) ? items : []) {
    if (it?.pull_request) continue;
    if (!isEpicIssue(it, epicType, epicLabel)) continue;
    const ref = String(it.number);
    if (seen.has(ref)) continue;
    seen.add(ref);
    out.push({
      ref,
      name: it.title,
      url: it.html_url,
      displayId: `#${ref}`,
      status: it.state === "closed" ? "closed" : "open",
      completed: it.state === "closed",
    });
  }
  return out;
}

/** An epic's direct sub-issues mapped to EpicTicket[]. PRs dropped. Same-repo sub-issue
 * (its repository_url matches `repoApiUrl`): ref/displayId `#<n>`, stage = the original
 * casing of the first pipeline label (source/success/failure/hold/queue of any step) it
 * carries, else "" (in this tracker's view, no pipeline label yet → backlog). Other-repo
 * sub-issue: ref/displayId `<owner>/<repo>#<n>`, stage always null (outside this tracker's
 * view → untracked; also never joins a local row with the same bare number). Pure — drives
 * listEpicTickets.
 * @param {any[]} items @param {string} repoApiUrl @param {Map<string,string>} stageLabels
 * @returns {import('../types.js').EpicTicket[]} */
export function mapEpicTickets(items, repoApiUrl, stageLabels) {
  /** @type {import('../types.js').EpicTicket[]} */
  const out = [];
  for (const it of Array.isArray(items) ? items : []) {
    if (it?.pull_request) continue;
    const n = String(it.number);
    const sameRepo = typeof it.repository_url === "string" && it.repository_url.toLowerCase() === String(repoApiUrl).toLowerCase();
    let ref = n;
    let displayId = `#${n}`;
    let stage = null;
    if (!sameRepo) {
      const m = /\/repos\/([^/]+\/[^/]+)$/.exec(String(it.repository_url || ""));
      ref = displayId = `${m ? m[1] : "unknown/unknown"}#${n}`;
    } else {
      stage = "";
      for (const l of it.labels || []) {
        const name = typeof l === "string" ? l : l?.name;
        if (typeof name !== "string") continue;
        const hit = stageLabels.get(name.trim().toLowerCase());
        if (hit) {
          stage = hit;
          break;
        }
      }
    }
    out.push({ ref, displayId, name: it.title, completed: it.state === "closed", stage, url: it.html_url ?? null });
  }
  return out;
}

/**
 * Raw route keys from issue labels starting with `prefix` (case-insensitive), e.g.
 * prefix "platform:" + label "platform:ios" → "ios". Configured pipeline labels are
 * never returned. Prefix unset/blank → [].
 * @param {any} labels  issue.labels — `{name}` objects or strings
 * @param {string | undefined} prefix
 * @param {Array<string | undefined>} [pipelineLabels]
 * @returns {string[]}
 */
export function extractRouteKeys(labels, prefix, pipelineLabels = []) {
  const p = (prefix || "").trim().toLowerCase();
  if (!p || !Array.isArray(labels)) return [];
  const skip = new Set(pipelineLabels.filter(Boolean).map((l) => String(l).trim().toLowerCase()));
  /** @type {string[]} */
  const out = [];
  for (const l of labels) {
    const name = typeof l === "string" ? l : l?.name;
    if (typeof name !== "string") continue;
    if (skip.has(name.trim().toLowerCase()) || !name.trim().toLowerCase().startsWith(p)) continue;
    const key = name.trim().slice(p.length).trim();
    if (key) out.push(key);
  }
  return out;
}

/** Receiver env vars an agent of this tracker gets (#470): the env var its commentHowTo / readCommentsHowTo tell the agent to use. */
export const GITHUB_AGENT_ENV = /** @type {string[]} */ (["GITHUB_TOKEN"]);
/** The API host commentHowTo / readCommentsHowTo call: a sandboxed run's egress allows it. */
export const githubEgressHosts = () => ["api.github.com"];

/** @type {import('../types.js').AdapterFactory} */
export function createGithubAdapter(cfg, store) {
  const pc = cfg.providerConfig;
  // A personal token, or a GitHub App's installation token (src/github-auth.js). Both are
  // resolved from env/.env by loadConfig.
  const auth = createGithubAuth(pc);
  // owner/repo come from `repository: "owner/name"` or explicit owner+repo. Resolved
  // loosely so the init probe (which has only {type, token|auth}) can still call wizardSteps.
  const [owner, repo] = pc.repository ? String(pc.repository).split("/") : [pc.owner, pc.repo];
  /** @param {string} p @param {RequestInit} [init] */
  const api = (p, init = {}) =>
    githubFetch(auth, `https://api.github.com${p}`, {
      ...init,
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
        ...(init.headers || {}),
      },
    });
  // External API payloads are untyped until an adapter maps them — parse as any.
  /** @param {Response} res @returns {Promise<any>} */
  const json = (res) => res.json();
  const repoPath = () => `/repos/${owner}/${repo}`;
  const repoApiUrl = () => `https://api.github.com${repoPath()}`;
  const epicType = pc.epicType || "Epic";
  const epicLabel = pc.epicLabel || "epic";
  let typePathUnavailable = false; // set once a 422 says this repo has no issue types (personal accounts)

  /** @param {string|null|undefined} s */
  const norm = (s) => (s || "").trim().toLowerCase();

  /** Paginate an issues-list endpoint (page=1.. until a short page), capped at 10 pages.
   * @param {string} path @param {string} query @returns {Promise<any[]>} */
  async function pagedIssues(path, query) {
    /** @type {any[]} */
    const out = [];
    for (let page = 1; page <= 10; page++) {
      const res = await api(`${path}?${query}${query ? "&" : ""}per_page=100&page=${page}`);
      if (!res.ok) throw Object.assign(new Error(`list issues ${res.status}`), { status: res.status });
      const batch = (await json(res)) || [];
      out.push(...batch);
      if (batch.length < 100) break;
    }
    return out;
  }

  // Webhook secret: NEVER required of the user. An explicit tracker.webhookSecret wins
  // (and `false` disables verification — accept unsigned). Otherwise agenthook GENERATES
  // one, persists it in the profile's secret store, and sets it on the hook it creates.
  const SECRET_KEY = "github:webhookSecret";
  function webhookSecret() {
    if (pc.webhookSecret === false) return undefined; // explicit opt-out → accept unsigned
    if (typeof pc.webhookSecret === "string" && pc.webhookSecret) return pc.webhookSecret;
    let s = store.getSecret(SECRET_KEY);
    if (!s) {
      s = crypto.randomBytes(32).toString("hex");
      store.setSecret(SECRET_KEY, s);
    }
    return s;
  }

  // --- pipeline routing (opt-in; null when no pipeline configured) ---
  const pipeline = cfg.pipeline;
  // Assignee scoping — only act on issues assigned to US, where "us" is the TOKEN'S OWN
  // login, derived from /user and cached (so the user never pastes a login). An explicit
  // assigneeLogin overrides the lookup; assigneeFilter:false = repo-wide (any assignee).
  // FAIL CLOSED: if our login can't be resolved, nothing counts as ours, so a foreign
  // issue is never touched (we never silently go open). Symmetric with Asana/Jira.
  // Under GitHub App auth the installation token has no user (/user 403s), so assigneeLogin
  // — the human the App acts for — is REQUIRED (loadConfig enforces it) and never looked up.
  const scopeToUser = pc.assigneeFilter !== false;
  let cachedLogin = pc.assigneeLogin || null;
  /** @type {Promise<string>|null} */
  let loginPromise = null;
  /** The token owner's login (the bot). Fetched once from /user, then cached. The
   * PROMISE is memoised so concurrent callers share one in-flight fetch; a failure
   * clears it so a later call retries (rather than caching the rejection). */
  function ourLogin() {
    if (cachedLogin) return Promise.resolve(cachedLogin);
    if (auth.app) return Promise.reject(new Error(`GitHub App auth needs tracker.assigneeLogin`));
    if (!loginPromise) {
      loginPromise = (async () => {
        const res = await api(`/user`);
        if (!res.ok) throw new Error(`/user ${res.status}`);
        return (cachedLogin = (await json(res)).login);
      })().catch((e) => {
        loginPromise = null;
        throw e;
      });
    }
    return loginPromise;
  }
  /** @param {string|null|undefined} login → is this login us? (true when scoping off)
   * @returns {Promise<boolean>} */
  async function isOurs(login) {
    if (!scopeToUser) return true;
    try {
      return login != null && norm(login) === norm(await ourLogin());
    } catch (e) {
      console.error(`[user] could not resolve our login (failing closed):`, e instanceof Error ? e.message : e);
      return false;
    }
  }
  /** Is this comment author the token owner? STRICT and independent of assigneeFilter
   * (unlike isOurs): an `@agent` resume only counts from our own identity. An
   * unresolvable login fails closed. @param {string|null|undefined} login @returns {Promise<boolean>} */
  async function isOwner(login) {
    if (!login) return false;
    try {
      const me = await ourLogin();
      return !!me && norm(login) === norm(me);
    } catch (e) {
      console.error(`[user] could not resolve our login (failing closed):`, e instanceof Error ? e.message : e);
      return false;
    }
  }
  /** Any of an issue's assignees (issue.assignee + issue.assignees[]) is us?
   * @param {any} issue @returns {Promise<boolean>} */
  async function issueIsOurs(issue) {
    if (!scopeToUser) return true;
    const logins = [issue?.assignee?.login, ...((issue?.assignees || []).map((/** @type {any} */ a) => a?.login))];
    for (const l of logins) if (l && (await isOurs(l))) return true;
    return false;
  }

  /** @param {string} id */
  const stepById = (id) => pipeline?.find((s) => s.id === id);
  /** @param {string|null|undefined} label → the step whose sourceLabel matches (case-insensitive) */
  const stepBySourceLabel = (label) => (label ? pipeline?.find((s) => s.sourceLabel && norm(s.sourceLabel) === norm(label)) : undefined);
  /** First step whose sourceLabel appears among an issue's labels. @param {any[]} labels */
  const stepForLabels = (labels) => {
    for (const l of labels || []) {
      const step = stepBySourceLabel(typeof l === "string" ? l : l?.name);
      if (step) return step;
    }
    return undefined;
  };
  /** Every distinct label the pipeline uses (source/success/failure/hold of every step),
   * normalized → original casing. The `run` guard treats an issue carrying ANY of them
   * as already in-flight, not just a source label. */
  const pipelineLabels = () => {
    /** @type {Map<string,string>} */
    const m = new Map();
    for (const s of pipeline || []) for (const l of [s.sourceLabel, s.successLabel, s.failureLabel, s.holdLabel]) if (l) m.set(norm(l), l);
    return m;
  };

  /** @param {string} ref @param {string} label */
  async function removeLabel(ref, label) {
    const res = await api(`${repoPath()}/issues/${ref}/labels/${encodeURIComponent(label)}`, { method: "DELETE" });
    // 404 = the label wasn't on the issue; that's fine (idempotent move).
    if (!res.ok && res.status !== 404) throw new Error(`remove label ${res.status}`);
  }
  /** @param {string} ref @param {string} label */
  async function addLabel(ref, label) {
    const res = await api(`${repoPath()}/issues/${ref}/labels`, { method: "POST", body: JSON.stringify({ labels: [label] }) });
    if (!res.ok) throw new Error(`add label ${res.status}`);
  }
  /** Assign the issue to us (the token owner). POST /assignees ADDS without clobbering
   * existing assignees — so an issue becomes ours and clears the fail-closed scope gate.
   * @param {string} ref */
  async function assignToUs(ref) {
    const me = await ourLogin();
    const res = await api(`${repoPath()}/issues/${ref}/assignees`, { method: "POST", body: JSON.stringify({ assignees: [me] }) });
    if (!res.ok) throw new Error(`assign ${res.status}`);
  }

  // Fail-closed owner check gating issue MUTATION (advance/label swap). Only a 2xx
  // with a matching assignee is "ours"; a transient fetch error/5xx/429 is retried, and
  // anything still uncertain is "check_failed" (never "ours").
  /** @param {string} ref @returns {Promise<"ours"|"not_ours"|"check_failed">} */
  function ownedByUs(ref) {
    return checkOwner(async () => {
      const res = await api(`${repoPath()}/issues/${ref}`);
      if (!res.ok) return { ok: false, status: res.status };
      return { ok: true, status: res.status, mine: await issueIsOurs(await json(res)) };
    });
  }

  /**
   * Single-issue read (strongly consistent, unlike the lagging list/label index AND unlike a
   * webhook payload, which is a snapshot a delayed delivery can carry stale). `null` on any
   * fetch failure — callers fail closed.
   * @param {string} ref @returns {Promise<any|null>}
   */
  async function liveIssue(ref) {
    try {
      const res = await api(`${repoPath()}/issues/${ref}`);
      if (!res.ok) return null;
      return await json(res);
    } catch {
      return null;
    }
  }

  /** Live check: still open and still carrying `label`. @param {string} ref @param {string} label */
  async function stillRestingIn(ref, label) {
    const live = await liveIssue(ref);
    if (!live) return false;
    const want = String(label).toLowerCase();
    return live.state === "open" && (live.labels || []).some((/** @type {any} */ l) => String(typeof l === "string" ? l : l?.name).toLowerCase() === want);
  }

  // --- native GitHub issue dependencies (the block gate) ---
  // GitHub's issue dependencies are LIVE data, queried per event with no caching, so a
  // reopen, a fresh blocker, or a second blocker is always reflected. This is a WORKFLOW
  // gate, not a security boundary: on an API error we FAIL OPEN (treat as unblocked + warn)
  // so a flaky/absent dependencies API can't freeze the whole pipeline — the opposite of
  // the assignee scope, which fails closed.
  /** Open issues that BLOCK `ref` (its unresolved blockers), by number. Closed blockers
   * are dropped — only an OPEN blocker rests a dependent. @param {string} ref @returns {Promise<number[]>} */
  async function blockedBy(ref) {
    const res = await api(`${repoPath()}/issues/${ref}/dependencies/blocked_by`);
    if (!res.ok) {
      console.warn(`[blocked] could not read blocked_by for #${ref} (${res.status}) — treating as unblocked`);
      return [];
    }
    return ((await json(res)) || []).filter((/** @type {any} */ i) => i?.state === "open").map((/** @type {any} */ i) => i.number);
  }
  /** Issues that `ref` BLOCKS (its dependents) — full issue objects, so a caller reads
   * their live labels/assignees without a re-fetch. @param {string} ref @returns {Promise<any[]>} */
  async function blocking(ref) {
    const res = await api(`${repoPath()}/issues/${ref}/dependencies/blocking`);
    if (!res.ok) {
      console.warn(`[blocked] could not read blocking for #${ref} (${res.status})`);
      return [];
    }
    return (await json(res)) || [];
  }
  /** The block gate: true (and logs) when `ref` has an open blocker, so the caller rests
   * it (emits no job). @param {string} ref @returns {Promise<boolean>} */
  async function restIfBlocked(ref) {
    const blockers = await blockedBy(ref);
    if (!blockers.length) return false;
    console.log(`[blocked] #${ref} blocked by ${blockers.map((n) => `#${n}`).join(", ")} — resting`);
    return true;
  }

  /** Create any pipeline label missing from the repo. GitHub refuses to ADD a label
   * to an issue unless that label already exists in the repo, so a fresh repo can't
   * run the pipeline until every source/success/failure/hold label exists. We create
   * them up front — idempotent: an already-present label answers 422 (ignored). This
   * is the GitHub analog of filling in Asana's section gids, done for you. */
  async function ensureLabels() {
    if (!pipeline) return;
    // Dedup case-insensitively (norm key) but POST the original casing.
    /** @type {Map<string, string>} */
    const wanted = new Map();
    for (const step of pipeline) {
      for (const label of [step.sourceLabel, step.successLabel, step.failureLabel, step.holdLabel, step.queueLabel]) {
        if (label) wanted.set(norm(label), label);
      }
    }
    for (const label of wanted.values()) {
      const res = await api(`${repoPath()}/labels`, {
        method: "POST",
        body: JSON.stringify({ name: label, color: "ededed", description: "agenthook pipeline label" }),
      });
      if (res.ok) {
        console.log(`[label] created "${label}"`);
        continue;
      }
      if (res.status === 422) continue; // already exists — fine
      const body = await json(res).catch(() => ({}));
      console.warn(`[label] could not create "${label}" (${res.status}): ${JSON.stringify(body)}`);
    }
  }

  /** Delete every repo webhook whose target URL is one of ours (path ends `/github/`).
   * Scoped to our own path so we never disturb unrelated hooks on the repo. */
  async function deleteOurHooks() {
    const res = await api(`${repoPath()}/hooks?per_page=100`);
    if (!res.ok) throw Object.assign(new Error(`list hooks ${res.status}`), { status: res.status });
    for (const h of (await json(res)) || []) {
      const url = h?.config?.url || "";
      if (url.replace(/\/$/, "").endsWith("/github")) {
        await api(`${repoPath()}/hooks/${h.id}`, { method: "DELETE" });
        console.log(`  deleted webhook ${h.id} -> ${url}`);
      }
    }
  }

  /** The `@agent` comment trigger. Emits a resume job only when ALL hold (anything
   * uncertain → no job): a newly created comment on an issue (not a PR), whose body
   * starts with cfg.trigger, authored by the token owner (strict — assigneeFilter:false
   * does NOT open this up), on an issue that passes the assignee gate, which is held on
   * a runnable step still under its attempt cap (resumeJob).
   * @param {any} ev @param {string} ref @returns {Promise<import('../types.js').Job[]>} */
  async function resumeFromComment(ev, ref) {
    if (ev.action !== "created") return [];
    if (ev.issue.pull_request) return []; // issue_comment also fires for PR conversation comments
    const c = ev.comment;
    if (c?.id == null || !startsWithTrigger(cfg.trigger, c.body)) return [];
    if (!(await isOwner(c.user?.login))) {
      console.log(`[trigger] #${ref}: comment ${c.id} not by our login — ignoring`);
      return [];
    }
    if (!(await issueIsOurs(ev.issue))) {
      console.log(`[trigger] #${ref}: not assigned to us — ignoring`);
      return [];
    }
    const job = resumeJob(cfg, store, ref, String(c.id), c.body);
    return job ? [job] : [];
  }

  // The repo's existing labels — live. Shared by the init wizard's stage picks (which
  // prepend the agenthook DEFAULTS as a nicety) and listStages (existing labels only —
  // boot's ensureLabels() already creates every pipeline label, so those aren't synthetic).
  /** @param {string|undefined} o @param {string|undefined} r @returns {Promise<import('../types.js').StageOption[]>} */
  const fetchLabels = async (o, r) => {
    if (!o || !r) throw new Error("github: no repository configured");
    const res = await api(`/repos/${o}/${r}/labels?per_page=100`);
    if (!res.ok) throw new Error(`GitHub labels ${res.status}`);
    return ((await json(res)) || []).map((/** @type {any} */ l) => ({ id: l.name, label: l.name }));
  };

  return {
    describe: () => ({
      platform: "GitHub",
      taskNoun: "issue",
      trigger: cfg.trigger,
      // `--repo`: the agent's cwd may be another repo (multi-repo, or repo.path for triage).
      commentHowTo: `post a comment with: gh issue comment <number> --repo ${owner}/${repo} --body "<text>" (gh is already authenticated)`,
      readCommentsHowTo: `gh issue view <number> --repo ${owner}/${repo} --comments`,
      agentEnv: GITHUB_AGENT_ENV,
      egressHosts: githubEgressHosts(),
      ...(pc.assigneeLogin ? { ownerHint: `@${pc.assigneeLogin}` } : {}),
      stageKeys: { source: "sourceLabel", success: "successLabel", failure: "failureLabel", hold: "holdLabel", queue: "queueLabel" },
    }),

    listStages: () => fetchLabels(owner, repo),

    // Under App auth each agent run gets its own token scoped to the issue's repo and the
    // routed checkout's `origin` (#474).
    runCredentials: githubRunCredentials(pc, cfg, { codeRepo: (p) => parseGithubRemote(originUrl(p)), issueRepo: owner && repo ? `${owner}/${repo}` : null }),

    // No handshake. With a secret: verify the HMAC. Without one (webhookSecret:false):
    // accept. Sync + no network so the receiver ACKs inside GitHub's 10s window.
    authenticate({ rawBody, headers }) {
      const secret = webhookSecret();
      if (!secret) return { type: "accept" };
      if (!verifyHubSignature(secret, rawBody, headers["x-hub-signature-256"])) {
        console.warn("[reject] bad/absent x-hub-signature-256");
        return { type: "reject" };
      }
      return { type: "accept" };
    },

    // One GitHub delivery = one event object. The `X-GitHub-Event` header names the
    // type (we care about `issues` + `issue_comment`; `ping` on hook-create is ACKed and
    // ignored). We route:
    //   opened/reopened/assigned → the step whose sourceLabel the LIVE issue carries
    //                              (state-based key `step:<id>:<ref>` — idempotent). A
    //                              delayed delivery whose payload labels are stale (the
    //                              issue already moved on) yields no job.
    //   labeled                  → the step whose sourceLabel was just added, reconfirmed
    //                              against the live issue so a delayed delivery that
    //                              arrives after the issue left that label is a no-op
    //                              (event-based key `secmove:<delivery>` — a later
    //                              re-add of the same label fires again; retries dedup).
    //   closed                   → close-release of unblocked dependents, plus a signal-only
    //                              `board_done` for the closed issue when it is ours (key
    //                              `done:<delivery>`).
    //   issue_comment created    → the `@agent` resume of the issue's held step
    //                              (key `trigger:<comment.id>`; see resumeFromComment).
    //   sub_issues (all actions),
    //   issues typed/untyped     → a read-only `epic_changed` signal for the epic (key
    //                              `epic:<delivery>`; see epicChangeFromEvent) — the engine
    //                              emits it outside the queue. Never a pipeline job.
    async processEvents({ headers, rawBody }) {
      const kind = norm(Array.isArray(headers["x-github-event"]) ? headers["x-github-event"][0] : headers["x-github-event"]);
      if (kind !== "issues" && kind !== "issue_comment" && kind !== "sub_issues") return [];
      let ev;
      try {
        ev = JSON.parse(rawBody);
      } catch (e) {
        console.error("[parse]", e instanceof Error ? e.message : e);
        return [];
      }
      // Before the `ev.issue` check: a sub_issues payload carries parent_issue/sub_issue, no issue.
      if (kind === "sub_issues" || (kind === "issues" && (ev.action === "typed" || ev.action === "untyped"))) {
        const epicRef = epicChangeFromEvent(kind, ev, { epicType, epicLabel, repoApiUrl: repoApiUrl() });
        if (!epicRef) return [];
        const delivery = Array.isArray(headers["x-github-delivery"]) ? headers["x-github-delivery"][0] : headers["x-github-delivery"];
        const dedupKey = `epic:${delivery || `${epicRef}:${ev.action}:${ev.sub_issue?.id ?? ""}`}`;
        return [{ kind: "epic_changed", ref: epicRef, stepId: "", dedupKey }];
      }
      const issue = ev.issue;
      if (issue?.number == null) return [];
      const ref = String(issue.number);

      if (kind === "issue_comment") return resumeFromComment(ev, ref);

      // Close-release: when an issue closes, fire any of OUR dependents it was blocking
      // that are now fully unblocked and resting in a step's source label. The closed
      // issue itself needn't be ours — a human closing a blocker should still release the
      // bot's dependents. (Gated AFTER our-ness, empty-blockedBy, and resting checks below.)
      // The close is also the board's done flag: an issue of OURS yields a signal-only
      // `board_done` job, which the engine emits outside the queue (src/board-done.js).
      if (ev.action === "closed") {
        /** @type {import('../types.js').Job[]} */
        const jobs = [];
        if (await issueIsOurs(issue)) {
          const delivery = Array.isArray(headers["x-github-delivery"]) ? headers["x-github-delivery"][0] : headers["x-github-delivery"];
          jobs.push({ kind: "board_done", ref, stepId: "", dedupKey: `done:${delivery || `${ref}:${issue.closed_at ?? ""}`}` });
        }
        for (const dep of await blocking(ref)) {
          const depRef = String(dep.number);
          if (dep.state !== "open") continue; // a dependent already closed itself: never fire an agent on it
          if (!(await issueIsOurs(dep))) continue; // a dependent that isn't ours: untouched
          const step = stepForLabels(dep.labels); // (c) currently rests in a step's source label
          if (!step || step.manual) continue; // no source step, or a manual/terminal one (no agent runs)
          if ((await blockedBy(depRef)).length) continue; // (b) still blocked by another open issue
          console.log(`[unblock] #${ref} closed → firing #${depRef} (${step.id})`);
          jobs.push({ kind: "pipeline", ref: depRef, stepId: step.id, dedupKey: `unblock:${ref}:${depRef}` });
        }
        return jobs;
      }

      if (ev.action === "labeled") {
        const step = stepBySourceLabel(ev.label?.name);
        if (!step) return [];
        if (!(await issueIsOurs(issue))) {
          console.log(`[assignee] skip #${ref} — not assigned to us`);
          return [];
        }
        // The payload's `issue.labels` is a SNAPSHOT — a delayed delivery can carry a label
        // the issue has since left (the step already finished and moved on). Re-read the
        // live issue (strongly consistent) before firing; a fetch failure fails closed.
        if (!(await stillRestingIn(ref, ev.label?.name))) {
          console.log(`[stale] #${ref} no longer in ${ev.label?.name} — skipping delayed labeled delivery`);
          return [];
        }
        if (await restIfBlocked(ref)) return []; // open blocker → stay in the source label, no agent
        const delivery = Array.isArray(headers["x-github-delivery"]) ? headers["x-github-delivery"][0] : headers["x-github-delivery"];
        const dedupKey = `secmove:${delivery || `${ref}:${norm(ev.label?.name)}`}`;
        return [{ kind: "pipeline", ref, stepId: step.id, dedupKey }];
      }

      if (ev.action === "opened" || ev.action === "reopened" || ev.action === "assigned") {
        // Same staleness risk as `labeled`: the payload's `issue.labels`/assignees are a
        // snapshot a delayed delivery can carry stale (e.g. after the issue has advanced
        // to, or left, a step). Route off a fresh single-issue read instead — fail closed
        // (no job) on a closed issue, one no longer ours, or a fetch failure.
        const live = await liveIssue(ref);
        if (!live || live.state !== "open" || !(await issueIsOurs(live))) {
          console.log(`[stale] #${ref} no longer open and assigned to us — skipping delayed ${ev.action} delivery`);
          return [];
        }
        const step = stepForLabels(live.labels);
        if (!step) {
          console.log(`[stale] #${ref} no longer in a pipeline step — skipping delayed ${ev.action} delivery`);
          return [];
        }
        if (await restIfBlocked(ref)) return []; // open blocker → rest until it clears
        return [{ kind: "pipeline", ref, stepId: step.id, dedupKey: `step:${step.id}:${ref}` }];
      }
      return [];
    },

    async fetchTask(ref) {
      const res = await api(`${repoPath()}/issues/${ref}`);
      if (!res.ok) throw new Error(`issue fetch ${res.status}`);
      const issue = await json(res);
      /** @type {import('../types.js').EpicRef | undefined} */
      let epic;
      if (issue.parent_issue_url) {
        try {
          const pres = await api(`${repoPath()}/issues/${ref}/parent`);
          if (pres.ok) {
            const parent = await json(pres);
            const parentSameRepo = typeof parent.repository_url !== "string" || parent.repository_url.toLowerCase() === repoApiUrl().toLowerCase();
            if (parentSameRepo && isEpicIssue(parent, epicType, epicLabel)) {
              epic = { ref: String(parent.number), name: parent.title, url: parent.html_url, displayId: `#${parent.number}` };
            }
          } else if (pres.status !== 404) {
            console.warn(`[epics] parent lookup for #${ref} failed (${pres.status})`);
          }
        } catch (e) {
          console.warn(`[epics] parent lookup for #${ref} failed:`, e instanceof Error ? e.message : e);
        }
      }
      return {
        ref,
        name: issue.title,
        description: typeof issue.body === "string" ? issue.body : "",
        url: issue.html_url,
        completed: issue.state === "closed",
        assignedToUs: await issueIsOurs(issue),
        displayId: `#${ref}`,
        isEpic: isEpicIssue(issue, epicType, epicLabel),
        ...(epic ? { epic } : {}),
        routeKeys: extractRouteKeys(
          issue.labels,
          cfg.providerConfig?.routeField,
          (pipeline || []).flatMap((st) => [st.sourceLabel, st.successLabel, st.failureLabel, st.holdLabel, st.queueLabel]),
        ),
      };
    },

    // Resolve a finished step by swapping the issue's label to the one its verdict maps
    // to — and that label change is itself the trigger for whatever step sources it:
    //   advance → successLabel (the next step's source — drives forward)
    //   fail    → failureLabel (a human picks it up)
    //   hold    → holdLabel    (parked; the owner's `@agent` reply resumes it, or a
    //                           human relabels it back)
    //   changes → the target step's sourceLabel (re-fires it — the rework loop;
    //             dispatch already resolved verdict.target to a concrete stepId)
    // A missing target label is a no-op: the issue stays put, logged.
    async advance(ref, stepId, verdict) {
      const step = stepById(stepId);
      if (!step) return;
      // Mutation chokepoint: never move an issue that isn't ours (covers the blind
      // recoverInterrupted path + defense-in-depth for dispatch). Fail-closed.
      const owner = scopeToUser ? await ownedByUs(ref) : "ours";
      if (owner !== "ours") {
        const why = owner === "not_ours" ? "not assigned to us" : "owner check failed";
        console.log(`[assignee] refuse to move #${ref} (${stepId}:${verdict.outcome}) — ${why}`);
        throw new MoveRefusedError(owner === "not_ours" ? "not_ours" : "owner_check_failed", `refused to move #${ref}: ${why}`);
      }
      const { outcome, target } = verdict;
      let label;
      if (outcome === "advance") label = step.successLabel;
      else if (outcome === "fail") label = step.failureLabel;
      else if (outcome === "hold") label = step.holdLabel;
      else if (outcome === "changes" && target) label = stepById(target)?.sourceLabel;
      if (!label) {
        console.log(`[advance] ${stepId} ${outcome}: no target label — leaving #${ref} in place`);
        return;
      }
      // Leave the finished stage, enter the new one. Order: add first, then remove, so
      // a crash between the two leaves the issue in BOTH stages (re-fires, recoverable)
      // rather than NEITHER (stuck, invisible to the pipeline). A step resumed by an
      // `@agent` reply still carries its holdLabel (not its sourceLabel), so drop that too.
      await addLabel(ref, label);
      if (step.sourceLabel && norm(step.sourceLabel) !== norm(label)) await removeLabel(ref, step.sourceLabel);
      if (step.holdLabel && norm(step.holdLabel) !== norm(label) && norm(step.holdLabel) !== norm(step.sourceLabel)) await removeLabel(ref, step.holdLabel);
      console.log(`[label] moved #${ref} -> ${label} (${stepId}:${outcome}${outcome === "changes" ? `->${target}` : ""})`);
      // Entering a terminal step flagged closeIssue (e.g. the manual `done` step) CLOSES the
      // GitHub issue, so a blocker that finishes its own pipeline auto-releases its dependents
      // (the close-release path in processEvents) without a human. Explicit, never implicit.
      const entered = stepBySourceLabel(label);
      if (entered?.closeIssue) {
        const res = await api(`${repoPath()}/issues/${ref}`, { method: "PATCH", body: JSON.stringify({ state: "closed" }) });
        if (!res.ok) throw new Error(`close issue ${res.status}`);
        console.log(`[closed] #${ref} (terminal step ${entered.id})`);
      }
    },

    // Inject work into a step (`agenthook run`): assign the issue to us (unless
    // opts.assign===false) and add the step's SOURCE label. That label add is itself the
    // `labeled` webhook event that fires the step — no special dispatch path. (Boot's
    // ensureLabels guarantees the label exists in the repo so the add can't 404.)
    /** @param {string} ref @param {string} stepId @param {{assign?: boolean}} [opts] */
    async enterStage(ref, stepId, opts = {}) {
      const step = stepById(stepId);
      if (!step) throw new Error(`unknown step "${stepId}"`);
      if (!step.sourceLabel) throw new Error(`step "${stepId}" has no sourceLabel to enter`);
      if (opts.assign !== false) await assignToUs(ref);
      await addLabel(ref, step.sourceLabel);
      // Labels aren't single-occupancy: leaving the step's queue stage means dropping its
      // queueLabel too (a queue pull, or `run` on a queued issue). Add-then-remove, same
      // crash-safe order as advance; removeLabel tolerates a 404 (label not on the issue).
      if (step.queueLabel && norm(step.queueLabel) !== norm(step.sourceLabel)) await removeLabel(ref, step.queueLabel);
      // Re-entering a step that failed (the dashboard's retry, or `run --force`) leaves its failure
      // lane too: advance never drops a failureLabel, so a later success would keep the stale one.
      // Skipped when that label is some step's source (dropping it would un-fire that step).
      const fail = step.failureLabel;
      if (fail && !(pipeline || []).some((s) => s.sourceLabel && norm(s.sourceLabel) === norm(fail))) await removeLabel(ref, fail);
      return { stage: step.sourceLabel };
    },

    // The pipeline label an issue currently carries (any source/success/failure/hold
    // label of any step), or null — backs `run`'s guard against re-injecting an item
    // already mid-flow. Read-only and no assignee gate: a stage is occupied regardless
    // of who it's assigned to.
    async currentStage(ref) {
      if (!pipeline) return null;
      const res = await api(`${repoPath()}/issues/${ref}`);
      if (!res.ok) throw new Error(`issue fetch ${res.status}`);
      const labels = pipelineLabels();
      for (const l of (await json(res)).labels || []) {
        const hit = labels.get(norm(typeof l === "string" ? l : l?.name));
        if (hit) return hit;
      }
      return null;
    },

    // Reconcile source (explicit `reconcile` command ONLY — never boot): every open
    // issue resting in a step's source label, as a pipeline job for that step. One
    // issues-list call per step; the `assignee` query keeps it to our issues. Best-effort
    // single page (per_page 100) — reconcile is a recovery poll, not exhaustive paging.
    async listResting() {
      if (!pipeline) return [];
      /** @type {import('../types.js').Job[]} */
      const jobs = [];
      const seen = new Set();
      const assigneeQ = scopeToUser ? `&assignee=${encodeURIComponent(await ourLogin())}` : "";
      for (const step of pipeline) {
        if (!step.sourceLabel || step.manual) continue;
        const res = await api(`${repoPath()}/issues?state=open&labels=${encodeURIComponent(step.sourceLabel)}${assigneeQ}&per_page=100`);
        if (!res.ok) throw new Error(`list issues "${step.sourceLabel}" ${res.status}`);
        for (const it of (await json(res)) || []) {
          if (it.pull_request) continue; // the issues list endpoint also returns PRs — skip them
          if (isEpicIssue(it, epicType, epicLabel)) continue; // never run an agent on an epic
          const ref = String(it.number);
          if (seen.has(ref)) continue;
          if (!(await issueIsOurs(it))) continue;
          // The list-by-label index lags label changes by seconds: an issue that just left this stage
          // (cancelled, failed, advanced) can still be listed under it. Re-read the single issue —
          // strongly consistent — and require it to still be open and carry the label, or reconcile
          // would replay a ticket that already moved on. Fail closed on a read error.
          if (!(await stillRestingIn(ref, step.sourceLabel))) continue;
          if ((await blockedBy(ref)).length) continue; // blocked → reconcile must not re-inject it
          seen.add(ref);
          jobs.push({ kind: "pipeline", ref, stepId: step.id, dedupKey: `reconcile:${step.id}:${ref}` });
        }
      }
      return jobs;
    },

    // Queue-stage source (the one narrow boot/run_end board read — see engine pullQueued):
    // open issues carrying the step's opt-in queueLabel, filtered like listResting (ours,
    // not a PR, not blocked). Labels have no order, so priority falls back to OLDEST-
    // CREATED FIRST. Single page (per_page 100). [] without the key.
    /** @param {string} stepId */
    async listQueued(stepId) {
      const step = stepById(stepId);
      if (!step?.queueLabel || step.manual) return [];
      const assigneeQ = scopeToUser ? `&assignee=${encodeURIComponent(await ourLogin())}` : "";
      const res = await api(
        `${repoPath()}/issues?state=open&labels=${encodeURIComponent(step.queueLabel)}${assigneeQ}&sort=created&direction=asc&per_page=100`,
      );
      if (!res.ok) throw new Error(`list issues "${step.queueLabel}" ${res.status}`);
      /** @type {string[]} */
      const refs = [];
      for (const it of (await json(res)) || []) {
        if (it.pull_request) continue; // the issues list endpoint also returns PRs — skip them
        if (isEpicIssue(it, epicType, epicLabel)) continue; // never run an agent on an epic
        const ref = String(it.number);
        if (!(await issueIsOurs(it))) continue;
        if ((await blockedBy(ref)).length) continue; // blocked → must not be pulled into work
        refs.push(ref);
      }
      return refs;
    },

    openBlockers: async (ref) => (await blockedBy(ref)).map((n) => `#${n}`),

    ownership: ownedByUs,

    // Every epic in the repo: typed `epicType` OR labelled `epicLabel`, from either path,
    // always post-filtered through mapEpics (so a stray match on either query can't leak
    // a non-epic). Each path fails open independently (a personal repo has no issue types
    // → the type path 422s once, after which it's skipped — logged at info level, not a
    // warning; any other type-path error keeps warning and retrying every call).
    async listEpics() {
      try {
        /** @type {any[]} */
        let byLabel = [];
        try {
          byLabel = await pagedIssues(`${repoPath()}/issues`, `labels=${encodeURIComponent(epicLabel)}&state=all`);
        } catch (e) {
          console.warn(`[epics] listEpics label path failed:`, e instanceof Error ? e.message : e);
        }
        /** @type {any[]} */
        let byType = [];
        if (!typePathUnavailable) {
          try {
            byType = await pagedIssues(`${repoPath()}/issues`, `type=${encodeURIComponent(epicType)}&state=all`);
          } catch (e) {
            if (e && typeof e === "object" && "status" in e && e.status === 422) {
              typePathUnavailable = true;
              console.log(`[epics] issue types unavailable on this repo — using the "${epicLabel}" label only`);
            } else {
              console.warn(`[epics] listEpics type path failed:`, e instanceof Error ? e.message : e);
            }
          }
        }
        return mapEpics([...byLabel, ...byType], epicType, epicLabel);
      } catch (e) {
        console.warn(`[epics] listEpics failed:`, e instanceof Error ? e.message : e, "— returning []");
        return [];
      }
    },

    // An epic's direct sub-issues (ADR 0004 — native GitHub sub-issues, not Projects/
    // Asana subtasks). Fail-open on API error.
    /** @param {string} epicRef */
    async listEpicTickets(epicRef) {
      try {
        const items = await pagedIssues(`${repoPath()}/issues/${epicRef}/sub_issues`, "");
        return mapEpicTickets(items, repoApiUrl(), pipelineLabels());
      } catch (e) {
        console.warn(`[epics] listEpicTickets(${epicRef}) failed:`, e instanceof Error ? e.message : e, "— returning []");
        return [];
      }
    },

    // Auto-create the repo webhook (GitHub, unlike Jira, allows it with a token). Scrub
    // our stale hooks first (the tunnel URL rotates each boot on an ephemeral ingress),
    // then create one `issues` + `issue_comment` + `sub_issues` hook signed with the generated
    // secret. No update path: a changed events list applies on the next start/register.
    async registerWebhook(publicUrl) {
      const target = `${publicUrl.replace(/\/$/, "")}/github/`;
      await deleteOurHooks();
      const secret = webhookSecret();
      const res = await api(`${repoPath()}/hooks`, {
        method: "POST",
        body: JSON.stringify({
          name: "web",
          active: true,
          events: ["issues", "issue_comment", "sub_issues"],
          config: { url: target, content_type: "json", insecure_ssl: "0", ...(secret ? { secret } : {}) },
        }),
      });
      const body = await json(res).catch(() => ({})); // a 502 can be an HTML page — keep the status
      if (!res.ok) {
        const hint =
          res.status === 404 || res.status === 403
            ? auth.app
              ? ` — the GitHub App needs the Webhooks: Read & write repository permission, installed on ${owner}/${repo}`
              : ` — the token needs admin:repo_hook (classic) or Webhooks: Read & write (fine-grained) on ${owner}/${repo}`
            : "";
        throw Object.assign(new Error(`GitHub create hook ${res.status}: ${JSON.stringify(body)}${hint}`), { status: res.status });
      }
      console.log(`Webhook created: id=${body.id} active=${body.active} -> ${target}`);
    },

    async unregisterWebhooks() {
      await deleteOurHooks();
    },

    ensureLabels,

    // Forge a signed `issues/opened` event for the issue's current source label, so a
    // missed issue replays through the whole dispatch path. dedupKey mirrors the
    // opened/reopened path (`step:<id>:<ref>`) so `catchup --force` clears the key the
    // server actually writes. Used by `catchup <number>` and `reconcile`.
    /** @param {string} ref @param {string} [stepId] */
    async forgeCatchup(ref, stepId) {
      let step = stepId;
      let sourceLabel;
      if (!step) {
        const res = await api(`${repoPath()}/issues/${ref}`);
        if (!res.ok) throw new Error(`issue fetch ${res.status}`);
        const issue = await json(res);
        if (!(await issueIsOurs(issue))) throw new Error(`#${ref} is not assigned to us`);
        const s = stepForLabels(issue.labels);
        step = s?.id;
        sourceLabel = s?.sourceLabel;
      } else {
        sourceLabel = stepById(step)?.sourceLabel;
      }
      const me = await ourLogin().catch(() => undefined);
      const body = JSON.stringify({
        action: "opened",
        issue: { number: Number(ref), labels: sourceLabel ? [{ name: sourceLabel }] : [], assignee: me ? { login: me } : null, assignees: me ? [{ login: me }] : [] },
      });
      /** @type {Record<string, string>} */
      const headers = { "X-GitHub-Event": "issues", "X-GitHub-Delivery": `agenthook-forge-${ref}` };
      const secret = webhookSecret();
      if (secret) headers["X-Hub-Signature-256"] = "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");
      const dedupKey = step ? `step:${step}:${ref}` : `issue:${ref}:opened`;
      return { path: "/github/", body, headers, dedupKey, stepId: step };
    },

    // `agenthook init` discovery. GITHUB_TOKEN is the only secret (handled by init's
    // token-env step). The login is derived from /user, so it isn't asked (init asks it
    // for a GitHub App, along with the App's key). The chosen
    // repo's labels are discovered live and bound to the code step (no TODO_* editing).
    wizardSteps: () => {
      // Sensible default labels for the three stages. They needn't exist yet: boot's
      // ensureLabels() creates every pipeline label, so a fresh repo is still runnable.
      const DEFAULTS = ["agent:code", "agent:review", "agent:blocked"];
      // The repo's existing labels, with the agenthook defaults always offered first.
      // `pc.repository` isn't set yet at init (it's the answer being collected here), so
      // this reads the picked `a.repository` rather than the factory's cached owner/repo.
      /** @param {Record<string,any>} a @returns {Promise<Array<{title:string,value:any}>>} */
      const labels = async (a) => {
        const [o, r] = String(a.repository).split("/");
        const existing = (await fetchLabels(o, r)).map((opt) => opt.label);
        const merged = [...DEFAULTS, ...existing.filter((/** @type {string} */ n) => !DEFAULTS.includes(n))];
        return merged.map((n) => ({ title: n, value: n }));
      };
      return [
        {
          key: "repository",
          message: "Repository whose issue labels drive the pipeline",
          type: "select",
          // The token owner's repos (most-recently-updated first) — or, under App auth, the
          // repos the installation can reach. Caps at 100 — a repo beyond that can be set by
          // hand as `"repository": "owner/name"` in the config.
          choices: async () => {
            if (auth.app) {
              const res = await api(`/installation/repositories?per_page=100`);
              if (!res.ok) throw new Error(`GitHub /installation/repositories ${res.status}`);
              return ((await json(res))?.repositories || []).map((/** @type {any} */ r) => ({ title: r.full_name, value: r.full_name }));
            }
            const res = await api(`/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member`);
            if (!res.ok) throw new Error(`GitHub /user/repos ${res.status}`);
            return ((await json(res)) || []).map((/** @type {any} */ r) => ({ title: r.full_name, value: r.full_name }));
          },
        },
        { key: "_sourceStage", message: "Label that FIRES the code step (an issue carrying it triggers the agent)", type: "select", default: DEFAULTS[0], choices: labels },
        { key: "_successStage", message: "Label to swap to on SUCCESS (hand off to the next stage, e.g. review or done)", type: "select", default: DEFAULTS[1], choices: labels },
        { key: "_failureStage", message: "Label to swap to on FAILURE (blocked — a human picks it up)", type: "select", default: DEFAULTS[2], choices: labels },
        {
          key: "_holdStage",
          message: "Label to swap to when the agent needs an answer (hold)",
          type: "select",
          default: "",
          choices: async (a) => [{ title: "(skip — leave it in place)", value: "" }, ...(await labels(a))],
        },
        {
          key: "_doneStage",
          message: "Label for DONE — a merged PR swaps the issue to this label (skip = no done step)",
          type: "select",
          default: "",
          choices: async (a) => [{ title: "(skip — no done step)", value: "" }, ...(await labels(a))],
        },
      ];
    },

    // Map the wizard's live stage picks to this tracker's step bindings. Null when the
    // user never reached the label picks, so init falls back to the TODO_* skeleton. The
    // hold key is added only when a hold label was picked — never written as "".
    /** @param {Record<string,any>} a */
    pipelineBindings: (a) =>
      a._sourceStage
        ? { sourceLabel: a._sourceStage, successLabel: a._successStage, failureLabel: a._failureStage, ...(a._holdStage ? { holdLabel: a._holdStage } : {}) }
        : null,
  };
}
