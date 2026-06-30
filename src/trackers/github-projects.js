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
//     run behind a STABLE ingress. For an ORG-owned project registerWebhook auto-creates
//     (and scrubs) the projects_v2_item org hook via REST, signed with the generated
//     secret, falling back to PRINTED manual setup when the token lacks admin:org_hook.
//     A USER-owned project has no PAT webhook path at all (projects_v2_item is delivered
//     only by an org webhook or a GitHub App), so it just prints why. The assignee "us"
//     is the token owner's login (GraphQL `viewer`, cached). Scoping is FAIL CLOSED.
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

  /** Call the GitHub REST API (sibling of `gql`, used only for org webhook CRUD —
   * Projects v2 itself is GraphQL). Returns the raw Response; the caller reads
   * `.ok`/`.status` and `.json()` (untyped: `any`).
   * @param {string} path @param {RequestInit} [init] @returns {Promise<Response>} */
  const rest = (path, init = {}) =>
    fetch(`https://api.github.com${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
        ...(init.headers || {}),
      },
    });

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
  /** Which root resolved the project id — picks the webhook endpoint / message.
   * @type {"org"|"user"|null} */
  let ownerType = null;
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
        const orgId = body.data?.organization?.projectV2?.id;
        const id = orgId || body.data?.user?.projectV2?.id;
        if (!id) throw new Error(`project "${pc.project}" not found (or token lacks access)`);
        ownerType = orgId ? "org" : "user";
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

  // Resolve a project field's NAME from its node id. Used to identify the field a
  // `projects_v2_item` edit touched WITHOUT trusting that the webhook's `field_node_id`
  // is byte-equal to the GraphQL field id — the two could differ in format, and a hard
  // id-equality gate would silently drop real Status changes (see #35). Name is on the
  // ProjectV2FieldCommon interface. Returns null on any miss (caller decides).
  /** @param {string} nodeId @returns {Promise<string|null>} */
  async function fieldNameByNodeId(nodeId) {
    try {
      const body = await gql(`query($id:ID!){ node(id:$id){ ... on ProjectV2FieldCommon { name } } }`, { id: nodeId });
      return body.data?.node?.name ?? null;
    } catch {
      return null;
    }
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
  // The token owner's USER node id (the bot), for the assign mutation `enterStage` runs.
  // Separate from `ourLogin` (which routing/scoping uses) and memoised the same way.
  /** @type {string|null} */
  let cachedUserId = null;
  /** @type {Promise<string>|null} */
  let userIdPromise = null;
  function viewerId() {
    if (cachedUserId) return Promise.resolve(cachedUserId);
    if (!userIdPromise) {
      userIdPromise = (async () => {
        const body = await gql(`query{ viewer{ id } }`);
        const id = body.data?.viewer?.id;
        if (!id) throw new Error(`viewer id unresolved`);
        return (cachedUserId = id);
      })().catch((e) => {
        userIdPromise = null;
        throw e;
      });
    }
    return userIdPromise;
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

  const ITEM_FIELDS = `id content{ __typename ... on Issue { id number title body url state assignees(first:10){ nodes{ login } } } }
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

  // --- `agenthook run` write primitives (enterStage): assign + add-to-project ---
  /** Resolve issue #ref's GraphQL node id from tracker.repository. Needed ONLY to ADD a
   * loose backlog issue to the project — an issue already on the board is found via
   * findItem (a number alone can't name a repo, so the add path requires `repository`).
   * @param {string} ref @returns {Promise<string>} */
  async function issueNodeId(ref) {
    const repo = pc.repository ? String(pc.repository) : null;
    if (!repo) throw new Error(`issue #${ref} is not in project "${pc.project}" and tracker.repository is unset — add it to the project, or set "repository":"owner/name"`);
    const [o, r] = repo.split("/");
    const body = await gql(`query($o:String!,$r:String!,$n:Int!){ repository(owner:$o,name:$r){ issue(number:$n){ id } } }`, { o, r, n: Number(ref) });
    const id = body.data?.repository?.issue?.id;
    if (!id) throw new Error(`issue #${ref} not found in ${repo}`);
    return id;
  }
  /** Add an issue (by its content node id) to the project as a new item; returns the item
   * node id. Idempotent on GitHub's side — re-adding an existing item returns it.
   * @param {string} contentId @returns {Promise<string>} */
  async function addItem(contentId) {
    const project = await projectId();
    const body = await gql(
      `mutation($p:ID!,$c:ID!){ addProjectV2ItemById(input:{ projectId:$p, contentId:$c }){ item{ id } } }`,
      { p: project, c: contentId },
    );
    if (body.errors?.length) throw new Error(`addProjectV2ItemById: ${JSON.stringify(body.errors)}`);
    const id = body.data?.addProjectV2ItemById?.item?.id;
    if (!id) throw new Error(`addProjectV2ItemById returned no item`);
    return id;
  }
  /** Assign the issue (by its node id) to us (the token owner). ADDS without clobbering
   * existing assignees, so the item clears the fail-closed scope gate. @param {string} assignableId */
  async function assignIssue(assignableId) {
    const me = await viewerId();
    const body = await gql(
      `mutation($a:ID!,$u:[ID!]!){ addAssigneesToAssignable(input:{ assignableId:$a, assigneeIds:$u }){ clientMutationId } }`,
      { a: assignableId, u: [me] },
    );
    if (body.errors?.length) throw new Error(`addAssigneesToAssignable: ${JSON.stringify(body.errors)}`);
  }

  /** Delete every ORG webhook whose target URL is one of ours (path ends `/github-projects`).
   * Scoped to our own path so unrelated org hooks are never touched. Mirrors github.js's
   * repo-hook scrub against `/orgs/{org}/hooks`. Throws on a failed list (the caller decides
   * whether to fall back). @returns {Promise<void>} */
  async function deleteOurHooks() {
    const res = await rest(`/orgs/${projOwner}/hooks?per_page=100`);
    if (!res.ok) throw new Error(`list org hooks ${res.status}`);
    for (const h of /** @type {any[]} */ ((await res.json()) || [])) {
      const url = h?.config?.url || "";
      if (url.replace(/\/$/, "").endsWith("/github-projects")) {
        await rest(`/orgs/${projOwner}/hooks/${h.id}`, { method: "DELETE" });
        console.log(`  deleted webhook ${h.id} -> ${url}`);
      }
    }
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
        // Is the edited single-select OUR Status field? Fast path: node-id match. On a
        // mismatch we do NOT assume "different field" — the webhook's field_node_id and the
        // GraphQL field id could differ in format, and dropping there would silently stall
        // every Status change (the assumption #35 flagged). Instead resolve the changed
        // field's NAME ("Status" is how statusField itself locates it) and skip only when
        // it's positively something else. An unresolvable name falls through (logged), so a
        // real Status change is never silently lost; the live re-read below still gates it.
        if (fv.field_node_id && !(field?.id && fv.field_node_id === field.id)) {
          const changedName = await fieldNameByNodeId(fv.field_node_id);
          if (changedName != null && norm(changedName) !== "status") return []; // a genuinely different single-select
          if (changedName == null)
            console.warn(`[edited] changed field ${fv.field_node_id} ≠ Status id ${field?.id} and name unresolved — routing via live Status re-read (see #35)`);
        }
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

    // Inject work into a step (`agenthook run`): assign the issue to us (unless
    // opts.assign===false) and SET the item's Status to the step's sourceStatus — that
    // Status change is itself the `projects_v2_item` edited event that fires the step (no
    // special dispatch path). An issue that isn't a card yet is ADDED to the project first
    // (needs tracker.repository to resolve its node id). Reuses advance's setStatus primitive.
    /** @param {string} ref @param {string} stepId @param {{assign?: boolean}} [opts] */
    async enterStage(ref, stepId, opts = {}) {
      const step = stepById(stepId);
      if (!step) throw new Error(`unknown step "${stepId}"`);
      if (!step.sourceStatus) throw new Error(`step "${stepId}" has no sourceStatus to enter`);
      const field = await statusField();
      const optionId = field.options.get(norm(step.sourceStatus));
      if (!optionId) throw new Error(`no "${step.sourceStatus}" option on the project's Status field`);

      // The issue may already be a card (the common case) or a loose backlog issue we add.
      let it = await findItem(ref);
      let contentId = it?.issue?.id;
      if (!it) {
        contentId = await issueNodeId(ref); // throws clearly if tracker.repository is unset
        it = { itemId: await addItem(contentId), issue: null, status: null };
      }
      if (opts.assign !== false && contentId) await assignIssue(contentId);
      await setStatus(it.itemId, field.id, optionId);
      return { stage: step.sourceStatus };
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

    // Projects v2 webhooks are ORG-scoped and tied to a fixed URL (run behind a STABLE
    // ingress). For an ORG-owned project: scrub our stale hooks, then create one
    // `projects_v2_item` org hook signed with the generated secret — falling back to
    // PRINTED manual setup when the token lacks admin:org_hook (403/404). For a USER-owned
    // project there is no PAT/UI webhook path at all, so we print why. registerWebhook is
    // awaited UNGUARDED at boot, so it must never throw — every failure keeps the receiver
    // serving by printing instructions instead.
    async registerWebhook(publicUrl) {
      const target = `${publicUrl.replace(/\/$/, "")}/github-projects/`;
      const secret = webhookSecret();
      // Copy-pasteable org-webhook setup — printed when the token can't create the hook.
      const printManual = () =>
        console.log(
          [
            `[github-projects] couldn't create the org webhook with this token (needs`,
            `       admin:org_hook). Create it ONCE, by hand, as an org admin:`,
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

      let type;
      try {
        await projectId(); // resolves the project node id + memoises ownerType
        type = ownerType;
      } catch (e) {
        console.warn(`[github-projects] project "${pc.project}" unresolved (${e instanceof Error ? e.message : e}) — printing manual setup`);
        printManual();
        return;
      }

      if (type !== "org") {
        // User-owned Projects v2 have NO token/UI webhook path: GitHub's REST exposes only
        // repo + org hooks, and projects_v2_item is an org-webhook (or GitHub App) event.
        console.log(
          [
            `[github-projects] "${pc.project}" is USER-owned — Projects v2 webhooks can't be`,
            `       registered with a PAT: GitHub delivers projects_v2_item only via an ORG`,
            `       webhook or a GitHub App, and personal accounts have no webhook settings.`,
            `       Move the project under an organization (or use a GitHub App) to receive events.`,
          ].join("\n"),
        );
        return;
      }

      // Org-owned: scrub our stale hooks, then create one signed projects_v2_item hook. A
      // missing-scope 403/404 (on either the list or the create) falls back to manual setup.
      try {
        await deleteOurHooks();
        const res = await rest(`/orgs/${projOwner}/hooks`, {
          method: "POST",
          body: JSON.stringify({
            name: "web",
            active: true,
            events: ["projects_v2_item"],
            config: { url: target, content_type: "json", insecure_ssl: "0", ...(secret ? { secret } : {}) },
          }),
        });
        if (res.status === 403 || res.status === 404) return void printManual();
        const body = /** @type {any} */ (await res.json());
        if (!res.ok) throw new Error(`create org hook ${res.status}: ${JSON.stringify(body)}`);
        console.log(`Webhook created: id=${body.id} active=${body.active} -> ${target}`);
      } catch (e) {
        // deleteOurHooks() may 403 first, or transport may fail — keep serving, print setup.
        console.warn(`[github-projects] org webhook auto-create failed (${e instanceof Error ? e.message : e}) — printing manual setup`);
        printManual();
      }
    },

    // Scrub our org hooks for an org-owned project with scope; otherwise a no-op (a
    // user-owned project, or an unresolvable one, has no token-managed hook to delete).
    async unregisterWebhooks() {
      let type;
      try {
        await projectId(); // memoises ownerType
        type = ownerType;
      } catch {
        return; // project unresolvable — nothing of ours to scrub
      }
      if (type !== "org") return;
      await deleteOurHooks();
    },

    // Forge a signed `created` projects_v2_item event for the issue's CURRENT Status, so a
    // missed item replays through the whole dispatch path. Unlike the github tracker (which
    // forges from ref+label alone), Projects v2 routing needs the item node_id, so findItem
    // ALWAYS runs — passing stepId only skips the stepByStatus lookup, not the item fetch.
    // `created` avoids the edited path's changes.field_value gate; the server reads the item
    // live and routes by its current Status. dedupKey mirrors the created path
    // (`step:<id>:<ref>`) so `catchup --force` clears the key the server actually writes.
    // Used by `catchup <number>` and `reconcile`.
    /** @param {string} ref @param {string} [stepId] */
    async forgeCatchup(ref, stepId) {
      const it = await findItem(ref);
      if (!it) throw new Error(`issue #${ref} not found in project "${pc.project}"`);
      if (!(await issueIsOurs(it.issue))) throw new Error(`#${ref} is not assigned to us`);
      const step = stepId ? stepById(stepId) : stepByStatus(it.status);
      const body = JSON.stringify({ action: "created", projects_v2_item: { node_id: it.itemId, content_type: "Issue" } });
      /** @type {Record<string, string>} */
      const headers = { "X-GitHub-Event": "projects_v2_item", "X-GitHub-Delivery": `agenthook-forge-${ref}` };
      const secret = webhookSecret();
      if (secret) headers["X-Hub-Signature-256"] = "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");
      const dedupKey = step ? `step:${step.id}:${ref}` : `issue:${ref}:created`;
      return { path: "/github-projects/", body, headers, dedupKey, stepId: step?.id };
    },

    // `agenthook init` discovery. GITHUB_TOKEN is the only secret (handled by init's
    // token-env step); the login is derived from `viewer`, so it isn't asked. The picked
    // project's Status single-select options are discovered live and bound to the code
    // step (no TODO_* editing). Mirrors the github tracker's label discovery.
    wizardSteps: () => {
      // GitHub Projects v2 ships "Todo"/"In Progress"/"Done"; these are the agenthook
      // convention (matching the github label tracker). They're used as the picker's
      // default only — the real options come from the board, so a default the board
      // doesn't have just means you type a number instead of hitting Enter.
      const DEFAULTS = ["In Progress", "In Review", "Blocked"];
      // The Status single-select options of the project the user just picked (a.project =
      // "owner/number"). `pc.project` isn't set yet at init, so this reads the picked
      // answer rather than the factory's cached owner/number (like github reads a.repository).
      /** @param {Record<string,any>} a @returns {Promise<Array<{title:string,value:any}>>} */
      const statusOptions = async (a) => {
        const { owner, number } = parseProject(a.project);
        if (!owner || !number) throw new Error(`pick a project first`);
        const probe = await gql(
          `query($owner:String!,$number:Int!){
             organization(login:$owner){ projectV2(number:$number){ id } }
             user(login:$owner){ projectV2(number:$number){ id } }
           }`,
          { owner, number },
        );
        const id = probe.data?.organization?.projectV2?.id || probe.data?.user?.projectV2?.id;
        if (!id) throw new Error(`project "${a.project}" not found (or token lacks access)`);
        const body = await gql(
          `query($id:ID!){ node(id:$id){ ... on ProjectV2 {
             field(name:"Status"){ ... on ProjectV2SingleSelectField { options{ name } } }
           } } }`,
          { id },
        );
        const opts = body.data?.node?.field?.options;
        if (!opts?.length) throw new Error(`project "${a.project}" has no Status single-select field options`);
        return opts.map((/** @type {any} */ o) => ({ title: o.name, value: o.name }));
      };
      return [
        {
          key: "project",
          message: "Projects v2 board whose Status field drives the pipeline",
          type: "select",
          // The token owner's projects: their user-owned boards plus every org they belong
          // to. Value is "owner/number" — the shape parseProject expects. Caps at 100 each;
          // a project beyond that can be set by hand as "project": "owner/number".
          choices: async () => {
            const body = await gql(
              `query{ viewer{ login
                 projectsV2(first:100){ nodes{ number title } }
                 organizations(first:100){ nodes{ login projectsV2(first:100){ nodes{ number title } } } }
               } }`,
            );
            const v = body.data?.viewer;
            if (!v?.login) throw new Error(`could not list your Projects v2 (token access?)`);
            /** @type {Array<{title:string,value:string}>} */
            const out = [];
            for (const p of v.projectsV2?.nodes || []) out.push({ title: `${v.login}/${p.number} — ${p.title}`, value: `${v.login}/${p.number}` });
            for (const org of v.organizations?.nodes || [])
              for (const p of org.projectsV2?.nodes || []) out.push({ title: `${org.login}/${p.number} — ${p.title}`, value: `${org.login}/${p.number}` });
            return out;
          },
        },
        { key: "_sourceStage", message: "Status that FIRES the code step (an item entering it triggers the agent)", type: "select", default: DEFAULTS[0], choices: statusOptions },
        { key: "_successStage", message: "Status to set on SUCCESS (hand off to review)", type: "select", default: DEFAULTS[1], choices: statusOptions },
        { key: "_failureStage", message: "Status to set on FAILURE (blocked — a human picks it up)", type: "select", default: DEFAULTS[2], choices: statusOptions },
      ];
    },

    // Map the wizard's live Status picks to this tracker's step bindings. Null when the
    // user never reached the Status picks, so init falls back to the TODO_* skeleton.
    /** @param {Record<string,any>} a */
    pipelineBindings: (a) =>
      a._sourceStage ? { sourceStatus: a._sourceStage, successStatus: a._successStage, failureStatus: a._failureStage } : null,
  };
}
