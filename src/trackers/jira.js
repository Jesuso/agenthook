// Jira Cloud adapter — the section-driven pipeline model mapped onto Jira's
// workflow STATUSES. Where Asana routes on a task's project section, Jira routes
// on an issue's status: a step binds `sourceStatus`, and an issue entering that
// status fires the step. On a verdict the receiver TRANSITIONS the issue (Jira
// has no "set status" — you execute the transition whose `to` is the target
// status), which is itself the event that fires the next step.
//
// Implements the same interface as asana.js (see that file for the canonical
// doc-comment). Jira specifics:
//   - Auth: Basic base64("<email>:<apiToken>") — Jira Cloud classic tokens are Basic-only,
//     the email is the username; a bare `Bearer <token>` is rejected (403/401). So `email`
//     is required and not derivable from the token. REST v2 so `description` is a plain
//     string (v3 returns ADF JSON) and comments take `{ body: "<text>" }`.
//     See https://developer.atlassian.com/cloud/jira/platform/basic-auth-for-rest-apis/#supply-basic-auth-headers
//   - One webhook per event (the body IS the event, not an `{events:[]}` array).
//   - No per-webhook handshake. agenthook GENERATES the webhook signing secret (or
//     honours an explicit tracker.webhookSecret), persists it, and prints it for the
//     admin to paste into Jira; the body is verified via `x-hub-signature: sha256=<hex>`.
//     So JIRA_API_TOKEN is the only Jira secret a user supplies. `webhookSecret:false`
//     opts out of verification. The assignee accountId is derived from /myself (cached),
//     so that isn't asked for either.
//   - Webhooks CANNOT be created with an API token (Jira Cloud restricts the
//     webhook REST API to Connect/Forge apps). registerWebhook therefore prints
//     one-time manual setup instructions and unregisterWebhooks is a no-op. The
//     hand-made webhook URL can't rotate, so run behind a STABLE ingress
//     (ngrok reserved domain, or a hosted URL) — never an ephemeral tunnel.
import crypto from "node:crypto";

/** @type {import('../types.js').AdapterFactory} */
export function createJiraAdapter(cfg, store) {
  const pc = cfg.providerConfig;
  const baseUrl = (pc.baseUrl || `https://${pc.site}.atlassian.net`).replace(/\/$/, "");
  // Jira Cloud Basic auth: base64("<email>:<api-token>"). Both resolved from env by loadConfig.
  const authHeader = "Basic " + Buffer.from(`${pc.email}:${pc.token}`).toString("base64");
  /** REST v2 (string description + plain-text comments). @param {string} p @param {RequestInit} [init] */
  const api = (p, init = {}) =>
    fetch(`${baseUrl}/rest/api/2${p}`, {
      ...init,
      headers: { Authorization: authHeader, "Content-Type": "application/json", Accept: "application/json", ...(init.headers || {}) },
    });
  // External API payloads are untyped until an adapter maps them — parse as any.
  /** @param {Response} res @returns {Promise<any>} */
  const json = (res) => res.json();

  /** @param {string|null|undefined} s */
  const norm = (s) => (s || "").trim().toLowerCase();

  /** Verify Jira's `x-hub-signature: sha256=<hex>` HMAC over the raw body.
   * @param {string|undefined} secret @param {string} raw @param {string|string[]|undefined} sig */
  const verify = (secret, raw, sig) => {
    const sigStr = Array.isArray(sig) ? sig[0] : sig;
    if (!secret || !sigStr) return false;
    const hex = sigStr.startsWith("sha256=") ? sigStr.slice(7) : sigStr;
    const computed = crypto.createHmac("sha256", secret).update(raw).digest("hex");
    const a = Buffer.from(computed);
    const b = Buffer.from(hex);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };

  // Webhook secret: NEVER required of the user. An explicit tracker.webhookSecret wins
  // (and `false` disables verification — accept unsigned). Otherwise agenthook GENERATES
  // one, persists it in the profile's secret store, and prints it in registerWebhook for
  // the admin to paste into the Jira webhook. So JIRA_API_TOKEN is the only Jira secret
  // the user supplies — the webhook secret is the tool's to own, not the human's.
  const SECRET_KEY = "jira:webhookSecret";
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
  // account, derived from /myself and cached (so the user never pastes an accountId). An
  // explicit assigneeAccountId overrides the lookup; assigneeFilter:false = project-wide.
  // FAIL CLOSED: if our accountId can't be resolved, nothing counts as ours, so a foreign
  // issue is never touched (we never silently go open).
  const scopeToUser = pc.assigneeFilter !== false;
  let cachedAccountId = pc.assigneeAccountId || null;
  /** @type {Promise<string>|null} */
  let accountIdPromise = null;
  /** The token owner's accountId (the bot). Fetched once from /myself, then cached.
   * The PROMISE is memoised so concurrent callers share one in-flight fetch; a failure
   * clears it so a later call retries (rather than caching the rejection). */
  function ourAccountId() {
    if (cachedAccountId) return Promise.resolve(cachedAccountId);
    if (!accountIdPromise) {
      accountIdPromise = (async () => {
        const res = await api(`/myself`);
        if (!res.ok) throw new Error(`/myself ${res.status}`);
        return (cachedAccountId = (await json(res)).accountId);
      })().catch((e) => {
        accountIdPromise = null;
        throw e;
      });
    }
    return accountIdPromise;
  }
  /** @param {string|null|undefined} id → is this assignee us? (true when scoping off)
   * @returns {Promise<boolean>} */
  async function isOurs(id) {
    if (!scopeToUser) return true;
    try {
      return id != null && id === (await ourAccountId());
    } catch (e) {
      console.error(`[myself] could not resolve our accountId (failing closed):`, e.message);
      return false;
    }
  }
  /** @param {string} id */
  const stepById = (id) => pipeline?.find((s) => s.id === id);
  /** @param {string|null|undefined} status → the step whose sourceStatus an issue now rests in */
  const stepByStatus = (status) => (status ? pipeline?.find((s) => norm(s.sourceStatus) === norm(status)) : undefined);

  // Jira has no "set status": move by executing the transition whose target status
  // matches. A status not reachable from the issue's current status (the workflow
  // forbids it) is a logged no-op — the issue stays put rather than erroring.
  /** @param {string} key @param {string|undefined} statusName @param {string} label */
  async function transitionTo(key, statusName, label) {
    if (!statusName) return;
    const res = await api(`/issue/${key}/transitions`);
    if (!res.ok) throw new Error(`transitions fetch ${res.status}`);
    const transitions = (await json(res)).transitions || [];
    const t = transitions.find((/** @type {any} */ x) => norm(x.to?.name) === norm(statusName));
    if (!t) {
      console.warn(
        `[transition] ${key}: no available transition to "${statusName}" from the current status — ` +
          `the Jira workflow may not allow it. Leaving in place.`,
      );
      return;
    }
    const post = await api(`/issue/${key}/transitions`, { method: "POST", body: JSON.stringify({ transition: { id: t.id } }) });
    if (!post.ok) throw new Error(`transition POST ${post.status}`);
    console.log(`[transition] moved ${key} -> ${statusName} (${label})`);
  }

  // Assign an issue to us (our accountId). Required before injecting work so the issue
  // clears the fail-closed scope gate.
  /** @param {string} ref */
  async function assignToUs(ref) {
    const me = await ourAccountId();
    const res = await api(`/issue/${ref}/assignee`, { method: "PUT", body: JSON.stringify({ accountId: me }) });
    if (!res.ok) throw new Error(`assign ${res.status}`);
  }

  // Fail-closed owner check gating issue MUTATION (advance/transition). Any
  // uncertainty — fetch error, non-2xx, missing/!matching assignee — returns false,
  // so we never move an issue we can't positively confirm is ours.
  /** @param {string} ref @returns {Promise<boolean>} */
  async function ownedByUs(ref) {
    try {
      const res = await api(`/issue/${ref}?fields=assignee`);
      if (!res.ok) return false;
      return await isOurs((await json(res)).fields?.assignee?.accountId);
    } catch {
      return false;
    }
  }

  return {
    describe: () => ({
      platform: "Jira",
      taskNoun: "issue",
      trigger: cfg.trigger,
      commentHowTo: `post a comment with curl: curl -s -u "${pc.email}:$JIRA_API_TOKEN" -X POST ${baseUrl}/rest/api/2/issue/<key>/comment -H "Content-Type: application/json" -d '{"body":"<text>"}' (your token is in the env as $JIRA_API_TOKEN)`,
    }),

    // No handshake. With a secret: verify the HMAC. Without one (webhookSecret:false):
    // accept. Sync + no network so the receiver ACKs inside Jira's retry window.
    authenticate({ rawBody, headers }) {
      const secret = webhookSecret();
      if (!secret) return { type: "accept" };
      if (!verify(secret, rawBody, headers["x-hub-signature"])) {
        console.warn("[reject] bad/absent x-hub-signature");
        return { type: "reject" };
      }
      return { type: "accept" };
    },

    // One Jira webhook delivery = one event object (NOT an array). We route:
    //   jira:issue_created → the step whose sourceStatus the new issue sits in.
    //   jira:issue_updated → only when the changelog carries a `status` change;
    //                        route to the step matching the NEW status (changelog
    //                        `toString`), deduped by the unique changelog id.
    async processEvents({ rawBody }) {
      let ev;
      try {
        ev = JSON.parse(rawBody);
      } catch (e) {
        console.error("[parse]", e.message);
        return [];
      }
      const issue = ev.issue;
      const key = issue?.key;
      if (!key) return [];
      if (!(await isOurs(issue.fields?.assignee?.accountId))) {
        console.log(`[assignee] skip ${key} — not assigned to us`);
        return [];
      }

      if (ev.webhookEvent === "jira:issue_created") {
        const step = stepByStatus(issue.fields?.status?.name);
        if (!step) return [];
        return [{ kind: "pipeline", ref: key, stepId: step.id, dedupKey: `step:${step.id}:${key}` }];
      }

      if (ev.webhookEvent === "jira:issue_updated") {
        const item = (ev.changelog?.items || []).find((/** @type {any} */ i) => i.field === "status" || i.fieldId === "status");
        if (!item) return []; // an update that didn't change status — ignore
        const step = stepByStatus(item.toString);
        if (!step) return [];
        // changelog.id is unique per change → dedups webhook retries yet lets a later
        // re-entry into the same status fire again (different changelog id).
        const dedupKey = `secmove:${ev.changelog?.id ?? `${key}:${norm(item.toString)}`}`;
        return [{ kind: "pipeline", ref: key, stepId: step.id, dedupKey }];
      }
      return [];
    },

    async fetchTask(ref) {
      const res = await api(`/issue/${ref}?fields=summary,description,status,assignee`);
      if (!res.ok) throw new Error(`issue fetch ${res.status}`);
      const f = (await json(res)).fields || {};
      // REST v2 description is a string (or null); guard in case a v3-shaped ADF
      // object ever arrives so the prompt never gets "[object Object]".
      const description = typeof f.description === "string" ? f.description : f.description ? JSON.stringify(f.description) : "";
      return {
        ref,
        name: f.summary,
        description,
        url: `${baseUrl}/browse/${ref}`,
        completed: f.status?.statusCategory?.key === "done",
        assignedToUs: await isOurs(f.assignee?.accountId),
      };
    },

    // Resolve a finished step by transitioning the issue to the status its verdict
    // maps to — and that transition is itself the trigger for whatever step that
    // status sources:
    //   advance → successStatus (the next step's source — drives forward)
    //   fail    → failureStatus (a human picks it up)
    //   hold    → holdStatus    (parked out of the queue; a human answers + moves it back)
    //   changes → the target step's sourceStatus (re-fires it — the rework loop;
    //             dispatch already resolved verdict.target to a concrete stepId)
    // A missing/unreachable target status is a no-op: the issue stays put, logged.
    async advance(ref, stepId, verdict) {
      const step = stepById(stepId);
      if (!step) return;
      // Mutation chokepoint: never move an issue that isn't ours (covers the blind
      // recoverInterrupted path + defense-in-depth for dispatch). Fail-closed.
      if (scopeToUser && !(await ownedByUs(ref))) {
        console.log(`[assignee] refuse to move ${ref} (${stepId}:${verdict.outcome}) — not assigned to us`);
        return;
      }
      const { outcome, target } = verdict;
      let status;
      if (outcome === "advance") status = step.successStatus;
      else if (outcome === "fail") status = step.failureStatus;
      else if (outcome === "hold") status = step.holdStatus;
      else if (outcome === "changes" && target) status = stepById(target)?.sourceStatus;
      if (!status) {
        console.log(`[advance] ${stepId} ${outcome}: no target status — leaving ${ref} in place`);
        return;
      }
      await transitionTo(ref, status, `${stepId}:${outcome}${outcome === "changes" ? `->${target}` : ""}`);
    },

    // Inject work into a step (`agenthook run`): assign the issue to us (unless
    // opts.assign===false) and transition it INTO the step's SOURCE status. That
    // transition is itself the issue_updated webhook event that fires the step — no
    // special dispatch path. (A source status unreachable from the issue's current
    // status is a logged no-op, exactly like advance.)
    /** @param {string} ref @param {string} stepId @param {{assign?: boolean}} [opts] */
    async enterStage(ref, stepId, opts = {}) {
      const step = stepById(stepId);
      if (!step) throw new Error(`unknown step "${stepId}"`);
      if (!step.sourceStatus) throw new Error(`step "${stepId}" has no sourceStatus to enter`);
      if (opts.assign !== false) await assignToUs(ref);
      await transitionTo(ref, step.sourceStatus, `${stepId}:enter`);
      return { stage: step.sourceStatus };
    },

    // Reconcile source (explicit `reconcile` command ONLY — never boot): every issue
    // resting in a step's source status, as a pipeline job for that step. One JQL
    // search per step; the assignee clause keeps it to our issues. Best-effort single
    // page (maxResults 100) — reconcile is a recovery poll, not exhaustive paging.
    async listResting() {
      if (!pipeline) return [];
      /** @type {import('../types.js').Job[]} */
      const jobs = [];
      const seen = new Set();
      const project = pc.projectKey;
      const assigneeClause = scopeToUser ? ` AND assignee = "${await ourAccountId()}"` : "";
      for (const step of pipeline) {
        if (!step.sourceStatus || step.manual) continue;
        const jql = `${project ? `project = "${project}" AND ` : ""}status = "${step.sourceStatus}"${assigneeClause}`;
        // Jira Cloud's enhanced JQL search (the legacy /search is being retired).
        const res = await api(`/search/jql?jql=${encodeURIComponent(jql)}&fields=status,assignee&maxResults=100`);
        if (!res.ok) throw new Error(`search "${step.sourceStatus}" ${res.status}`);
        for (const it of (await json(res)).issues || []) {
          if (seen.has(it.key)) continue;
          if (!(await isOurs(it.fields?.assignee?.accountId))) continue;
          seen.add(it.key);
          jobs.push({ kind: "pipeline", ref: it.key, stepId: step.id, dedupKey: `reconcile:${step.id}:${it.key}` });
        }
      }
      return jobs;
    },

    // Jira Cloud forbids creating webhooks with an API token (Connect/Forge apps
    // only), so there is nothing to auto-register or scrub. Print one-time manual
    // setup the first admin runs, then return — boot continues regardless.
    async registerWebhook(publicUrl) {
      const target = `${publicUrl.replace(/\/$/, "")}/jira/`;
      const secret = webhookSecret();
      console.log(
        [
          `[jira] Jira Cloud webhooks can't be created with an API token (Connect-app only).`,
          `       Create it ONCE, by hand, as a Jira admin:`,
          `         Settings → System → WebHooks → Create a WebHook`,
          `           URL:    ${target}`,
          `           Events: Issue → created, updated`,
          secret
            ? `           Secret: ${secret}`
            : `           Secret: (none — verification disabled via "webhookSecret": false)`,
          secret ? `         ↑ agenthook generated + stored this. Paste it verbatim into the webhook's Secret field.` : ``,
          `       This URL is fixed, so run agenthook behind a STABLE ingress`,
          `       (ngrok reserved 'domain', or a hosted URL) — not an ephemeral tunnel.`,
        ]
          .filter(Boolean)
          .join("\n"),
      );
    },

    // No-op: the webhook is managed by hand in Jira admin, not by this token.
    async unregisterWebhooks() {
      /* nothing to do — see registerWebhook */
    },

    // Forge a signed issue_created event for the live status, so a missed issue
    // replays through the whole dispatch path. dedupKey mirrors processEvents'
    // created path (`step:<id>:<key>`) so `catchup --force` clears the key the
    // server actually writes. Used by `catchup <key>` and `reconcile`.
    /** @param {string} ref @param {string} [stepId] */
    async forgeCatchup(ref, stepId) {
      let step = stepId;
      let status;
      if (!step) {
        const res = await api(`/issue/${ref}?fields=status,assignee`);
        if (!res.ok) throw new Error(`issue fetch ${res.status}`);
        const f = (await json(res)).fields || {};
        if (!(await isOurs(f.assignee?.accountId))) throw new Error(`${ref} is not assigned to us`);
        status = f.status?.name;
        step = stepByStatus(status)?.id;
      } else {
        status = stepById(step)?.sourceStatus;
      }
      const me = await ourAccountId().catch(() => undefined);
      const body = JSON.stringify({
        webhookEvent: "jira:issue_created",
        issue: { key: ref, fields: { status: { name: status }, assignee: { accountId: me } } },
      });
      /** @type {Record<string, string>} */
      const headers = {};
      const secret = webhookSecret();
      if (secret) {
        headers["X-Hub-Signature"] = "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");
      }
      const dedupKey = step ? `step:${step}:${ref}` : `issue:${ref}:created`;
      return { path: "/jira/", body, headers, dedupKey, stepId: step };
    },

    // `agenthook init` discovery. JIRA_API_TOKEN is the only secret (handled by init's
    // token-env step). site/email/projectKey are plain values written literally — email
    // is the Basic-auth username, not a secret. The webhook secret is auto-generated and
    // the assignee accountId is derived from /myself, so neither is asked. The project's
    // statuses are then discovered live and bound to the code step (no TODO_* editing).
    wizardSteps: () => {
      // The project's workflow statuses — live, so the stage picks below are real names.
      // site/email aren't on `pc` yet at init (they're being collected by THIS wizard),
      // so this rebuilds base+auth from the answers rather than the factory's cached pair.
      /** @param {Record<string,any>} a @returns {Promise<Array<{title:string,value:any}>>} */
      const statuses = async (a) => {
        const base = (a.baseUrl || `https://${a.site}.atlassian.net`).replace(/\/$/, "");
        const auth = "Basic " + Buffer.from(`${a.email}:${pc.token}`).toString("base64");
        const res = await fetch(`${base}/rest/api/2/project/${encodeURIComponent(a.projectKey)}/statuses`, {
          headers: { Authorization: auth, Accept: "application/json" },
        });
        if (!res.ok) throw new Error(`Jira project statuses ${res.status}`);
        // The endpoint groups statuses by issue type; flatten + dedup by name (the binding key).
        /** @type {Map<string, {title:string,value:string}>} */
        const byName = new Map();
        for (const type of (await json(res)) || [])
          for (const s of type.statuses || []) byName.set(s.name, { title: s.name, value: s.name });
        return [...byName.values()];
      };
      return [
        { key: "site", message: 'Jira site shortname (the "<X>" in <X>.atlassian.net)' },
        { key: "email", message: "Bot account email (the Basic-auth username; not a secret)" },
        { key: "projectKey", message: "Project key whose statuses drive the pipeline (e.g. CAHUI)" },
        { key: "_sourceStage", message: "Status that FIRES the code step (an issue entering it triggers the agent)", type: "select", choices: statuses },
        { key: "_successStage", message: "Status to move to on SUCCESS (hand off to review)", type: "select", choices: statuses },
        { key: "_failureStage", message: "Status to move to on FAILURE (blocked — a human picks it up)", type: "select", choices: statuses },
      ];
    },

    // Map the wizard's live stage picks to this tracker's step bindings. Null when the
    // user never reached the status picks, so init falls back to the TODO_* skeleton.
    /** @param {Record<string,any>} a */
    pipelineBindings: (a) =>
      a._sourceStage ? { sourceStatus: a._sourceStage, successStatus: a._successStage, failureStatus: a._failureStage } : null,
  };
}
