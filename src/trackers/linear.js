// Linear adapter — the section-driven pipeline model mapped onto one team's WORKFLOW
// STATES. Where Jira routes on an issue's status, Linear routes on its state: a step
// binds `sourceStatus` (a state NAME of the team), and an issue entering that state
// fires the step. On a verdict the receiver SETS the issue's state (`issueUpdate` with a
// `stateId` — Linear has free state moves, no transition graph), which is itself the
// Issue update event that fires whatever step that state sources.
//
// Implements the same interface as asana.js (see that file for the canonical
// doc-comment). Linear specifics:
//   - API: GraphQL only, `POST https://api.linear.app/graphql` via the local `gql` helper
//     (responses are `any`; a non-empty `errors[]` throws). A PERSONAL API key goes in
//     `Authorization: <key>` with NO `Bearer ` prefix — `Bearer` is for OAuth tokens only.
//   - The team is `tracker.team`: a team KEY ("ENG") or a team URL
//     (linear.app/<org>/team/<KEY>/…). It resolves once to the team id + its
//     `states{id name type}`, memoised. Step state names resolve case-insensitively; an
//     unknown name throws, naming the step, the key, the value and the team's states.
//   - `ref` is the issue IDENTIFIER ("ENG-123"); `issue(id:)` accepts it as well as the UUID.
//   - "Us" = GraphQL `viewer{id}`, resolved lazily (authenticate can't do I/O) and memoised.
//     Act only when the issue's assignee IS the viewer; a missing assignee, an unresolved
//     viewer or an API error is NOT ours (fail closed). `assigneeFilter:false` = team-wide.
//   - Webhooks: one team webhook (resource types Issue + Comment) on path `/linear/`, created
//     via `webhookCreate` with an agenthook-generated secret (or tracker.webhookSecret;
//     `false` skips verification). Creating one needs a Linear ADMIN — without it,
//     registerWebhook prints manual setup instead of failing boot.
//   - Deliveries are signed `linear-signature: <hex HMAC-SHA256(secret, rawBody)>` and carry
//     `webhookTimestamp` (ms epoch); one more than 60 s from now is rejected as a replay.
//   - The `@agent` resume: a created Comment whose author (`data.userId`) STRICTLY equals the
//     viewer — never the assignee path, so `assigneeFilter:false` doesn't open it up.
//   - No epics: Linear projects/cycles/parents are out of scope (listEpics stays absent).
import crypto from "node:crypto";
import { checkOwner, MoveRefusedError } from "./owner.js";
import { resumeJob, startsWithTrigger } from "../pipeline.js";

const API = "https://api.linear.app/graphql";
// Linear retries a delivery for a while; anything older than this is treated as a replay.
const MAX_SKEW_MS = 60_000;
/** The status-family binding keys a step may set (resolved to state ids). */
const STATUS_KEYS = /** @type {const} */ (["sourceStatus", "successStatus", "failureStatus", "holdStatus", "queueStatus"]);

/** A team key from `tracker.team`: the key itself, or the `/team/<KEY>` segment of a team URL.
 * @param {string|undefined} spec @returns {string} */
export function parseTeam(spec) {
  const s = String(spec || "").trim();
  const url = s.match(/linear\.app\/[^/]+\/team\/([^/?#]+)/i);
  return url ? url[1] : s;
}

/** Verify `linear-signature` (hex HMAC-SHA256 of the raw body). Length-checked before
 * timingSafeEqual (which throws on unequal lengths).
 * @param {string} secret @param {string} raw @param {string|string[]|undefined} sig */
export function verifyLinearSignature(secret, raw, sig) {
  const sigStr = Array.isArray(sig) ? sig[0] : sig;
  if (!secret || !sigStr) return false;
  const a = Buffer.from(crypto.createHmac("sha256", secret).update(raw).digest("hex"));
  const b = Buffer.from(sigStr);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Receiver env vars an agent of this tracker gets (#470): the env var its commentHowTo / readCommentsHowTo tell the agent to use. */
export const LINEAR_AGENT_ENV = /** @type {string[]} */ (["LINEAR_API_KEY"]);
/** The API host commentHowTo / readCommentsHowTo call: a sandboxed run's egress allows it. */
export const linearEgressHosts = () => ["api.linear.app"];

/** @type {import('../types.js').AdapterFactory} */
export function createLinearAdapter(cfg, store) {
  const pc = cfg.providerConfig;
  const token = pc.token; // resolved from env/.env by loadConfig
  const teamKey = parseTeam(pc.team);

  /** POST a GraphQL query/mutation; throws on an HTTP failure or a non-empty `errors[]`.
   * @param {string} query @param {Record<string,any>} [variables] @returns {Promise<any>} */
  const gql = async (query, variables = {}) => {
    const res = await fetch(API, {
      method: "POST",
      // Personal API key: the raw key, NO "Bearer " (that prefix is for OAuth tokens).
      headers: { Authorization: String(token), "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) throw Object.assign(new Error(`Linear GraphQL ${res.status}`), { status: res.status });
    const body = /** @type {any} */ (await res.json());
    if (body?.errors?.length) throw new Error(`Linear GraphQL: ${body.errors.map((/** @type {any} */ e) => e.message).join("; ")}`);
    return body.data;
  };

  /** @param {string|null|undefined} s */
  const norm = (s) => (s || "").trim().toLowerCase();

  // Webhook secret: NEVER required of the user. An explicit tracker.webhookSecret wins
  // (and `false` disables verification — accept unsigned). Otherwise agenthook GENERATES
  // one, persists it in the profile's secret store, and sets it on the hook it creates.
  const SECRET_KEY = "linear:webhookSecret";
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
  /** @param {string} id */
  const stepById = (id) => pipeline?.find((s) => s.id === id);

  /** A team key's id + workflow states. @param {string} key
   * @returns {Promise<{id: string, key: string, states: Array<{id: string, name: string, type: string}>}>} */
  async function fetchTeam(key) {
    if (!key) throw new Error(`linear: tracker.team is not set (a team key like "ENG", or a team URL)`);
    const data = await gql(
      `query($key:String!){ teams(filter:{ key:{ eqIgnoreCase:$key } }){ nodes{ id key name states(first:100){ nodes{ id name type position } } } } }`,
      { key },
    );
    const t = data?.teams?.nodes?.[0];
    if (!t?.id) throw new Error(`linear: team "${key}" not found (or the API key can't see it)`);
    const states = [...(t.states?.nodes || [])].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    return { id: t.id, key: t.key, states: states.map((s) => ({ id: s.id, name: s.name, type: s.type })) };
  }

  // The team, resolved once from tracker.team and memoised — together with every pipeline
  // binding resolved name → state id, so a misspelt state fails here, loudly, naming the
  // team's real states. The PROMISE is memoised so concurrent callers share one fetch; a
  // failure clears it so a later call retries (rather than caching the rejection).
  /** @typedef {{id: string, key: string, states: Array<{id: string, name: string, type: string}>, byName: Map<string, string>, nameById: Map<string, string>}} Team */
  /** @type {Promise<Team>|null} */
  let teamPromise = null;
  function team() {
    if (!teamPromise) {
      teamPromise = (async () => {
        const t = await fetchTeam(teamKey);
        /** @type {Map<string, string>} */
        const byName = new Map();
        /** @type {Map<string, string>} */
        const nameById = new Map();
        for (const s of t.states) {
          byName.set(norm(s.name), s.id);
          nameById.set(s.id, s.name);
        }
        for (const step of pipeline || []) {
          for (const k of STATUS_KEYS) {
            const v = step[k];
            if (v && !byName.has(norm(v)))
              throw new Error(`linear: step "${step.id}" ${k} "${v}" is not a state of team ${t.key} (available: ${t.states.map((s) => s.name).join(", ")})`);
          }
        }
        return { ...t, byName, nameById };
      })().catch((e) => {
        teamPromise = null;
        throw e;
      });
    }
    return teamPromise;
  }
  /** The state id a step binding names (validated by team()). @param {Team} t @param {string|undefined} name */
  const stateIdOf = (t, name) => (name ? t.byName.get(norm(name)) : undefined);
  /** The step whose sourceStatus is the state `stateId`. @param {Team} t @param {string|null|undefined} stateId */
  const stepByStateId = (t, stateId) => (stateId ? pipeline?.find((s) => s.sourceStatus && stateIdOf(t, s.sourceStatus) === stateId) : undefined);

  // Assignee scoping — only act on issues assigned to US, where "us" is the API key's OWN
  // user (GraphQL `viewer`, cached so the user never pastes an id). assigneeFilter:false =
  // team-wide. FAIL CLOSED: if the viewer can't be resolved, nothing counts as ours.
  const scopeToUser = pc.assigneeFilter !== false;
  /** @type {Promise<string>|null} */
  let viewerPromise = null;
  /** The API key owner's user id. Fetched once from `viewer`, then cached (promise memo;
   * a failure clears it so a later call retries). */
  function viewerId() {
    if (!viewerPromise) {
      viewerPromise = (async () => {
        const id = (await gql(`query{ viewer{ id } }`))?.viewer?.id;
        if (!id) throw new Error(`viewer id unresolved`);
        return String(id);
      })().catch((e) => {
        viewerPromise = null;
        throw e;
      });
    }
    return viewerPromise;
  }
  /** Is this user id the viewer? Strict: no assigneeFilter bypass. Uncertain → false.
   * @param {string|null|undefined} id @returns {Promise<boolean>} */
  async function isViewer(id) {
    try {
      return id != null && id === (await viewerId());
    } catch (e) {
      console.error(`[viewer] could not resolve our user id (failing closed):`, e.message);
      return false;
    }
  }
  /** @param {string|null|undefined} assigneeId → is this assignee us? (true when scoping off) */
  const isOurs = (assigneeId) => (scopeToUser ? isViewer(assigneeId) : Promise.resolve(true));

  /** @param {string} ref @param {Record<string,any>} input */
  async function updateIssue(ref, input) {
    const data = await gql(`mutation($id:String!,$input:IssueUpdateInput!){ issueUpdate(id:$id, input:$input){ success } }`, { id: ref, input });
    if (!data?.issueUpdate?.success) throw new Error(`issueUpdate ${ref}: not successful`);
  }

  /** Move `ref` to the state named `name` (a validated binding). @param {string} ref @param {string} name @param {string} label */
  async function moveTo(ref, name, label) {
    const stateId = stateIdOf(await team(), name);
    if (!stateId) throw new Error(`linear: no state "${name}"`);
    await updateIssue(ref, { stateId });
    console.log(`[state] moved ${ref} -> ${name} (${label})`);
  }

  // Fail-closed owner check gating issue MUTATION (advance/enterStage). Only a 2xx with a
  // matching assignee is "ours"; a transient 5xx/429/network error is retried, and anything
  // still uncertain (incl. a GraphQL error) is "check_failed" (never "ours").
  /** @param {string} ref @returns {Promise<"ours"|"not_ours"|"check_failed">} */
  function ownedByUs(ref) {
    return checkOwner(async () => {
      try {
        const data = await gql(`query($id:String!){ issue(id:$id){ assignee{ id } } }`, { id: ref });
        return { ok: true, status: 200, mine: await isOurs(data?.issue?.assignee?.id) };
      } catch (e) {
        return { ok: false, status: typeof e.status === "number" ? e.status : 400 };
      }
    });
  }

  /** Issues of our team resting in the state `stateId` (one page of 100 — reconcile and the
   * queue pull are best-effort recovery reads), in board order (`sortOrder`, top first).
   * @param {Team} t @param {string} stateId @returns {Promise<any[]>} */
  async function issuesInState(t, stateId) {
    const data = await gql(
      `query($team:ID!,$state:ID!){ issues(first:100, filter:{ team:{ id:{ eq:$team } }, state:{ id:{ eq:$state } } }){
         nodes{ id identifier sortOrder assignee{ id } state{ id type } } } }`,
      { team: t.id, state: stateId },
    );
    return [...(data?.issues?.nodes || [])].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  }

  /** Delete every webhook of our team whose URL is one of ours (path ends `/linear`). Scoped
   * to our path + team so unrelated hooks are never touched. Throws on a failed list. */
  async function deleteOurHooks() {
    const t = await team();
    const data = await gql(`query{ webhooks(first:100){ nodes{ id url team{ id } } } }`);
    for (const h of data?.webhooks?.nodes || []) {
      const url = String(h?.url || "");
      if (h?.team?.id !== t.id || !url.replace(/\/$/, "").endsWith("/linear")) continue;
      await gql(`mutation($id:String!){ webhookDelete(id:$id){ success } }`, { id: h.id });
      console.log(`  deleted webhook ${h.id} -> ${url}`);
    }
  }

  /** A pipeline job for an Issue create / state-change delivery, or [] when it isn't ours to run.
   * @param {any} ev @returns {Promise<import('../types.js').Job[]>} */
  async function jobFromIssue(ev) {
    const d = ev.data || {};
    const ref = d.identifier;
    if (!ref || !d.stateId) return [];
    const stateChange = ev.action === "update" && ev.updatedFrom && "stateId" in ev.updatedFrom;
    if (ev.action !== "create" && !stateChange) return []; // an update that didn't move state
    const t = await team();
    if (d.teamId && d.teamId !== t.id) return [];
    const step = stepByStateId(t, d.stateId);
    if (!step) return [];
    if (!(await isOurs(d.assigneeId))) {
      console.log(`[assignee] skip ${ref} — not assigned to us`);
      return [];
    }
    if (ev.action === "create") return [{ kind: "pipeline", ref, stepId: step.id, dedupKey: `step:${step.id}:${ref}` }];
    // updatedAt moves with every change → dedups retries of THIS move yet lets a later
    // re-entry into the same state (the rework loop) fire again.
    return [{ kind: "pipeline", ref, stepId: step.id, dedupKey: `secmove:${d.id}:${d.updatedAt ?? ev.webhookTimestamp}` }];
  }

  /** The `@agent` comment trigger. Emits a resume job only when ALL hold (anything uncertain
   * → no job): a newly created comment whose body starts with cfg.trigger, authored by the
   * viewer (strict — assigneeFilter:false does NOT open this up), on an issue that passes the
   * assignee gate, which is held on a runnable step under its attempt cap (resumeJob).
   * @param {any} ev @returns {Promise<import('../types.js').Job[]>} */
  async function resumeFromComment(ev) {
    if (ev.action !== "create") return [];
    const c = ev.data || {};
    if (c.id == null || !startsWithTrigger(cfg.trigger, c.body)) return [];
    if (!(await isViewer(c.userId))) {
      console.log(`[trigger] comment ${c.id} not by our user — ignoring`);
      return [];
    }
    const issueId = c.issueId ?? c.issue?.id;
    if (!issueId) return [];
    const issue = (await gql(`query($id:String!){ issue(id:$id){ identifier assignee{ id } } }`, { id: issueId }))?.issue;
    const ref = issue?.identifier;
    if (!ref) return [];
    if (!(await isOurs(issue.assignee?.id))) {
      console.log(`[trigger] ${ref}: not assigned to us — ignoring`);
      return [];
    }
    const job = resumeJob(cfg, store, ref, String(c.id), c.body);
    return job ? [job] : [];
  }

  /** The init wizard's state picks for the team the user chose. @param {Record<string,any>} a */
  const stateChoices = async (a) => (await fetchTeam(String(a.team || ""))).states.map((s) => ({ title: s.name, value: s.name }));

  return {
    describe: () => ({
      platform: "Linear",
      taskNoun: "issue",
      trigger: cfg.trigger,
      commentHowTo: `post a comment with curl: curl -s ${API} -H "Authorization: $LINEAR_API_KEY" -H "Content-Type: application/json" -d '{"query":"mutation($i:String!,$b:String!){commentCreate(input:{issueId:$i,body:$b}){success}}","variables":{"i":"<identifier>","b":"<text>"}}' (your key is in the env as $LINEAR_API_KEY)`,
      readCommentsHowTo: `curl -s ${API} -H "Authorization: $LINEAR_API_KEY" -H "Content-Type: application/json" -d '{"query":"query($i:String!){issue(id:$i){comments{nodes{body createdAt user{name}}}}}","variables":{"i":"<identifier>"}}'`,
      agentEnv: LINEAR_AGENT_ENV,
      egressHosts: linearEgressHosts(),
      stageKeys: { source: "sourceStatus", success: "successStatus", failure: "failureStatus", hold: "holdStatus", queue: "queueStatus" },
    }),

    listStages: async () => (await fetchTeam(teamKey)).states.map((s) => ({ id: s.name, label: s.name })),

    // No handshake. With a secret: verify the HMAC, THEN reject a stale webhookTimestamp
    // (replay). Without one (webhookSecret:false): accept. Sync + no network.
    authenticate({ rawBody, headers }) {
      const secret = webhookSecret();
      if (!secret) return { type: "accept" };
      if (!verifyLinearSignature(secret, rawBody, headers["linear-signature"])) {
        console.warn("[reject] bad/absent linear-signature");
        return { type: "reject" };
      }
      let ts;
      try {
        ts = Number(JSON.parse(rawBody)?.webhookTimestamp);
      } catch {
        ts = NaN;
      }
      if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > MAX_SKEW_MS) {
        console.warn("[reject] linear webhookTimestamp missing or outside the 60s window (replay?)");
        return { type: "reject" };
      }
      return { type: "accept" };
    },

    // One Linear delivery = one event object. We route:
    //   Issue create / update with `updatedFrom.stateId` → the step whose sourceStatus is the
    //     NEW state (`step:<id>:<ref>` on create; `secmove:<issueId>:<updatedAt>` on a move).
    //   Comment create → the `@agent` resume of the issue's held step (`trigger:<comment.id>`).
    // Anything else, or any lookup failure (logged), yields no job — fail closed.
    async processEvents({ rawBody }) {
      let ev;
      try {
        ev = JSON.parse(rawBody);
      } catch (e) {
        console.error("[parse]", e.message);
        return [];
      }
      try {
        if (ev?.type === "Issue") return await jobFromIssue(ev);
        if (ev?.type === "Comment") return await resumeFromComment(ev);
      } catch (e) {
        console.error(`[linear] ${ev.type} ${ev.action} delivery dropped (failing closed):`, e.message);
      }
      return [];
    },

    async fetchTask(ref) {
      const data = await gql(
        `query($id:String!){ issue(id:$id){ identifier title description url assignee{ id } state{ name type } } }`,
        { id: ref },
      );
      const i = data?.issue;
      if (!i) throw new Error(`linear: issue ${ref} not found`);
      return {
        ref,
        name: i.title,
        description: typeof i.description === "string" ? i.description : "",
        url: i.url,
        completed: i.state?.type === "completed" || i.state?.type === "canceled",
        assignedToUs: await isOurs(i.assignee?.id),
        displayId: i.identifier || ref,
      };
    },

    // Resolve a finished step by setting the issue to the state its verdict maps to — and
    // that state change is itself the trigger for whatever step the state sources:
    //   advance → successStatus · fail → failureStatus · hold → holdStatus (unset: stay)
    //   changes → the target step's sourceStatus (the rework loop)
    async advance(ref, stepId, verdict) {
      const step = stepById(stepId);
      if (!step) return;
      // Mutation chokepoint: never move an issue that isn't ours (covers the blind
      // recoverInterrupted path + defense-in-depth for dispatch). Fail-closed.
      const owner = scopeToUser ? await ownedByUs(ref) : "ours";
      if (owner !== "ours") {
        const why = owner === "not_ours" ? "not assigned to us" : "owner check failed";
        console.log(`[assignee] refuse to move ${ref} (${stepId}:${verdict.outcome}) — ${why}`);
        throw new MoveRefusedError(owner === "not_ours" ? "not_ours" : "owner_check_failed", `refused to move ${ref}: ${why}`);
      }
      const { outcome, target } = verdict;
      let status;
      if (outcome === "advance") status = step.successStatus;
      else if (outcome === "fail") status = step.failureStatus;
      else if (outcome === "hold") status = step.holdStatus;
      else if (outcome === "changes" && target) status = stepById(target)?.sourceStatus;
      if (!status) {
        console.log(`[advance] ${stepId} ${outcome}: no target state — leaving ${ref} in place`);
        return;
      }
      await moveTo(ref, status, `${stepId}:${outcome}${outcome === "changes" ? `->${target}` : ""}`);
    },

    // Inject work into a step (`agenthook run`): assign the issue to us (unless
    // opts.assign===false), then set it INTO the step's source state — that state change
    // is itself the Issue update event that fires the step.
    /** @param {string} ref @param {string} stepId @param {{assign?: boolean}} [opts] */
    async enterStage(ref, stepId, opts = {}) {
      const step = stepById(stepId);
      if (!step) throw new Error(`unknown step "${stepId}"`);
      if (!step.sourceStatus) throw new Error(`step "${stepId}" has no sourceStatus to enter`);
      if (opts.assign !== false) await updateIssue(ref, { assigneeId: await viewerId() });
      else if (scopeToUser) {
        // Not assigning it to ourselves → it must already be ours (same fail-closed gate as advance).
        const owner = await ownedByUs(ref);
        if (owner !== "ours") throw new MoveRefusedError(owner === "not_ours" ? "not_ours" : "owner_check_failed", `refused to move ${ref}: ${owner === "not_ours" ? "not assigned to us" : "owner check failed"}`);
      }
      await moveTo(ref, step.sourceStatus, `${stepId}:enter`);
      return { stage: step.sourceStatus };
    },

    // The pipeline state an issue currently sits in (any source/success/failure/hold state
    // of any step, as the config names it), or null. Read-only; no assignee gate.
    async currentStage(ref) {
      if (!pipeline) return null;
      const name = (await gql(`query($id:String!){ issue(id:$id){ state{ name } } }`, { id: ref }))?.issue?.state?.name;
      if (!name) return null;
      for (const s of pipeline) for (const st of [s.sourceStatus, s.successStatus, s.failureStatus, s.holdStatus]) if (st && norm(st) === norm(name)) return st;
      return null;
    },

    // Reconcile source (explicit `reconcile` command ONLY — never boot): our issues resting
    // in a step's source state, as pipeline jobs for that step.
    async listResting() {
      if (!pipeline) return [];
      const t = await team();
      /** @type {import('../types.js').Job[]} */
      const jobs = [];
      const seen = new Set();
      for (const step of pipeline) {
        const stateId = stateIdOf(t, step.sourceStatus);
        if (!stateId || step.manual) continue;
        for (const it of await issuesInState(t, stateId)) {
          if (seen.has(it.identifier)) continue;
          if (!(await isOurs(it.assignee?.id))) continue;
          seen.add(it.identifier);
          jobs.push({ kind: "pipeline", ref: it.identifier, stepId: step.id, dedupKey: `reconcile:${step.id}:${it.identifier}` });
        }
      }
      return jobs;
    },

    // Queue-stage source (the one narrow boot/run_end board read — see engine pullQueued):
    // our open issues in the step's opt-in queueStatus, in board order. [] without the key.
    /** @param {string} stepId */
    async listQueued(stepId) {
      const step = stepById(stepId);
      if (!step?.queueStatus || step.manual) return [];
      const t = await team();
      const stateId = stateIdOf(t, step.queueStatus);
      if (!stateId) return [];
      /** @type {string[]} */
      const refs = [];
      for (const it of await issuesInState(t, stateId)) {
        if (it.state?.type === "completed" || it.state?.type === "canceled") continue;
        if (!(await isOurs(it.assignee?.id))) continue;
        refs.push(it.identifier);
      }
      return refs;
    },

    ownership: ownedByUs,

    // Scrub our stale team hooks, then create one (Issue + Comment) signed with the
    // generated secret. A bad tracker.team / state name throws (a config error should stop
    // boot, loudly); any WEBHOOK API failure — typically a non-admin key — prints manual
    // setup instead, so the receiver keeps serving.
    async registerWebhook(publicUrl) {
      const target = `${publicUrl.replace(/\/$/, "")}/linear/`;
      const secret = webhookSecret();
      const t = await team();
      try {
        await deleteOurHooks();
        const data = await gql(
          `mutation($input:WebhookCreateInput!){ webhookCreate(input:$input){ success webhook{ id enabled } } }`,
          { input: { url: target, teamId: t.id, resourceTypes: ["Issue", "Comment"], label: "agenthook", ...(secret ? { secret } : {}) } },
        );
        if (!data?.webhookCreate?.success) throw new Error(`webhookCreate not successful`);
        console.log(`Webhook created: id=${data.webhookCreate.webhook?.id} enabled=${data.webhookCreate.webhook?.enabled} -> ${target}`);
      } catch (e) {
        console.log(
          [
            `[linear] couldn't create the team webhook with this API key (${e.message}) —`,
            `       creating webhooks needs a Linear ADMIN. Create it ONCE, by hand:`,
            `         Settings → API → Webhooks → New webhook`,
            `           URL:            ${target}`,
            `           Team:           ${t.key}`,
            `           Resource types: Issues, Comments`,
            secret
              ? `           Secret:         ${secret}`
              : `           Secret:         (none — verification disabled via "webhookSecret": false)`,
            secret ? `         ↑ agenthook generated + stored this. Paste it verbatim into the webhook's secret.` : ``,
            `       A hand-made URL can't rotate, so run behind a STABLE ingress`,
            `       (ngrok reserved 'domain', or a hosted URL) — not an ephemeral tunnel.`,
          ]
            .filter(Boolean)
            .join("\n"),
        );
      }
    },

    async unregisterWebhooks() {
      await deleteOurHooks();
    },

    // Forge a signed Issue `create` event for the issue's live state, so a missed issue
    // replays through the whole dispatch path. dedupKey mirrors processEvents' create path
    // (`step:<id>:<ref>`) so `catchup --force` clears the key the server actually writes.
    /** @param {string} ref @param {string} [stepId] */
    async forgeCatchup(ref, stepId) {
      const t = await team();
      let step = stepId ? stepById(stepId) : undefined;
      let issueId = ref;
      if (!step) {
        const i = (await gql(`query($id:String!){ issue(id:$id){ id identifier assignee{ id } state{ id } } }`, { id: ref }))?.issue;
        if (!i) throw new Error(`linear: issue ${ref} not found`);
        if (!(await isOurs(i.assignee?.id))) throw new Error(`${ref} is not assigned to us`);
        issueId = i.id;
        step = stepByStateId(t, i.state?.id);
      }
      const me = await viewerId().catch(() => undefined);
      const body = JSON.stringify({
        action: "create",
        type: "Issue",
        data: { id: issueId, identifier: ref, teamId: t.id, stateId: stateIdOf(t, step?.sourceStatus) ?? null, assigneeId: me ?? null },
        webhookTimestamp: Date.now(),
      });
      /** @type {Record<string, string>} */
      const headers = {};
      const secret = webhookSecret();
      if (secret) headers["Linear-Signature"] = crypto.createHmac("sha256", secret).update(body).digest("hex");
      const dedupKey = step ? `step:${step.id}:${ref}` : `issue:${ref}:created`;
      return { path: "/linear/", body, headers, dedupKey, stepId: step?.id };
    },

    // `agenthook init` discovery. LINEAR_API_KEY is the only secret (init's token-env step);
    // "us" is the viewer and the webhook secret is generated, so neither is asked. Pick one of
    // the viewer's teams, then bind the code step to that team's real states.
    wizardSteps: () => [
      {
        key: "team",
        message: "Linear team whose workflow states drive the pipeline",
        type: "select",
        choices: async () => {
          const data = await gql(`query{ viewer{ teams(first:100){ nodes{ key name } } } }`);
          const teams = data?.viewer?.teams?.nodes || [];
          if (!teams.length) throw new Error(`no Linear teams visible to this API key`);
          return teams.map((/** @type {any} */ x) => ({ title: `${x.key} — ${x.name}`, value: x.key }));
        },
      },
      { key: "_sourceStage", message: "State that FIRES the code step (an issue entering it triggers the agent)", type: "select", choices: stateChoices },
      { key: "_successStage", message: "State to set on SUCCESS (hand off to the next stage, e.g. review or done)", type: "select", choices: stateChoices },
      { key: "_failureStage", message: "State to set on FAILURE (blocked — a human picks it up)", type: "select", choices: stateChoices },
      {
        key: "_holdStage",
        message: "State to set when the agent needs an answer (hold)",
        type: "select",
        default: "",
        choices: async (a) => [{ title: "(skip — leave it in place)", value: "" }, ...(await stateChoices(a))],
      },
      {
        key: "_doneStage",
        message: "State for DONE — a merged PR moves the task here (skip = no done step)",
        type: "select",
        default: "",
        choices: async (a) => [{ title: "(skip — no done step)", value: "" }, ...(await stateChoices(a))],
      },
    ],

    // Map the wizard's live state picks to this tracker's step bindings. Null when the user
    // never reached the state picks, so init falls back to the TODO_* skeleton. The hold key
    // is added only when a hold state was picked — never written as "".
    /** @param {Record<string,any>} a */
    pipelineBindings: (a) =>
      a._sourceStage
        ? { sourceStatus: a._sourceStage, successStatus: a._successStage, failureStatus: a._failureStage, ...(a._holdStage ? { holdStatus: a._holdStage } : {}) }
        : null,
  };
}
