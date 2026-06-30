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
//     GITHUB_TOKEN is the only secret a user supplies.
//   - Webhook: auto-created via REST like Asana, but signed with an agenthook-
//     GENERATED secret like Jira (or an explicit tracker.webhookSecret; `false`
//     disables verification). Verified via `x-hub-signature-256: sha256=<hex>`.
//   - One repo webhook on the `issues` event delivers opened / reopened / labeled /
//     assigned; all route to the step whose sourceLabel the issue now carries.
//   - The assignee "us" is the token owner's login, read once from /user and cached
//     (so no login is pasted). Scoping is FAIL CLOSED — see scopeToUser below.
import crypto from "node:crypto";

/** @type {import('../types.js').AdapterFactory} */
export function createGithubAdapter(cfg, store) {
  const pc = cfg.providerConfig;
  const token = pc.token; // resolved from env/.env by loadConfig
  // owner/repo come from `repository: "owner/name"` or explicit owner+repo. Resolved
  // loosely so the init probe (which has only {type, token}) can still call wizardSteps.
  const [owner, repo] = pc.repository ? String(pc.repository).split("/") : [pc.owner, pc.repo];
  /** @param {string} p @param {RequestInit} [init] */
  const api = (p, init = {}) =>
    fetch(`https://api.github.com${p}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
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

  /** @param {string|null|undefined} s */
  const norm = (s) => (s || "").trim().toLowerCase();

  /** Verify GitHub's `x-hub-signature-256: sha256=<hex>` HMAC over the raw body.
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
  const scopeToUser = pc.assigneeFilter !== false;
  let cachedLogin = pc.assigneeLogin || null;
  /** @type {Promise<string>|null} */
  let loginPromise = null;
  /** The token owner's login (the bot). Fetched once from /user, then cached. The
   * PROMISE is memoised so concurrent callers share one in-flight fetch; a failure
   * clears it so a later call retries (rather than caching the rejection). */
  function ourLogin() {
    if (cachedLogin) return Promise.resolve(cachedLogin);
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

  // Fail-closed owner check gating issue MUTATION (advance/label swap). Any
  // uncertainty — fetch error, non-2xx, missing/!matching assignee — returns false,
  // so we never move an issue we can't positively confirm is ours.
  /** @param {string} ref @returns {Promise<boolean>} */
  async function ownedByUs(ref) {
    try {
      const res = await api(`${repoPath()}/issues/${ref}`);
      if (!res.ok) return false;
      return await issueIsOurs(await json(res));
    } catch {
      return false;
    }
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
      for (const label of [step.sourceLabel, step.successLabel, step.failureLabel, step.holdLabel]) {
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
    if (!res.ok) throw new Error(`list hooks ${res.status}`);
    for (const h of (await json(res)) || []) {
      const url = h?.config?.url || "";
      if (url.replace(/\/$/, "").endsWith("/github")) {
        await api(`${repoPath()}/hooks/${h.id}`, { method: "DELETE" });
        console.log(`  deleted webhook ${h.id} -> ${url}`);
      }
    }
  }

  return {
    describe: () => ({
      platform: "GitHub",
      taskNoun: "issue",
      trigger: cfg.trigger,
      commentHowTo: `post a comment with curl: curl -s -H "Authorization: Bearer $GITHUB_TOKEN" -H "Accept: application/vnd.github+json" -X POST https://api.github.com/repos/${owner}/${repo}/issues/<number>/comments -d '{"body":"<text>"}' (your token is in the env as $GITHUB_TOKEN)`,
    }),

    // No handshake. With a secret: verify the HMAC. Without one (webhookSecret:false):
    // accept. Sync + no network so the receiver ACKs inside GitHub's 10s window.
    authenticate({ rawBody, headers }) {
      const secret = webhookSecret();
      if (!secret) return { type: "accept" };
      if (!verify(secret, rawBody, headers["x-hub-signature-256"])) {
        console.warn("[reject] bad/absent x-hub-signature-256");
        return { type: "reject" };
      }
      return { type: "accept" };
    },

    // One GitHub delivery = one event object. The `X-GitHub-Event` header names the
    // type (we only care about `issues`; `ping` on hook-create is ACKed and ignored).
    // We route:
    //   opened/reopened/assigned → the step whose sourceLabel the issue carries
    //                              (state-based key `step:<id>:<ref>` — idempotent).
    //   labeled                  → the step whose sourceLabel was just added
    //                              (event-based key `secmove:<delivery>` — a later
    //                              re-add of the same label fires again; retries dedup).
    async processEvents({ headers, rawBody }) {
      if (norm(Array.isArray(headers["x-github-event"]) ? headers["x-github-event"][0] : headers["x-github-event"]) !== "issues") return [];
      let ev;
      try {
        ev = JSON.parse(rawBody);
      } catch (e) {
        console.error("[parse]", e instanceof Error ? e.message : e);
        return [];
      }
      const issue = ev.issue;
      if (issue?.number == null) return [];
      const ref = String(issue.number);
      if (!(await issueIsOurs(issue))) {
        console.log(`[assignee] skip #${ref} — not assigned to us`);
        return [];
      }

      if (ev.action === "labeled") {
        const step = stepBySourceLabel(ev.label?.name);
        if (!step) return [];
        const delivery = Array.isArray(headers["x-github-delivery"]) ? headers["x-github-delivery"][0] : headers["x-github-delivery"];
        const dedupKey = `secmove:${delivery || `${ref}:${norm(ev.label?.name)}`}`;
        return [{ kind: "pipeline", ref, stepId: step.id, dedupKey }];
      }

      if (ev.action === "opened" || ev.action === "reopened" || ev.action === "assigned") {
        const step = stepForLabels(issue.labels);
        if (!step) return [];
        return [{ kind: "pipeline", ref, stepId: step.id, dedupKey: `step:${step.id}:${ref}` }];
      }
      return [];
    },

    async fetchTask(ref) {
      const res = await api(`${repoPath()}/issues/${ref}`);
      if (!res.ok) throw new Error(`issue fetch ${res.status}`);
      const issue = await json(res);
      return {
        ref,
        name: issue.title,
        description: typeof issue.body === "string" ? issue.body : "",
        url: issue.html_url,
        completed: issue.state === "closed",
        assignedToUs: await issueIsOurs(issue),
      };
    },

    // Resolve a finished step by swapping the issue's label to the one its verdict maps
    // to — and that label change is itself the trigger for whatever step sources it:
    //   advance → successLabel (the next step's source — drives forward)
    //   fail    → failureLabel (a human picks it up)
    //   hold    → holdLabel    (parked; a human answers + relabels it back)
    //   changes → the target step's sourceLabel (re-fires it — the rework loop;
    //             dispatch already resolved verdict.target to a concrete stepId)
    // A missing target label is a no-op: the issue stays put, logged.
    async advance(ref, stepId, verdict) {
      const step = stepById(stepId);
      if (!step) return;
      // Mutation chokepoint: never move an issue that isn't ours (covers the blind
      // recoverInterrupted path + defense-in-depth for dispatch). Fail-closed.
      if (scopeToUser && !(await ownedByUs(ref))) {
        console.log(`[assignee] refuse to move #${ref} (${stepId}:${verdict.outcome}) — not assigned to us`);
        return;
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
      // rather than NEITHER (stuck, invisible to the pipeline).
      await addLabel(ref, label);
      if (step.sourceLabel && norm(step.sourceLabel) !== norm(label)) await removeLabel(ref, step.sourceLabel);
      console.log(`[label] moved #${ref} -> ${label} (${stepId}:${outcome}${outcome === "changes" ? `->${target}` : ""})`);
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
      return { stage: step.sourceLabel };
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
          const ref = String(it.number);
          if (seen.has(ref)) continue;
          if (!(await issueIsOurs(it))) continue;
          seen.add(ref);
          jobs.push({ kind: "pipeline", ref, stepId: step.id, dedupKey: `reconcile:${step.id}:${ref}` });
        }
      }
      return jobs;
    },

    // Auto-create the repo webhook (GitHub, unlike Jira, allows it with a token). Scrub
    // our stale hooks first (the tunnel URL rotates each boot on an ephemeral ingress),
    // then create one `issues` hook signed with the generated secret.
    async registerWebhook(publicUrl) {
      const target = `${publicUrl.replace(/\/$/, "")}/github/`;
      await deleteOurHooks();
      const secret = webhookSecret();
      const res = await api(`${repoPath()}/hooks`, {
        method: "POST",
        body: JSON.stringify({
          name: "web",
          active: true,
          events: ["issues"],
          config: { url: target, content_type: "json", insecure_ssl: "0", ...(secret ? { secret } : {}) },
        }),
      });
      const body = await json(res);
      if (!res.ok) {
        const hint = res.status === 404 || res.status === 403 ? ` — the token needs admin:repo_hook (classic) or Webhooks: Read & write (fine-grained) on ${owner}/${repo}` : "";
        throw new Error(`GitHub create hook ${res.status}: ${JSON.stringify(body)}${hint}`);
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
      return { path: "/github/", body, headers, dedupKey };
    },

    // `agenthook init` discovery. GITHUB_TOKEN is the only secret (handled by init's
    // token-env step). The login is derived from /user, so it isn't asked. The chosen
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
        const res = await api(`/repos/${o}/${r}/labels?per_page=100`);
        if (!res.ok) throw new Error(`GitHub labels ${res.status}`);
        const existing = ((await json(res)) || []).map((/** @type {any} */ l) => l.name);
        const merged = [...DEFAULTS, ...existing.filter((/** @type {string} */ n) => !DEFAULTS.includes(n))];
        return merged.map((n) => ({ title: n, value: n }));
      };
      return [
        {
          key: "repository",
          message: "Repository whose issue labels drive the pipeline",
          type: "select",
          // The token owner's repos (most-recently-updated first). Caps at 100 — a repo
          // beyond that can be set by hand as `"repository": "owner/name"` in the config.
          choices: async () => {
            const res = await api(`/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member`);
            if (!res.ok) throw new Error(`GitHub /user/repos ${res.status}`);
            return ((await json(res)) || []).map((/** @type {any} */ r) => ({ title: r.full_name, value: r.full_name }));
          },
        },
        { key: "_sourceStage", message: "Label that FIRES the code step (an issue carrying it triggers the agent)", type: "select", default: DEFAULTS[0], choices: labels },
        { key: "_successStage", message: "Label to swap to on SUCCESS (hand off to review)", type: "select", default: DEFAULTS[1], choices: labels },
        { key: "_failureStage", message: "Label to swap to on FAILURE (blocked — a human picks it up)", type: "select", default: DEFAULTS[2], choices: labels },
      ];
    },

    // Map the wizard's live stage picks to this tracker's step bindings. Null when the
    // user never reached the label picks, so init falls back to the TODO_* skeleton.
    /** @param {Record<string,any>} a */
    pipelineBindings: (a) =>
      a._sourceStage ? { sourceLabel: a._sourceStage, successLabel: a._successStage, failureLabel: a._failureStage } : null,
  };
}
