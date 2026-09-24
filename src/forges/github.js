// GitHub forge adapter — the PR side of the pipeline. A tracker says where work comes
// from; a forge says what happened to the code. This one listens for a merged pull
// request on a receiver-made `agent/<ref>` branch and emits a `merge` job, which
// dispatch turns into "move the task to done + mark it completed" on the tracker.
//
// Implements the Forge contract (src/types.js):
//   describe()                 -> { name }
//   authenticate(ctx)          -> {type:'accept'} | {type:'reject'}   (sync, no network)
//   processEvents(ctx)         -> [job]   (merge jobs only; everything else is [])
//   registerWebhook(publicUrl) -> create the repo `pull_request` hook (best-effort)
//   unregisterWebhooks()       -> delete this forge's hooks only
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
//   - Token: `admin:repo_hook` (classic) or Webhooks: Read & write (fine-grained).
import crypto from "node:crypto";
import { verifyHubSignature } from "../hmac.js";

export const FORGE_PATH = "/forge";
const BRANCH_PREFIX = "agent/";
const SECRET_KEY = "forge:github:webhookSecret";

/** The task ref an agent branch belongs to (`agent/123` → `123`), or null for any
 * other branch. @param {string|null|undefined} branch @returns {string|null} */
export function refFromBranch(branch) {
  if (typeof branch !== "string" || !branch.startsWith(BRANCH_PREFIX)) return null;
  const ref = branch.slice(BRANCH_PREFIX.length);
  return ref || null;
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
        `    Events:       "Let me select individual events" → Pull requests\n` +
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

    // Only a merged `pull_request` on an `agent/<ref>` branch becomes a job. `ping`
    // (sent on hook create) and every other event is ACKed and ignored.
    async processEvents({ headers, rawBody }) {
      const event = header(headers["x-github-event"]).toLowerCase();
      if (event === "ping") return [];
      if (event !== "pull_request") {
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

    // Scrub our old hooks, then create one on `pull_request`. A 403/404 (token lacks
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
          events: ["pull_request"],
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
  };
}
