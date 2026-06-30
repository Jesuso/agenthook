// GitHub Projects v2 adapter — the section-driven pipeline model mapped onto a
// project board's single-select STATUS field. Where Asana routes on a task's
// project section and Jira on an issue's status, this routes on a Projects v2
// item's `Status` option: a step binds `sourceStatus`, and an item entering that
// Status fires the step. On a verdict the receiver SETS the item's Status option
// (single-occupancy — one mutation, no add-before-remove), which is itself the
// `projects_v2_item` edited event that fires whatever step that Status sources.
//
// Implements the same interface as asana.js (see that file for the canonical
// doc-comment). GitHub Projects v2 specifics:
//   - API: the REST surface for Projects v2 is GraphQL-only, so this adapter talks
//     to https://api.github.com/graphql (Bearer token) via the local `gql` helper —
//     the GraphQL analog of the other adapters' `json(res)` (responses are `any`).
//   - The board is addressed by `project: "owner/number"` (or the project URL); the
//     owner may be an org OR a user. The project node id is resolved once + memoised.
//   - `ref` is the underlying ISSUE NUMBER (agents work the issue, not the card); a
//     number is resolved back to its project item by scanning the project's items.
//   - Auth: a PAT (classic `project` + `repo` scopes, or fine-grained Projects:RW +
//     Issues:R) as `Bearer <token>`. Webhook signed like the `github` tracker
//     (agenthook-generated secret, or an explicit tracker.webhookSecret; `false`
//     disables verification), verified via `x-hub-signature-256: sha256=<hex>`.
//   - One `projects_v2_item` webhook (org-level) delivers created / edited. A status
//     change arrives as `edited` with `changes.field_value` naming the changed field;
//     we act only when that field is the Status single-select. The payload omits the
//     new value, so we GraphQL the item to read its current Status option.
//   - Webhooks for Projects v2 are ORG-scoped and can't be tied to a rotating URL, so
//     (like Jira) registerWebhook PRINTS one-time manual setup and runs behind a
//     STABLE ingress; auto-registration is a later epic step. The assignee "us" is
//     the token owner's login (GraphQL `viewer`, cached). Scoping is FAIL CLOSED.
import crypto from "node:crypto";

/** @type {import('../types.js').AdapterFactory} */
export function createGithubProjectsAdapter(cfg, store) {
  const pc = cfg.providerConfig;
  const token = pc.token; // resolved from env/.env by loadConfig

  /** POST a GraphQL query/mutation. Returns the parsed `{data, errors}` (any) — the
   * caller reads off `.data` and decides how to treat `.errors`. (The project probe
   * queries `organization` AND `user`, so a partial error there is EXPECTED, not
   * fatal; mutations, by contrast, check `.errors` explicitly.) Throws only on an
   * HTTP transport failure.
   * @param {string} query @param {Record<string,any>} [variables] @returns {Promise<any>} */
  const gql = async (query, variables = {}) => {
    const res = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) throw new Error(`GraphQL ${res.status}`);
    return res.json();
  };

  /** @param {string|null|undefined} s */
  const norm = (s) => (s || "").trim().toLowerCase();
  /** @param {string|string[]|undefined} h → first value of a (possibly repeated) header */
  const first = (h) => (Array.isArray(h) ? h[0] : h);

  // The board: `project` is "owner/number" or a project URL (orgs/<o>/projects/<n>
  // or users/<o>/projects/<n>). Parsed loosely so a missing value just yields no ids
  // (the init probe, which has only {type, token}, can still construct the adapter).
  /** @param {string|undefined} spec @returns {{owner?: string, number?: number}} */
  function parseProject(spec) {
    if (!spec) return {};
    const s = String(spec).trim();
    const url = s.match(/github\.com\/(?:orgs|users)\/([^/]+)\/projects\/(\d+)/i);
    if (url) return { owner: url[1], number: Number(url[2]) };
    const [owner, number] = s.split("/");
    return owner && number ? { owner, number: Number(number) } : {};
  }
  const { owner: projOwner, number: projNumber } = parseProject(pc.project);

  /** Verify GitHub's `x-hub-signature-256: sha256=<hex>` HMAC over the raw body.
   * @param {string|undefined} secret @param {string} raw @param {string|string[]|undefined} sig */
  const verify = (secret, raw, sig) => {
    const sigStr = first(sig);
    if (!secret || !sigStr) return false;
    const hex = sigStr.startsWith("sha256=") ? sigStr.slice(7) : sigStr;
    const computed = crypto.createHmac("sha256", secret).update(raw).digest("hex");
    const a = Buffer.from(computed);
    const b = Buffer.from(hex);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };

  // Webhook secret: NEVER required of the user. An explicit tracker.webhookSecret wins
  // (and `false` disables verification — accept unsigned). Otherwise agenthook GENERATES
  // one, persists it in the profile's secret store, and prints it in registerWebhook.
  const SECRET_KEY = "github-projects:webhookSecret";
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

  // The project node id, resolved once from owner/number (org OR user) and memoised.
  // The PROMISE is memoised so concurrent callers share one in-flight fetch; a failure
  // clears it so a later call retries (rather than caching the rejection).
  /** @type {string|null} */
  let cachedProjectId = null;
  /** @type {Promise<string>|null} */
  let projectIdPromise = null;
  function projectId() {
    if (cachedProjectId) return Promise.resolve(cachedProjectId);
    if (!projectIdPromise) {
      projectIdPromise = (async () => {
        if (!projOwner || !projNumber) throw new Error(`tracker.project is not set (expected "owner/number")`);
        // Probe org AND user roots; the one that isn't the right kind returns null with
        // an error entry we intentionally ignore — we read whichever resolved an id.
        const body = await gql(
          `query($owner:String!,$number:Int!){
             organization(login:$owner){ projectV2(number:$number){ id } }
             user(login:$owner){ projectV2(number:$number){ id } }
           }`,
          { owner: projOwner, number: projNumber },
        );
        const id = body.data?.organization?.projectV2?.id || body.data?.user?.projectV2?.id;
        if (!id) throw new Error(`project "${pc.project}" not found (or token lacks access)`);
        return (cachedProjectId = id);
      })().catch((e) => {
        projectIdPromise = null;
        throw e;
      });
    }
    return projectIdPromise;
  }

  // The project's `Status` single-select field — its node id (gates which edits we act
  // on) plus an option-name → option-id map (advance sets the option). Memoised like
  // the project id.
  /** @type {{id: string, options: Map<string,string>}|null} */
  let cachedField = null;
  /** @type {Promise<{id: string, options: Map<string,string>}>|null} */
  let fieldPromise = null;
  function statusField() {
    if (cachedField) return Promise.resolve(cachedField);
    if (!fieldPromise) {
      fieldPromise = (async () => {
        const id = await projectId();
        const body = await gql(
          `query($id:ID!){ node(id:$id){ ... on ProjectV2 {
             field(name:"Status"){ ... on ProjectV2SingleSelectField { id name options{ id name } } }
           } } }`,
          { id },
        );
        const f = body.data?.node?.field;
        if (!f?.id) throw new Error(`Status field not found on project "${pc.project}"`);
        /** @type {Map<string,string>} */
        const options = new Map();
        for (const o of f.options || []) options.set(norm(o.name), o.id);
        return (cachedField = { id: f.id, options });
      })().catch((e) => {
        fieldPromise = null;
        throw e;
      });
    }
    return fieldPromise;
  }

  // --- pipeline routing (opt-in; null when no pipeline configured) ---
  const pipeline = cfg.pipeline;
  // Assignee scoping — only act on items whose ISSUE is assigned to US, where "us" is
  // the TOKEN'S OWN login (GraphQL `viewer`, cached so the user never pastes a login).
  // An explicit assigneeLogin overrides; assigneeFilter:false = board-wide (any assignee).
  // FAIL CLOSED: if our login can't be resolved, nothing counts as ours, so a foreign
  // item is never moved (we never silently go open). Symmetric with the github tracker.
  const scopeToUser = pc.assigneeFilter !== false;
  let cachedLogin = pc.assigneeLogin || null;
  /** @type {Promise<string>|null} */
  let loginPromise = null;
  /** The token owner's login (the bot). Fetched once from `viewer`, then cached. */
  function ourLogin() {
    if (cachedLogin) return Promise.resolve(cachedLogin);
    if (!loginPromise) {
      loginPromise = (async () => {
        const body = await gql(`query{ viewer{ login } }`);
        const login = body.data?.viewer?.login;
        if (!login) throw new Error(`viewer login unresolved`);
        return (cachedLogin = login);
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
      console.error(`[viewer] could not resolve our login (failing closed):`, e instanceof Error ? e.message : e);
      return false;
    }
  }
  /** Any of the item's issue assignees (issue.assignees.nodes[].login) is us?
   * @param {any} issue @returns {Promise<boolean>} */
  async function issueIsOurs(issue) {
    if (!scopeToUser) return true;
    for (const a of issue?.assignees?.nodes || []) if (a?.login && (await isOurs(a.login))) return true;
    return false;
  }

  /** @param {string} id */
  const stepById = (id) => pipeline?.find((s) => s.id === id);
  /** @param {string|null|undefined} status → the step whose sourceStatus an item now rests in */
  const stepByStatus = (status) => (status ? pipeline?.find((s) => norm(s.sourceStatus) === norm(status)) : undefined);

  // The item's neutral shape: its project-item node id, its content issue node, and the
  // current Status option name (or null). `status` is the GraphQL alias of the item's
  // Status field value; `issue.__typename` distinguishes Issue cards from drafts/PRs.
  /** @param {any} node @returns {{itemId: string, issue: any, status: string|null}} */
  const shapeItem = (node) => ({ itemId: node.id, issue: node.content, status: node.status?.name ?? null });

  const ITEM_FIELDS = `id content{ __typename ... on Issue { number title body url state assignees(first:10){ nodes{ login } } } }
    status: fieldValueByName(name:"Status"){ ... on ProjectV2ItemFieldSingleSelectValue { name } }`;

  /** Read one project item directly by its node id (the webhook hands us this).
   * @param {string} nodeId @returns {Promise<{itemId: string, issue: any, status: string|null}|null>} */
  async function itemByNodeId(nodeId) {
    const body = await gql(`query($id:ID!){ node(id:$id){ ... on ProjectV2Item { ${ITEM_FIELDS} } } }`, { id: nodeId });
    const n = body.data?.node;
    return n ? shapeItem(n) : null;
  }

  /** Every Issue-backed item in the project (paged). Backs find-by-number + listResting —
   * a project has no "issue #N" lookup, so we scan its items. Best-effort full paging.
   * @returns {Promise<Array<{itemId: string, issue: any, status: string|null}>>} */
  async function fetchItems() {
    const id = await projectId();
    /** @type {Array<{itemId: string, issue: any, status: string|null}>} */
    const out = [];
    /** @type {string|null} */
    let after = null;
    for (;;) {
      const body = await gql(
        `query($id:ID!,$after:String){ node(id:$id){ ... on ProjectV2 {
           items(first:100, after:$after){ nodes{ ${ITEM_FIELDS} } pageInfo{ hasNextPage endCursor } }
         } } }`,
        { id, after },
      );
      const conn = body.data?.node?.items;
      if (!conn) break;
      for (const n of conn.nodes || []) out.push(shapeItem(n));
      if (!conn.pageInfo?.hasNextPage) break;
      after = conn.pageInfo.endCursor;
    }
    return out;
  }

  /** The project item whose content is issue #ref, or null. @param {string} ref */
  async function findItem(ref) {
    const items = await fetchItems();
    return items.find((it) => it.issue?.__typename === "Issue" && String(it.issue.number) === String(ref)) || null;
  }

  /** Set the item's Status single-select to a concrete option id (the move). Single-
   * occupancy: one mutation replaces the option, no add-before-remove.
   * @param {string} itemId @param {string} fieldId @param {string} optionId */
  async function setStatus(itemId, fieldId, optionId) {
    const project = await projectId();
    const body = await gql(
      `mutation($project:ID!,$item:ID!,$field:ID!,$option:String!){
         updateProjectV2ItemFieldValue(input:{ projectId:$project, itemId:$item, fieldId:$field,
           value:{ singleSelectOptionId:$option } }){ projectV2Item{ id } }
       }`,
      { project, item: itemId, field: fieldId, option: optionId },
    );
    if (body.errors?.length) throw new Error(`updateProjectV2ItemFieldValue: ${JSON.stringify(body.errors)}`);
  }

  return {
    describe: () => ({
      platform: "GitHub Projects",
      taskNoun: "issue",
      trigger: cfg.trigger,
      commentHowTo: `post a comment with: gh issue comment <number> --body "<text>" (run inside the repo; gh is authenticated via $GITHUB_TOKEN)`,
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

    // One GitHub delivery = one event object; `X-GitHub-Event` names the type (we only
    // care about `projects_v2_item`). We route:
    //   created → the step whose sourceStatus the new item rests in
    //             (state-based key `step:<id>:<ref>` — idempotent).
    //   edited  → ONLY when the changed field is the Status single-select; route to the
    //             step matching the item's NEW Status (event-based key `secmove:<delivery>`).
    // Items whose content isn't an Issue, and non-Status field edits, are ignored.
    async processEvents({ headers, rawBody }) {
      if (norm(first(headers["x-github-event"])) !== "projects_v2_item") return [];
      let ev;
      try {
        ev = JSON.parse(rawBody);
      } catch (e) {
        console.error("[parse]", e instanceof Error ? e.message : e);
        return [];
      }
      if (ev.action !== "created" && ev.action !== "edited") return [];
      const item = ev.projects_v2_item;
      if (!item?.node_id) return [];
      if (item.content_type && norm(item.content_type) !== "issue") return []; // drafts/PRs — not ours to drive

      // An edit fires the step only when it's the Status single-select that changed.
      if (ev.action === "edited") {
        const fv = ev.changes?.field_value;
        if (!fv || norm(fv.field_type) !== "single_select") return []; // not a single-select change
        const field = await statusField();
        if (field?.id && fv.field_node_id && fv.field_node_id !== field.id) return []; // a different single-select
      }

      // The payload omits the value, so read the item's content + current Status live.
      const info = await itemByNodeId(item.node_id);
      if (!info || info.issue?.__typename !== "Issue") return [];
      const ref = String(info.issue.number);
      if (!(await issueIsOurs(info.issue))) {
        console.log(`[assignee] skip #${ref} — not assigned to us`);
        return [];
      }
      const step = stepByStatus(info.status);
      if (!step) return [];

      if (ev.action === "created") return [{ kind: "pipeline", ref, stepId: step.id, dedupKey: `step:${step.id}:${ref}` }];
      const delivery = first(headers["x-github-delivery"]);
      const dedupKey = `secmove:${delivery || `${ref}:${norm(info.status)}`}`;
      return [{ kind: "pipeline", ref, stepId: step.id, dedupKey }];
    },

    async fetchTask(ref) {
      const it = await findItem(ref);
      if (!it) throw new Error(`issue #${ref} not found in project "${pc.project}"`);
      const issue = it.issue || {};
      return {
        ref: String(ref),
        name: issue.title,
        description: typeof issue.body === "string" ? issue.body : "",
        url: issue.url,
        completed: norm(issue.state) === "closed",
        assignedToUs: await issueIsOurs(issue),
      };
    },

    // Resolve a finished step by SETTING the item's Status to the option its verdict
    // maps to — and that Status change is itself the trigger for whatever step that
    // Status sources:
    //   advance → successStatus (the next step's source — drives forward)
    //   fail    → failureStatus (a human picks it up)
    //   hold    → holdStatus    (parked; a human answers + moves it back)
    //   changes → the target step's sourceStatus (re-fires it — the rework loop;
    //             dispatch already resolved verdict.target to a concrete stepId)
    // A missing target status, or a status with no matching Status option, is a logged
    // no-op: the item stays put (like Jira's unreachable transition).
    async advance(ref, stepId, verdict) {
      const step = stepById(stepId);
      if (!step) return;
      const { outcome, target } = verdict;
      let status;
      if (outcome === "advance") status = step.successStatus;
      else if (outcome === "fail") status = step.failureStatus;
      else if (outcome === "hold") status = step.holdStatus;
      else if (outcome === "changes" && target) status = stepById(target)?.sourceStatus;
      if (!status) {
        console.log(`[advance] ${stepId} ${outcome}: no target status — leaving #${ref} in place`);
        return;
      }
      const it = await findItem(ref);
      if (!it) {
        console.log(`[advance] issue #${ref} not in project — leaving in place`);
        return;
      }
      // Mutation chokepoint: never move an item whose issue isn't ours (covers the blind
      // recoverInterrupted path + defense-in-depth for dispatch). Fail-closed.
      if (scopeToUser && !(await issueIsOurs(it.issue))) {
        console.log(`[assignee] refuse to move #${ref} (${stepId}:${outcome}) — not assigned to us`);
        return;
      }
      const field = await statusField();
      const optionId = field.options.get(norm(status));
      if (!optionId) {
        console.log(`[advance] ${stepId} ${outcome}: no "${status}" option on the Status field — leaving #${ref} in place`);
        return;
      }
      await setStatus(it.itemId, field.id, optionId);
      console.log(`[status] moved #${ref} -> ${status} (${stepId}:${outcome}${outcome === "changes" ? `->${target}` : ""})`);
    },

    // Reconcile source (explicit `reconcile` command ONLY — never boot): every open
    // issue-backed item resting in a step's source Status, as a pipeline job for that
    // step. One full item scan; the assignee gate keeps it to our issues.
    async listResting() {
      if (!pipeline) return [];
      /** @type {import('../types.js').Job[]} */
      const jobs = [];
      const seen = new Set();
      for (const it of await fetchItems()) {
        if (it.issue?.__typename !== "Issue") continue;
        if (norm(it.issue.state) === "closed") continue; // resting = still-open work
        const step = stepByStatus(it.status);
        if (!step || step.manual) continue;
        const ref = String(it.issue.number);
        if (seen.has(ref)) continue;
        if (!(await issueIsOurs(it.issue))) continue;
        seen.add(ref);
        jobs.push({ kind: "pipeline", ref, stepId: step.id, dedupKey: `reconcile:${step.id}:${ref}` });
      }
      return jobs;
    },

    // Projects v2 webhooks are ORG-scoped and can't be tied to a rotating tunnel URL,
    // so (like Jira) we print one-time manual setup for an admin and run behind a STABLE
    // ingress. Auto-registration is a later step of the Projects-v2 epic.
    async registerWebhook(publicUrl) {
      const target = `${publicUrl.replace(/\/$/, "")}/github-projects/`;
      const secret = webhookSecret();
      console.log(
        [
          `[github-projects] Projects v2 webhooks are org-scoped; create it ONCE, by hand,`,
          `       as an org admin:`,
          `         Org Settings → Webhooks → Add webhook`,
          `           Payload URL:  ${target}`,
          `           Content type: application/json`,
          `           Events:       "Projects v2 item" (let me select individual events)`,
          secret
            ? `           Secret:       ${secret}`
            : `           Secret:       (none — verification disabled via "webhookSecret": false)`,
          secret ? `         ↑ agenthook generated + stored this. Paste it verbatim into the Secret field.` : ``,
          `       This URL is fixed, so run agenthook behind a STABLE ingress`,
          `       (ngrok reserved 'domain', or a hosted URL) — not an ephemeral tunnel.`,
        ]
          .filter(Boolean)
          .join("\n"),
      );
    },

    // No-op: the webhook is managed by hand in org settings, not by this token.
    async unregisterWebhooks() {
      /* nothing to do — see registerWebhook */
    },
  };
}
