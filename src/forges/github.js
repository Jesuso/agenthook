// GitHub forge adapter — the PR side of the pipeline. A tracker says where work comes
// from; a forge says what happened to the code. This one listens for a merged pull
// request on a receiver-made `agent/<ref>` branch and emits a `merge` job, which
// dispatch turns into "move the task to done + mark it completed" on the tracker.
// It also listens for a red Actions `workflow_run` on such a branch and emits a `ci`
// job, which dispatch turns into "re-run the failed jobs once, then bounce to code".
//
// Implements the Forge contract (src/types.js):
//   describe()                 -> { name }
//   authenticate(ctx)          -> {type:'accept'} | {type:'reject'}   (sync, no network)
//   processEvents(ctx)         -> [job]   (merge + ci jobs only; everything else is [])
//   registerWebhook(publicUrl) -> create the repo `pull_request`+`workflow_run` hook (best-effort)
//   unregisterWebhooks()       -> delete this forge's own hook only (by stored id or its own URL)
//   prHead / rerunFailedJobs / failedLogTail / prComment -> the red-CI calls dispatch makes
//
// GitHub specifics:
//   - Path: `/forge` (NOT ending in `/github`, so a github-tracker profile on the same
//     repo — whose hook scrub deletes every `/github` hook — never deletes ours).
//   - Signed with `x-hub-signature-256`, like the github tracker. The secret is an
//     explicit forge.webhookSecret or one agenthook generates + persists. ALWAYS
//     verified: there is no `webhookSecret:false` opt-out here.
//   - Branch → ref: agent branches are `agent/<safeRef(ref)>` (src/worktree.js), and
//     safeRef keeps Asana gids / Jira keys / issue numbers intact, so the ref is the
//     head branch minus `agent/`. No PR-body fallback.
//   - Red CI: only a completed `failure`/`timed_out` run on an `agent/<ref>` branch of
//     THIS repo (a fork's same-named branch is ignored). CI log text goes to a PR
//     comment only — never into a job, a finding or a prompt (the PR head controls it).
//   - Token: `admin:repo_hook` (classic) or Webhooks: Read & write (fine-grained); red
//     CI also needs `repo` (classic) or Actions + Pull requests: Read & write. Or a
//     GitHub App (`auth: {type: "app", …}`, src/github-auth.js; see docs/github-app.md).
import crypto from "node:crypto";
import fs from "node:fs";
import { verifyHubSignature } from "../hmac.js";
import { createGithubAuth, githubFetch } from "../github-auth.js";

export const FORGE_PATH = "/forge";
const BRANCH_PREFIX = "agent/";
const SECRET_KEY = "forge:github:webhookSecret";
// Conclusions that count as red. `cancelled` (superseded push, human stop) does not.
const RED = new Set(["failure", "timed_out"]);
// For the read-only PR roll-up (`listAgentPrs`) a cancelled / startup-failed / action-required run is
// also not green. (RED stays narrower: it decides when the receiver itself reacts to red CI.)
const FAILING = new Set([...RED, "cancelled", "startup_failure", "action_required"]);
const LOG_TAIL_LINES = 60;
const LOG_TAIL_MAX = 6000;

/** The task ref an agent branch belongs to (`agent/123` → `123`), or null for any
 * other branch. @param {string|null|undefined} branch @returns {string|null} */
export function refFromBranch(branch) {
  if (typeof branch !== "string" || !branch.startsWith(BRANCH_PREFIX)) return null;
  const ref = branch.slice(BRANCH_PREFIX.length);
  return ref || null;
}

/** Parse a git remote URL into "owner/name", or null for anything that isn't a
 * github.com remote (ssh, https, scp-like `git@`, with or without `.git`).
 * @param {string|null|undefined} url @returns {string|null} */
export function parseGithubRemote(url) {
  if (typeof url !== "string" || !url) return null;
  const m = url.match(/^(?:https?:\/\/|ssh:\/\/git@|git@)github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

/** What `init` should offer for the forge question: default yes when the tracker
 * is already `github` (reuse its repo) or the repo's remote is github.com (parse
 * it); default no (and no repository) otherwise.
 * @param {{trackerType?: string, trackerRepository?: string, remoteUrl?: string}} opts
 * @returns {{defaultYes: boolean, repository: string|null}} */
export function forgeOffer({ trackerType, trackerRepository, remoteUrl } = {}) {
  if (trackerType === "github" && trackerRepository) return { defaultYes: true, repository: trackerRepository };
  const parsed = parseGithubRemote(remoteUrl);
  return parsed ? { defaultYes: true, repository: parsed } : { defaultYes: false, repository: null };
}

/** `manual` step ids in a pipeline — the only candidates for `completeOnMerge`.
 * @param {import('../types.js').Step[]|undefined|null} pipeline @returns {string[]} */
export function mergeStepCandidates(pipeline) {
  return (pipeline || []).filter((s) => s && s.manual).map((s) => s.id);
}

/** The forge config block `init` writes: just enough to make the forge work. `auth` (the
 * tracker's GitHub App block, reused) replaces the token.
 * @param {{repository: string, tokenEnv?: string, auth?: import('../types.js').GithubAuthConfig}} opts
 * @returns {import('../types.js').ForgeConfig} */
export function forgeBlock({ repository, tokenEnv, auth }) {
  if (auth) return { type: "github", repository, auth };
  return { type: "github", repository, token: `\${${tokenEnv}}` };
}

/** Wrap untrusted log text in a `~` fence longer than any `~` run inside it, so
 * nothing in the log can close the fence early. @param {string} text */
export function fenceLog(text) {
  const longest = Math.max(0, ...(text.match(/~+/g) || []).map((m) => m.length));
  const f = "~".repeat(Math.max(3, longest + 1));
  return `${f}\n${text.replace(/\n$/, "")}\n${f}`;
}

/** Does this request path belong to the forge? Tolerates a trailing slash.
 * @param {string} pathname */
export const isForgePath = (pathname) => pathname === FORGE_PATH || pathname === `${FORGE_PATH}/`;

/** @type {import('../types.js').ForgeFactory} */
export function createGithubForge(cfg, store) {
  const fc = cfg.forge || /** @type {import('../types.js').ForgeConfig} */ ({ type: "github" });
  const auth = createGithubAuth(fc); // a token, or a GitHub App's installation token
  const [owner, repo] = fc.repository ? String(fc.repository).split("/") : [fc.owner, fc.repo];
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
  /** @param {string|string[]|undefined} h */
  const header = (h) => (Array.isArray(h) ? h[0] : h) || "";
  const HOOK_ID_KEY = `forge:github:hookId:${owner}/${repo}`;

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
      `[forge] could not manage the GitHub webhook on ${owner}/${repo} — create it by hand:\n` +
        `  Settings → Webhooks → Add webhook\n` +
        `    Payload URL:  ${target}\n` +
        `    Content type: application/json\n` +
        `    Secret:       ${webhookSecret()}\n` +
        `    Events:       "Let me select individual events" → Pull requests, Workflow runs\n` +
        (auth.app
          ? `  (auto-create needs the GitHub App's Webhooks: Read & write repository permission)`
          : `  (auto-create needs admin:repo_hook (classic) or Webhooks: Read & write (fine-grained))`),
    );
  }

  /** Delete only THIS profile's forge hook — never another profile's `/forge` hook on
   * the same repo. A hook is ours when its id matches the one we persisted on create,
   * or its URL matches our previous URL (pre-change legacy hooks), or (registerWebhook
   * only) it matches the `target` about to be created (same-URL restart dedup).
   * @param {string} [target] @returns {Promise<boolean>} false when listing isn't allowed */
  async function deleteOurHooks(target) {
    const res = await api(`${repoPath()}/hooks?per_page=100`);
    if (res.status === 403 || res.status === 404) return false;
    if (!res.ok) throw new Error(`list hooks ${res.status}`);
    const storedId = store.getSecret(HOOK_ID_KEY);
    for (const h of (await json(res)) || []) {
      const url = (h?.config?.url || "").replace(/\/$/, "");
      if (!url.endsWith(FORGE_PATH)) continue;
      const ours = String(h.id) === storedId || (!!prevTarget && url === prevTarget) || (!!target && url === target);
      if (!ours) continue;
      await api(`${repoPath()}/hooks/${h.id}`, { method: "DELETE" });
      console.log(`  deleted forge webhook ${h.id} -> ${url}`);
    }
    store.setSecret(HOOK_ID_KEY, "");
    return true;
  }

  /** A red Actions run on one of this repo's agent branches → one `ci` job; a green one →
   * one `ci_green` job (a candidate: dispatch-side `ciGreen` re-reads the roll-up and emits only
   * when every check is done). Everything else (cancelled/in-progress, a non-agent or fork
   * branch, the matching flag off) → [].
   * @param {any} ev @returns {import('../types.js').Job[]} */
  function ciJobs(ev) {
    const run = ev?.workflow_run;
    const green = ev?.action === "completed" && run?.conclusion === "success";
    if (green ? fc.greenCi === false : fc.redCi === false) return [];
    if (ev?.action !== "completed" || !(green || RED.has(run?.conclusion))) {
      console.log(`[forge] ignore workflow_run ${run?.id ?? "?"} (${ev?.action}${run?.conclusion ? `, ${run.conclusion}` : ""})`);
      return [];
    }
    const ref = refFromBranch(run?.head_branch);
    if (!ref) {
      console.log(`[forge] ignore red run ${run?.id} — head "${run?.head_branch}" is not an agent/* branch`);
      return [];
    }
    const from = String(run?.head_repository?.full_name || "");
    if (from.toLowerCase() !== `${owner}/${repo}`.toLowerCase()) {
      console.log(`[forge] ignore red run ${run.id} on ${run.head_branch} — from ${from || "?"}, not ${owner}/${repo}`);
      return [];
    }
    const attempt = Number(run.run_attempt) || 1;
    const payload = { runId: run.id, attempt, headSha: run.head_sha, prNumber: run.pull_requests?.[0]?.number ?? null, url: run.html_url };
    if (green) {
      console.log(`[forge] green CI run ${run.id} on ${run.head_branch} → ci_green candidate ${ref}`);
      return [{ kind: "ci_green", ref, stepId: "", dedupKey: `cigreen:${ref}:${run.head_sha}`, ci: payload }];
    }
    console.log(`[forge] red CI run ${run.id} attempt ${attempt} on ${run.head_branch} → ci ${ref}`);
    return [
      {
        kind: "ci",
        ref,
        stepId: "",
        dedupKey: `ci:${run.id}:${attempt}`,
        ci: payload,
      },
    ];
  }

  /** CI roll-up for a head SHA + the PR's mergeability. Shared by `listAgentPrs` and `ciStatus`.
   * @param {number} number @param {string} sha
   * @returns {Promise<{mergeable: boolean|null, mergeState: string|null, ci: import('../types.js').AgentPr['ci']}>} */
  async function prStatus(number, sha) {
    // Detail (mergeable is only on the single-PR endpoint) + check runs, in parallel.
    /** @type {() => Promise<any>} */
    const detail = () => api(`${repoPath()}/pulls/${number}`).then((r) => (r.ok ? json(r) : {})).catch(() => ({}));
    // GitHub computes mergeability lazily: the first read of a fresh/just-pushed PR says null /
    // "unknown". One short retry so that transient value is not cached as the answer.
    const settled = async () => {
      const first = await detail();
      if (first.mergeable !== null && first.mergeable !== undefined) return first;
      await new Promise((r) => setTimeout(r, 1500));
      return detail();
    };
    /** @type {[any, any]} */
    const [d, c] = await Promise.all([
      settled(),
      api(`${repoPath()}/commits/${sha}/check-runs?per_page=100`).then((r) => (r.ok ? json(r) : null)).catch(() => null),
    ]);
    const runs = /** @type {any[]} */ (c?.check_runs || []);
    /** @type {'success'|'failure'|'pending'|'none'|'unknown'} */
    let ci = "none";
    if (c === null) ci = "unknown"; // the call failed — do not read that as "no CI"
    else if (runs.length) {
      if (runs.some((r) => FAILING.has(r.conclusion))) ci = "failure";
      else if (runs.some((r) => r.status !== "completed")) ci = "pending";
      else ci = "success";
    }
    return {
      mergeable: typeof d.mergeable === "boolean" ? d.mergeable : null,
      mergeState: typeof d.mergeable_state === "string" ? d.mergeable_state : null,
      ci,
    };
  }

  return {
    describe: () => ({ name: "github" }),

    // No handshake and no opt-out: a missing/bad signature is always a reject.
    authenticate({ rawBody, headers }) {
      if (!verifyHubSignature(webhookSecret(), rawBody, headers["x-hub-signature-256"])) {
        console.warn("[forge] reject: bad/absent x-hub-signature-256");
        return { type: "reject" };
      }
      return { type: "accept" };
    },

    // Only a merged `pull_request` or a red `workflow_run` on an `agent/<ref>` branch
    // becomes a job. `ping` (sent on hook create) and every other event is ACKed and ignored.
    async processEvents({ headers, rawBody }) {
      const event = header(headers["x-github-event"]).toLowerCase();
      if (event === "ping") return [];
      if (event !== "pull_request" && event !== "workflow_run") {
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
      if (event === "workflow_run") return ciJobs(ev);
      const pr = ev?.pull_request;
      if (ev?.action !== "closed" || pr?.merged !== true) {
        console.log(`[forge] ignore PR #${pr?.number ?? "?"} (${ev?.action}${ev?.action === "closed" ? ", not merged" : ""})`);
        return [];
      }
      const ref = refFromBranch(pr?.head?.ref);
      if (!ref) {
        console.log(`[forge] ignore merged PR #${pr?.number} — head "${pr?.head?.ref}" is not an agent/* branch`);
        return [];
      }
      const step = cfg.pipeline?.find((s) => s.completeOnMerge);
      console.log(`[forge] PR #${pr.number} merged (${pr.head.ref}) → complete ${ref}`);
      return [{ kind: "merge", ref, stepId: step?.id || "", dedupKey: `merged:${pr.number}` }];
    },

    // Scrub our old hooks, then create one on `pull_request` + `workflow_run`. A 403/404 (token lacks
    // hook scope) prints the manual setup instead of failing boot.
    async registerWebhook(publicUrl) {
      const target = `${publicUrl.replace(/\/$/, "")}${FORGE_PATH}`;
      if (!(await deleteOurHooks(target))) {
        printManualSetup(target);
        return;
      }
      const res = await api(`${repoPath()}/hooks`, {
        method: "POST",
        body: JSON.stringify({
          name: "web",
          active: true,
          events: ["pull_request", "workflow_run"],
          config: { url: target, content_type: "json", insecure_ssl: "0", secret: webhookSecret() },
        }),
      });
      if (res.status === 403 || res.status === 404) {
        printManualSetup(target);
        return;
      }
      const body = await json(res);
      if (!res.ok) throw new Error(`GitHub create forge hook ${res.status}: ${JSON.stringify(body)}`);
      store.setSecret(HOOK_ID_KEY, String(body.id));
      console.log(`Forge webhook created: id=${body.id} active=${body.active} -> ${target}`);
    },

    async unregisterWebhooks() {
      if (!(await deleteOurHooks())) console.warn(`[forge] cannot list hooks on ${owner}/${repo} (403/404) — remove the /forge hook by hand`);
    },

    // Open PRs on this repo's receiver-made `agent/<ref>` branches, with a CI roll-up and
    // mergeability (read-only; backs the MCP `prs` tool). Paged (up to 5 x 100 open PRs).
    // CI is conservative for a supervisor that decides merges: anything not clearly green is
    // not `success` — `failure` covers failed / timed-out / cancelled / startup-failure /
    // action-required runs, and `unknown` means the check-runs call itself failed.
    async listAgentPrs() {
      /** @type {any[]} */
      let all = [];
      for (let page = 1; page <= 5; page++) {
        const res = await api(`${repoPath()}/pulls?state=open&per_page=100&page=${page}`);
        if (!res.ok) throw new Error(`list PRs ${res.status}`);
        const batch = (await json(res)) || [];
        all = all.concat(batch);
        if (batch.length < 100) break;
      }
      const prs = all.filter(
        (/** @type {any} */ p) =>
          refFromBranch(p.head?.ref) && p.head?.repo?.full_name?.toLowerCase() === `${owner}/${repo}`.toLowerCase(),
      );
      return Promise.all(
        prs.map(async (/** @type {any} */ p) => {
          const { mergeable, mergeState, ci } = await prStatus(p.number, p.head.sha);
          return {
            number: p.number,
            ref: /** @type {string} */ (refFromBranch(p.head.ref)),
            title: String(p.title ?? ""),
            url: String(p.html_url ?? ""),
            draft: !!p.draft,
            mergeable,
            mergeState,
            ci,
            updatedAt: String(p.updated_at ?? ""),
          };
        }),
      );
    },
    // One known PR's state by number, whatever its branch (backs the `prs` op learning that a
    // recorded PR left `open` without the merge hook firing).
    async prState(prNumber) {
      const res = await api(`${repoPath()}/pulls/${prNumber}`);
      if (!res.ok) throw new Error(`get PR #${prNumber} ${res.status}`);
      const pr = await json(res);
      return pr?.merged_at ? "merged" : pr?.state === "closed" ? "closed" : "open";
    },
    // Roll-up for one PR head (backs the `ci_green` event; same logic as `prs`).
    ciStatus: (prNumber, sha) => prStatus(prNumber, sha),
    // The open-or-not PR for a ref's agent branch and its current head sha. By number
    // when the run names one, else the open PR whose head is `<owner>:agent/<ref>`.
    async prHead(prNumber, ref) {
      const branch = `${BRANCH_PREFIX}${ref}`;
      let pr;
      if (prNumber) {
        const res = await api(`${repoPath()}/pulls/${prNumber}`);
        if (!res.ok) throw new Error(`get PR #${prNumber} ${res.status}`);
        pr = await json(res);
      } else {
        const res = await api(`${repoPath()}/pulls?head=${encodeURIComponent(`${owner}:${branch}`)}&state=open`);
        if (!res.ok) throw new Error(`list PRs for ${branch} ${res.status}`);
        pr = ((await json(res)) || [])[0];
      }
      // Fail closed: a PR whose head isn't this repo's agent branch is not ours to act on.
      if (!pr || pr.head?.ref !== branch || pr.head?.repo?.full_name?.toLowerCase() !== `${owner}/${repo}`.toLowerCase()) return null;
      return { number: pr.number, sha: pr.head.sha, open: pr.state === "open" };
    },

    async rerunFailedJobs(runId) {
      const res = await api(`${repoPath()}/actions/runs/${runId}/rerun-failed-jobs`, { method: "POST" });
      if (!res.ok) throw new Error(`rerun-failed-jobs ${runId} ${res.status}`);
    },

    // Last LOG_TAIL_LINES lines of each failed job's log (fetch follows the redirect to
    // the log blob), capped at LOG_TAIL_MAX chars. Best-effort: any error → "".
    async failedLogTail(runId, attempt) {
      try {
        const res = await api(`${repoPath()}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`);
        if (!res.ok) throw new Error(`list jobs ${res.status}`);
        const failed = ((await json(res))?.jobs || []).filter((/** @type {any} */ j) => j?.conclusion === "failure");
        /** @type {string[]} */
        const parts = [];
        for (const j of failed) {
          const log = await api(`${repoPath()}/actions/jobs/${j.id}/logs`);
          if (!log.ok) continue;
          const lines = (await log.text()).replace(/\n$/, "").split("\n");
          parts.push(`--- ${j.name ?? j.id} ---\n${lines.slice(-LOG_TAIL_LINES).join("\n")}`);
        }
        const out = parts.join("\n\n");
        return out.length > LOG_TAIL_MAX ? `…\n${out.slice(-LOG_TAIL_MAX)}` : out;
      } catch (e) {
        console.warn(`[forge] log tail for run ${runId} failed: ${e.message}`);
        return "";
      }
    },

    // `body` is receiver-written; `log` (untrusted) is fenced so it renders inert.
    async prComment(prNumber, body, log) {
      const text = log ? `${body}\n\n${fenceLog(log)}` : body;
      const res = await api(`${repoPath()}/issues/${prNumber}/comments`, { method: "POST", body: JSON.stringify({ body: text }) });
      if (!res.ok) throw new Error(`comment on PR #${prNumber} ${res.status}`);
    },

    // `agenthook init` discovery: offer the forge, default yes when the tracker is
    // already github or the repo's remote is github.com (both are `answers._forgeOffer`,
    // computed by init before calling this). A `completeOnMerge` pick only appears
    // when the generated pipeline has a manual step to put it on (none today).
    /** @param {Record<string,any>} answers */
    wizardSteps: (answers) => {
      const offer = /** @type {{defaultYes:boolean, repository:string|null}} */ (answers._forgeOffer || { defaultYes: false, repository: null });
      const candidates = /** @type {string[]} */ (answers._mergeStepCandidates || []);
      return [
        { key: "_useForge", message: "Track merges and CI with the GitHub forge?", type: "confirm", default: offer.defaultYes },
        {
          key: "repository",
          message: "Repository whose PRs complete tasks",
          default: offer.repository || "",
          when: (a) => !!a._useForge,
          validate: (v) => (/^[^/\s]+\/[^/\s]+$/.test(v) ? true : "use owner/name"),
        },
        {
          key: "tokenEnv",
          message: "Env var holding the GitHub token",
          default: answers._defaultTokenEnv || "GITHUB_TOKEN",
          // The tracker's GitHub App auth (`_appAuth`) is reused, so no token is asked.
          when: (a) => !!a._useForge && !a._appAuth,
        },
        {
          key: "_completeOnMerge",
          message: "Step to complete on PR merge",
          type: "select",
          when: (a) => !!a._useForge && candidates.length > 0,
          default: candidates[candidates.length - 1],
          choices: candidates.map((id) => ({ title: id, value: id })),
        },
      ];
    },
  };
}
