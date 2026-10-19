// GitLab forge adapter — the merge-request side of the pipeline, the GitLab twin of
// github.js. It listens for a merged MR from a receiver-made `agent/<ref>` branch and
// emits a `merge` job, and for a failed / successful pipeline on such a branch and
// emits a `ci` / `ci_green` job. Dispatch handles those jobs exactly as it does GitHub's.
//
// Implements the Forge contract (src/types.js):
//   describe()                 -> { name, agentEnv }
//   authenticate(ctx)          -> {type:'accept'} | {type:'reject'}   (sync, no network)
//   processEvents(ctx)         -> [job]   (merge + ci + ci_green jobs only; everything else is [])
//   registerWebhook(publicUrl) -> create the project MR + pipeline hook (best-effort)
//   unregisterWebhooks()       -> delete this forge's own hook only (by stored id or its own URL)
//   prHead / prState / listAgentPrs / ciStatus / rerunFailedJobs / failedLogTail / prComment
//
// GitLab specifics:
//   - Path: `/forge`, shared with the github forge (only one forge is active per profile).
//   - Auth is a SHARED TOKEN, not an HMAC: GitLab sends the hook's secret token verbatim
//     in `x-gitlab-token`. It proves the sender knows the secret but gives no body
//     integrity, and anyone who sees one request's headers can replay it — so the ingress
//     must be HTTPS. ALWAYS checked (constant time): there is no opt-out.
//   - Branch → ref: same `agent/<ref>` scheme as github (refFromBranch). An MR pipeline's
//     `object_attributes.ref` is `refs/merge-requests/<iid>/head`, so the branch comes from
//     `merge_request.source_branch` when the payload has one.
//   - Retry attempts: GitLab's retry re-runs jobs INSIDE the same pipeline id and reports no
//     attempt number. rerunFailedJobs records a `gitlab:retried:<id>` seen marker and the next
//     failure of that pipeline is attempt 2 — otherwise it would dedup against the first and
//     the bounce + rework cap would never fire.
//   - Forks fail closed: an MR whose source project isn't its target project, or a pipeline
//     in another project, is ignored. CI log text goes to an MR note only (untrusted).
//   - Token: `api` scope, Maintainer role on the project (hooks need Maintainer).
import crypto from "node:crypto";
import fs from "node:fs";
import { FORGE_PATH, refFromBranch, fenceLog } from "./github.js";
import { urlRule } from "../sandbox/egress.js";

const BRANCH_PREFIX = "agent/";
const SECRET_KEY = "forge:gitlab:webhookSecret";
export const DEFAULT_BASE_URL = "https://gitlab.com";
const LOG_TAIL_LINES = 60;
const LOG_TAIL_MAX = 6000;
// Pipeline statuses the receiver reacts to; every other status (running, canceled, skipped, …) is ignored.
const RED = "failed";
const GREEN = "success";

/** The seen-store key recording that we retried a pipeline (so its next failure is attempt 2).
 * @param {number|string} pipelineId */
const retriedKey = (pipelineId) => `gitlab:retried:${pipelineId}`;

/** Parse a git remote URL into `{baseUrl, project}` for a GitLab host (https, ssh://, or
 * scp-like `git@host:`; nested groups; optional `.git`), or null for anything else. The host
 * must contain "gitlab" — a self-managed instance on another host is configured by hand.
 * @param {string|null|undefined} url @returns {{baseUrl: string, project: string}|null} */
export function parseGitlabRemote(url) {
  if (typeof url !== "string" || !url.trim()) return null;
  const s = url.trim();
  let host, baseUrl, project;
  let m = s.match(/^(https?):\/\/(?:[^@/]+@)?([^/:]+)(:\d+)?\/(.+?)(?:\.git)?\/?$/);
  if (m) [host, baseUrl, project] = [m[2], `${m[1]}://${m[2]}${m[3] || ""}`, m[4]];
  else if ((m = s.match(/^ssh:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/))) [host, baseUrl, project] = [m[1], `https://${m[1]}`, m[2]];
  else if ((m = s.match(/^(?:[^@/\s]+@)?([^/:\s]+):(?!\/)(.+?)(?:\.git)?\/?$/))) [host, baseUrl, project] = [m[1], `https://${m[1]}`, m[2]];
  else return null;
  if (!host.toLowerCase().includes("gitlab")) return null;
  const parts = project.split("/");
  if (parts.length < 2 || parts.some((p) => !p)) return null;
  return { baseUrl: baseUrl.toLowerCase(), project };
}

/** What `init` should offer for the gitlab forge question: default yes with the parsed
 * project when the origin remote is GitLab, else default no.
 * @param {{remoteUrl?: string}} [opts]
 * @returns {{defaultYes: boolean, project: string|null, baseUrl: string}} */
export function forgeOffer({ remoteUrl } = {}) {
  const parsed = parseGitlabRemote(remoteUrl);
  return parsed ? { defaultYes: true, ...parsed } : { defaultYes: false, project: null, baseUrl: DEFAULT_BASE_URL };
}

/** The forge config block `init` writes; `baseUrl` only when it isn't gitlab.com.
 * @param {{project: string, baseUrl?: string, tokenEnv: string}} opts
 * @returns {import('../types.js').ForgeConfig} */
export function forgeBlock({ project, baseUrl, tokenEnv }) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  return { type: "gitlab", project, ...(base && base !== DEFAULT_BASE_URL ? { baseUrl: base } : {}), token: `\${${tokenEnv}}` };
}

/** CI roll-up of one MR's head pipeline (GitLab pipeline status → AgentPr ci).
 * @param {any} pipeline @returns {import('../types.js').AgentPr['ci']} */
function ciFromPipeline(pipeline) {
  const st = pipeline?.status;
  if (!st) return "none";
  if (st === "success") return "success";
  if (st === "failed" || st === "canceled") return "failure";
  return "pending"; // running / pending / created / manual / … — not clearly green
}

/** Receiver env vars an agent gets with this forge (#470): none. */
export const GITLAB_FORGE_AGENT_ENV = /** @type {string[]} */ ([]);
/** What a sandboxed run needs to push: the instance's host[:port] (git over HTTPS and the API).
 * @param {{baseUrl?: string}} fc */
export const gitlabForgeEgressHosts = (fc) => {
  const rule = urlRule(fc.baseUrl || DEFAULT_BASE_URL);
  return rule ? [rule] : [];
};

/** @type {import('../types.js').ForgeFactory} */
export function createGitlabForge(cfg, store) {
  const fc = cfg.forge || /** @type {import('../types.js').ForgeConfig} */ ({ type: "gitlab" });
  const token = fc.token;
  const project = String(fc.project || "");
  const baseUrl = String(fc.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  /** @param {string} p @param {RequestInit} [init] */
  const api = (p, init = {}) =>
    fetch(`${baseUrl}/api/v4${p}`, {
      ...init,
      headers: {
        "PRIVATE-TOKEN": String(token || ""),
        "Content-Type": "application/json",
        ...(init.headers || {}),
      },
    });
  // External API payloads are untyped until an adapter maps them — parse as any.
  /** @param {Response} res @returns {Promise<any>} */
  const json = (res) => res.json();
  const projPath = () => `/projects/${encodeURIComponent(project)}`;
  /** @param {string|string[]|undefined} h */
  const header = (h) => (Array.isArray(h) ? h[0] : h) || "";
  const HOOK_ID_KEY = `forge:gitlab:hookId:${project}`;
  /** Is this MR from a branch of the project it targets (not a fork)? @param {any} mr */
  const sameProject = (mr) => mr?.source_project_id != null && mr.source_project_id === mr.target_project_id;

  // Snapshot the previous public URL at construction time — by the time registerWebhook
  // runs, public_url.txt already holds the NEW url (engine.js/webhook.js write it first).
  let prevTarget = "";
  if (cfg.publicUrlFile) {
    try {
      const prevUrl = fs.readFileSync(cfg.publicUrlFile, "utf8").trim().replace(/\/$/, "");
      if (prevUrl) prevTarget = `${prevUrl}${FORGE_PATH}`;
    } catch {
      // no previous URL on first boot — fine
    }
  }

  // Explicit forge.webhookSecret wins; otherwise generate one and persist it.
  function webhookSecret() {
    if (typeof fc.webhookSecret === "string" && fc.webhookSecret) return fc.webhookSecret;
    let s = store.getSecret(SECRET_KEY);
    if (!s) {
      s = crypto.randomBytes(32).toString("hex");
      store.setSecret(SECRET_KEY, s);
    }
    return s;
  }

  /** @param {string} target */
  function printManualSetup(target) {
    console.warn(
      `[forge] could not manage the GitLab webhook on ${project} — create it by hand:\n` +
        `  Settings → Webhooks → Add new webhook\n` +
        `    URL:          ${target}\n` +
        `    Secret token: ${webhookSecret()}\n` +
        `    Trigger:      Merge request events, Pipeline events\n` +
        `    SSL verification: enabled\n` +
        `  (auto-create needs a token with the api scope and the Maintainer role on the project)`,
    );
  }

  /** Delete only THIS profile's forge hook — never another profile's `/forge` hook on
   * the same project. A hook is ours when its id matches the one we persisted on create,
   * or its URL matches our previous URL, or (registerWebhook only) it matches the `target`
   * about to be created (same-URL restart dedup).
   * @param {string} [target] @returns {Promise<boolean>} false when listing isn't allowed */
  async function deleteOurHooks(target) {
    const res = await api(`${projPath()}/hooks?per_page=100`);
    if (res.status === 403 || res.status === 404) return false;
    if (!res.ok) throw new Error(`list hooks ${res.status}`);
    const storedId = store.getSecret(HOOK_ID_KEY);
    for (const h of (await json(res)) || []) {
      const url = (h?.url || "").replace(/\/$/, "");
      if (!url.endsWith(FORGE_PATH)) continue;
      const ours = String(h.id) === storedId || (!!prevTarget && url === prevTarget) || (!!target && url === target);
      if (!ours) continue;
      await api(`${projPath()}/hooks/${h.id}`, { method: "DELETE" });
      console.log(`  deleted forge webhook ${h.id} -> ${url}`);
    }
    store.setSecret(HOOK_ID_KEY, "");
    return true;
  }

  /** A failed pipeline on one of this project's agent branches → one `ci` job; a successful
   * one → one `ci_green` candidate. Everything else (other statuses, a tag, a non-agent or
   * fork branch, another project, the matching flag off) → [].
   * @param {any} ev @returns {import('../types.js').Job[]} */
  function ciJobs(ev) {
    const p = ev?.object_attributes;
    const green = p?.status === GREEN;
    if (green ? fc.greenCi === false : fc.redCi === false) return [];
    if (!green && p?.status !== RED) {
      console.log(`[forge] ignore pipeline ${p?.id ?? "?"} (${p?.status ?? "?"})`);
      return [];
    }
    const mr = ev?.merge_request || null;
    // An MR pipeline's ref is `refs/merge-requests/<iid>/head` — the branch is on the MR.
    const branch = mr ? mr.source_branch : p?.tag ? null : p?.ref;
    const ref = refFromBranch(branch);
    if (!ref) {
      console.log(`[forge] ignore pipeline ${p?.id} — "${branch ?? "?"}" is not an agent/* branch`);
      return [];
    }
    const from = String(ev?.project?.path_with_namespace || "");
    if (from.toLowerCase() !== project.toLowerCase() || (mr && !sameProject(mr))) {
      console.log(`[forge] ignore pipeline ${p.id} on ${branch} — from ${from || "?"}${mr && !sameProject(mr) ? " (fork MR)" : ""}, not ${project}`);
      return [];
    }
    const id = p.id;
    const url = p.url || `${ev?.project?.web_url || ""}/-/pipelines/${id}`;
    if (green) {
      const payload = { runId: id, attempt: 1, headSha: p.sha, prNumber: mr?.iid ?? null, url };
      console.log(`[forge] green pipeline ${id} on ${branch} → ci_green candidate ${ref}`);
      return [{ kind: "ci_green", ref, stepId: "", dedupKey: `cigreen:${ref}:${p.sha}`, ci: payload }];
    }
    store.reloadSeen();
    const attempt = store.hasSeen(retriedKey(id)) ? 2 : 1;
    const payload = { runId: id, attempt, headSha: p.sha, prNumber: mr?.iid ?? null, url };
    console.log(`[forge] red pipeline ${id} attempt ${attempt} on ${branch} → ci ${ref}`);
    return [{ kind: "ci", ref, stepId: "", dedupKey: `ci:${id}:${attempt}`, ci: payload }];
  }

  /** CI roll-up + mergeability for one MR, from the single-MR endpoint (the list endpoint
   * carries no head_pipeline). A `sha` the head pipeline didn't test reads as pending.
   * @param {number} iid @param {string} [sha]
   * @returns {Promise<{mergeable: boolean|null, mergeState: string|null, ci: import('../types.js').AgentPr['ci']}>} */
  async function mrStatus(iid, sha) {
    /** @type {any} */
    const d = await api(`${projPath()}/merge_requests/${iid}`)
      .then((r) => (r.ok ? json(r) : null))
      .catch(() => null);
    if (!d) return { mergeable: null, mergeState: null, ci: "unknown" };
    const ms = typeof d.detailed_merge_status === "string" ? d.detailed_merge_status : null;
    let ci = ciFromPipeline(d.head_pipeline);
    if (sha && d.head_pipeline?.sha && d.head_pipeline.sha !== sha) ci = "pending";
    return {
      mergeable: ms === "mergeable" ? true : ms === null || ms === "checking" || ms === "unchecked" ? null : false,
      mergeState: ms,
      ci,
    };
  }

  return {
    describe: () => ({ name: "gitlab", agentEnv: GITLAB_FORGE_AGENT_ENV, egressHosts: gitlabForgeEgressHosts(fc) }),

    // A shared token, not a signature (see the header). No opt-out: missing/wrong is a reject.
    authenticate({ headers }) {
      const got = Buffer.from(header(headers["x-gitlab-token"]));
      const want = Buffer.from(webhookSecret());
      if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) {
        console.warn("[forge] reject: bad/absent x-gitlab-token");
        return { type: "reject" };
      }
      return { type: "accept" };
    },

    // Only a merged MR or a failed/successful pipeline on an `agent/<ref>` branch becomes a
    // job; every other event is ACKed and ignored.
    async processEvents({ headers, rawBody }) {
      const event = header(headers["x-gitlab-event"]);
      if (event !== "Merge Request Hook" && event !== "Pipeline Hook") {
        console.log(`[forge] ignore event "${event || "?"}"`);
        return [];
      }
      let ev;
      try {
        ev = JSON.parse(rawBody);
      } catch (e) {
        console.error("[forge] parse", e instanceof Error ? e.message : e);
        return [];
      }
      if (event === "Pipeline Hook") return ciJobs(ev);
      const mr = ev?.object_attributes;
      if (mr?.action !== "merge") {
        console.log(`[forge] ignore MR !${mr?.iid ?? "?"} (${mr?.action ?? "?"})`);
        return [];
      }
      const ref = refFromBranch(mr?.source_branch);
      if (!ref) {
        console.log(`[forge] ignore merged MR !${mr.iid} — source "${mr.source_branch}" is not an agent/* branch`);
        return [];
      }
      if (!sameProject(mr) || mr.target_project_id !== ev?.project?.id) {
        console.log(`[forge] ignore merged MR !${mr.iid} — not from ${project} itself (fork)`);
        return [];
      }
      const step = cfg.pipeline?.find((s) => s.completeOnMerge);
      console.log(`[forge] MR !${mr.iid} merged (${mr.source_branch}) → complete ${ref}`);
      return [{ kind: "merge", ref, stepId: step?.id || "", dedupKey: `merged:${mr.iid}` }];
    },

    // Scrub our old hooks, then create one on MR + pipeline events. A 403/404 (token lacks
    // the scope/role) prints the manual setup instead of failing boot.
    async registerWebhook(publicUrl) {
      const target = `${publicUrl.replace(/\/$/, "")}${FORGE_PATH}`;
      if (!(await deleteOurHooks(target))) {
        printManualSetup(target);
        return;
      }
      const res = await api(`${projPath()}/hooks`, {
        method: "POST",
        body: JSON.stringify({
          url: target,
          token: webhookSecret(),
          merge_requests_events: true,
          pipeline_events: true,
          push_events: false,
          enable_ssl_verification: true,
        }),
      });
      if (res.status === 403 || res.status === 404) {
        printManualSetup(target);
        return;
      }
      const body = await json(res);
      if (!res.ok) throw new Error(`GitLab create forge hook ${res.status}: ${JSON.stringify(body)}`);
      store.setSecret(HOOK_ID_KEY, String(body.id));
      console.log(`Forge webhook created: id=${body.id} -> ${target}`);
    },

    async unregisterWebhooks() {
      if (!(await deleteOurHooks())) console.warn(`[forge] cannot list hooks on ${project} (403/404) — remove the /forge hook by hand`);
    },

    // Open MRs from this project's own `agent/<ref>` branches, with a CI roll-up and
    // mergeability (read-only; backs the MCP `prs` tool). Paged (up to 5 x 100 open MRs).
    async listAgentPrs() {
      /** @type {any[]} */
      let all = [];
      for (let page = 1; page <= 5; page++) {
        const res = await api(`${projPath()}/merge_requests?state=opened&per_page=100&page=${page}`);
        if (!res.ok) throw new Error(`list MRs ${res.status}`);
        const batch = (await json(res)) || [];
        all = all.concat(batch);
        if (batch.length < 100) break;
      }
      const mrs = all.filter((/** @type {any} */ m) => refFromBranch(m.source_branch) && sameProject(m));
      return Promise.all(
        mrs.map(async (/** @type {any} */ m) => {
          const { mergeable, mergeState, ci } = await mrStatus(m.iid, m.sha);
          return {
            number: m.iid,
            ref: /** @type {string} */ (refFromBranch(m.source_branch)),
            title: String(m.title ?? ""),
            url: String(m.web_url ?? ""),
            draft: !!(m.draft ?? m.work_in_progress),
            mergeable,
            mergeState,
            ci,
            updatedAt: String(m.updated_at ?? ""),
          };
        }),
      );
    },
    // One known MR's state by iid, whatever its branch.
    async prState(iid) {
      const res = await api(`${projPath()}/merge_requests/${iid}`);
      if (!res.ok) throw new Error(`get MR !${iid} ${res.status}`);
      const mr = await json(res);
      return mr?.state === "merged" ? "merged" : mr?.state === "closed" ? "closed" : "open";
    },
    // Roll-up for one MR head (backs the `ci_green` event; same logic as `prs`).
    ciStatus: (iid, sha) => mrStatus(iid, sha),
    // The open-or-not MR for a ref's agent branch and its current head sha. By iid when the
    // pipeline names one, else the open MR from `agent/<ref>`.
    async prHead(iid, ref) {
      const branch = `${BRANCH_PREFIX}${ref}`;
      let mr;
      if (iid) {
        const res = await api(`${projPath()}/merge_requests/${iid}`);
        if (!res.ok) throw new Error(`get MR !${iid} ${res.status}`);
        mr = await json(res);
      } else {
        const res = await api(`${projPath()}/merge_requests?state=opened&source_branch=${encodeURIComponent(branch)}`);
        if (!res.ok) throw new Error(`list MRs for ${branch} ${res.status}`);
        mr = ((await json(res)) || [])[0];
      }
      // Fail closed: an MR whose source isn't this project's agent branch is not ours to act on.
      if (!mr || mr.source_branch !== branch || !sameProject(mr)) return null;
      return { number: mr.iid, sha: mr.sha, open: mr.state === "opened" };
    },

    // Retry re-runs the failed jobs in the SAME pipeline id; the marker makes its next failure attempt 2.
    async rerunFailedJobs(pipelineId) {
      const res = await api(`${projPath()}/pipelines/${pipelineId}/retry`, { method: "POST" });
      if (!res.ok) throw new Error(`retry pipeline ${pipelineId} ${res.status}`);
      store.markSeen(retriedKey(pipelineId));
    },

    // Last LOG_TAIL_LINES lines of each failed job's trace, capped at LOG_TAIL_MAX chars.
    // Best-effort: any error → "". (The jobs list omits retried jobs, so this is the latest try.)
    async failedLogTail(pipelineId) {
      try {
        const res = await api(`${projPath()}/pipelines/${pipelineId}/jobs?scope[]=failed&per_page=100`);
        if (!res.ok) throw new Error(`list jobs ${res.status}`);
        const failed = (await json(res)) || [];
        /** @type {string[]} */
        const parts = [];
        for (const j of failed) {
          const log = await api(`${projPath()}/jobs/${j.id}/trace`);
          if (!log.ok) continue;
          const lines = (await log.text()).replace(/\n$/, "").split("\n");
          parts.push(`--- ${j.name ?? j.id} ---\n${lines.slice(-LOG_TAIL_LINES).join("\n")}`);
        }
        const out = parts.join("\n\n");
        return out.length > LOG_TAIL_MAX ? `…\n${out.slice(-LOG_TAIL_MAX)}` : out;
      } catch (e) {
        console.warn(`[forge] log tail for pipeline ${pipelineId} failed: ${e.message}`);
        return "";
      }
    },

    // `body` is receiver-written; `log` (untrusted) is fenced so it renders inert.
    async prComment(iid, body, log) {
      const text = log ? `${body}\n\n${fenceLog(log)}` : body;
      const res = await api(`${projPath()}/merge_requests/${iid}/notes`, { method: "POST", body: JSON.stringify({ body: text }) });
      if (!res.ok) throw new Error(`note on MR !${iid} ${res.status}`);
    },

    // `agenthook init` discovery: offered when the origin remote is GitLab (`answers._forgeOffer`,
    // computed by init). A `completeOnMerge` pick only appears when the pipeline has a manual step.
    /** @param {Record<string,any>} answers */
    wizardSteps: (answers) => {
      const offer = /** @type {{defaultYes:boolean, project:string|null, baseUrl:string}} */ (
        answers._forgeOffer || { defaultYes: false, project: null, baseUrl: DEFAULT_BASE_URL }
      );
      const candidates = /** @type {string[]} */ (answers._mergeStepCandidates || []);
      return [
        { key: "_useForge", message: "Track merges and CI with the GitLab forge?", type: "confirm", default: offer.defaultYes },
        {
          key: "project",
          message: "GitLab project whose MRs complete tasks (group/sub/project)",
          default: offer.project || "",
          when: (a) => !!a._useForge,
          validate: (v) => (/^[^/\s]+(\/[^/\s]+)+$/.test(v) ? true : "use group/project (nested groups ok)"),
        },
        {
          key: "baseUrl",
          message: "GitLab base URL",
          default: offer.baseUrl || DEFAULT_BASE_URL,
          when: (a) => !!a._useForge,
          validate: (v) => (/^https?:\/\/[^/\s]+/.test(v) ? true : "use an http(s):// URL"),
        },
        {
          key: "tokenEnv",
          message: "Env var holding the GitLab token",
          default: answers._defaultTokenEnv || "GITLAB_TOKEN",
          when: (a) => !!a._useForge,
        },
        {
          key: "_completeOnMerge",
          message: "Step to complete on MR merge",
          type: "select",
          when: (a) => !!a._useForge && candidates.length > 0,
          default: candidates[candidates.length - 1],
          choices: candidates.map((id) => ({ title: id, value: id })),
        },
      ];
    },
  };
}
