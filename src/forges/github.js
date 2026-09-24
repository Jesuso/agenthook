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
//   unregisterWebhooks()       -> delete this forge's hooks only
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
//     CI also needs `repo` (classic) or Actions + Pull requests: Read & write.
import crypto from "node:crypto";
import { verifyHubSignature } from "../hmac.js";

export const FORGE_PATH = "/forge";
const BRANCH_PREFIX = "agent/";
const SECRET_KEY = "forge:github:webhookSecret";
// Conclusions that count as red. `cancelled` (superseded push, human stop) does not.
const RED = new Set(["failure", "timed_out"]);
const LOG_TAIL_LINES = 60;
const LOG_TAIL_MAX = 6000;

/** The task ref an agent branch belongs to (`agent/123` → `123`), or null for any
 * other branch. @param {string|null|undefined} branch @returns {string|null} */
export function refFromBranch(branch) {
  if (typeof branch !== "string" || !branch.startsWith(BRANCH_PREFIX)) return null;
  const ref = branch.slice(BRANCH_PREFIX.length);
  return ref || null;
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
  const token = fc.token;
  const [owner, repo] = fc.repository ? String(fc.repository).split("/") : [fc.owner, fc.repo];
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
  /** @param {string|string[]|undefined} h */
  const header = (h) => (Array.isArray(h) ? h[0] : h) || "";

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
        `  (auto-create needs admin:repo_hook (classic) or Webhooks: Read & write (fine-grained))`,
    );
  }

  /** Delete every repo hook whose URL ends in `/forge` (ours). Never touches `/github`
   * or any tracker hook. @returns {Promise<boolean>} false when listing isn't allowed */
  async function deleteOurHooks() {
    const res = await api(`${repoPath()}/hooks?per_page=100`);
    if (res.status === 403 || res.status === 404) return false;
    if (!res.ok) throw new Error(`list hooks ${res.status}`);
    for (const h of (await json(res)) || []) {
      const url = h?.config?.url || "";
      if (url.replace(/\/$/, "").endsWith(FORGE_PATH)) {
        await api(`${repoPath()}/hooks/${h.id}`, { method: "DELETE" });
        console.log(`  deleted forge webhook ${h.id} -> ${url}`);
      }
    }
    return true;
  }

  /** A red Actions run on one of this repo's agent branches → one `ci` job. Everything
   * else (green/cancelled/in-progress, a non-agent or fork branch, redCi:false) → [].
   * @param {any} ev @returns {import('../types.js').Job[]} */
  function ciJobs(ev) {
    const run = ev?.workflow_run;
    if (fc.redCi === false) return [];
    if (ev?.action !== "completed" || !RED.has(run?.conclusion)) {
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
    console.log(`[forge] red CI run ${run.id} attempt ${attempt} on ${run.head_branch} → ci ${ref}`);
    return [
      {
        kind: "ci",
        ref,
        stepId: "",
        dedupKey: `ci:${run.id}:${attempt}`,
        ci: { runId: run.id, attempt, headSha: run.head_sha, prNumber: run.pull_requests?.[0]?.number ?? null, url: run.html_url },
      },
    ];
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
      if (!(await deleteOurHooks())) {
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
      console.log(`Forge webhook created: id=${body.id} active=${body.active} -> ${target}`);
    },

    async unregisterWebhooks() {
      if (!(await deleteOurHooks())) console.warn(`[forge] cannot list hooks on ${owner}/${repo} (403/404) — remove the /forge hook by hand`);
    },

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
  };
}
