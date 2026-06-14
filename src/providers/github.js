// GitHub Issues adapter. Same interface as asana.js (see its doc-comment).
//
// GitHub specifics:
//   - ONE repo-level webhook covers everything (events: issues, issue_comment).
//     No per-item hook is needed, so ensureCommentWebhook is a no-op.
//   - No handshake. The secret is a value YOU choose and hand to GitHub at
//     creation time; it signs every delivery as `X-Hub-Signature-256: sha256=...`.
//   - Assignment      = issues event, action "assigned"     -> implement
//   - "@agent ..." cmt = issue_comment event, action "created" -> change
//   - dedup key = the X-GitHub-Delivery id (GitHub never reuses it).
import crypto from "node:crypto";

/** @type {import('../types.js').AdapterFactory} */
export function createGithubAdapter(cfg, store) {
  const pc = cfg.providerConfig;
  const token = pc.token; // resolved from env/.env by loadConfig
  const [owner, repo] = /** @type {string} */ (pc.repo).split("/");
  /** @param {string} p @param {RequestInit} [init] */
  const api = (p, init = {}) =>
    fetch(`https://api.github.com${p}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        ...(init.headers || {}),
      },
    });
  // External API payloads are untyped until an adapter maps them — parse as any.
  /** @param {Response} res @returns {Promise<any>} */
  const json = (res) => res.json();

  /** @param {string} ref */
  const numberOf = (ref) => String(ref).split("#").pop();

  /** @param {string} raw @param {string|string[]|undefined} sig */
  const verify = (raw, sig) => {
    const sigStr = Array.isArray(sig) ? sig[0] : sig;
    if (!sigStr || !pc.webhookSecret) return false;
    const expected = "sha256=" + crypto.createHmac("sha256", pc.webhookSecret).update(raw).digest("hex");
    const a = Buffer.from(expected);
    const b = Buffer.from(sigStr);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };

  return {
    describe: () => ({
      platform: "GitHub",
      taskNoun: "issue",
      trigger: cfg.trigger,
      commentHowTo: `post via \`gh issue comment <number> --repo ${pc.repo}\` (or the GitHub API; token in env GITHUB_TOKEN)`,
    }),

    authenticate({ headers, rawBody }) {
      // No handshake — verify every delivery against the configured secret.
      if (!verify(rawBody, headers["x-hub-signature-256"])) {
        console.warn(`[reject] bad signature`);
        return { type: "reject" };
      }
      return { type: "accept" };
    },

    async processEvents({ headers, rawBody }) {
      const event = headers["x-github-event"];
      const delivery = headers["x-github-delivery"];
      if (event === "ping") {
        console.log("[ping] GitHub webhook handshake ok");
        return [];
      }
      let p;
      try {
        p = JSON.parse(rawBody);
      } catch (e) {
        console.error("[parse]", e.message);
        return [];
      }

      if (event === "issues" && p.action === "assigned") {
        if (p.assignee?.login !== pc.assigneeLogin) return [];
        const n = p.issue.number;
        return [{ kind: "implement", ref: `${pc.repo}#${n}`, dedupKey: `gh:${delivery}` }];
      }

      if (event === "issue_comment" && p.action === "created") {
        const text = (p.comment?.body || "").trim();
        if (!text.toLowerCase().startsWith(cfg.trigger.toLowerCase())) return [];
        if (p.comment?.user?.login === pc.assigneeLogin) {
          // Optional self-guard could go here; humans usually request changes, so allow it.
        }
        const n = p.issue.number;
        return [
          {
            kind: "change",
            ref: `${pc.repo}#${n}`,
            text: text.slice(cfg.trigger.length).trim(),
            dedupKey: `gh:${delivery}`,
          },
        ];
      }
      return [];
    },

    async fetchTask(ref) {
      const n = numberOf(ref);
      const res = await api(`/repos/${owner}/${repo}/issues/${n}`);
      if (!res.ok) throw new Error(`issue fetch ${res.status}`);
      const i = await json(res);
      return {
        ref,
        name: i.title,
        description: i.body,
        url: i.html_url,
        completed: i.state === "closed",
        assignedToUs: (i.assignees || []).some((/** @type {any} */ a) => a.login === pc.assigneeLogin),
      };
    },

    // Repo-level issue_comment hook already covers every issue — nothing to do.
    async ensureCommentWebhook() {},

    async registerWebhook(publicUrl) {
      const url = `${publicUrl.replace(/\/$/, "")}/github`;
      // Remove our stale hooks (tunnel URL rotates) before recreating.
      const list = await api(`/repos/${owner}/${repo}/hooks`);
      for (const h of (await json(list)) || []) {
        if (h.config?.url?.endsWith("/github")) {
          await api(`/repos/${owner}/${repo}/hooks/${h.id}`, { method: "DELETE" });
          console.log(`  deleted hook ${h.id}`);
        }
      }
      const res = await api(`/repos/${owner}/${repo}/hooks`, {
        method: "POST",
        body: JSON.stringify({
          name: "web",
          active: true,
          events: ["issues", "issue_comment"],
          config: { url, content_type: "json", secret: pc.webhookSecret, insecure_ssl: "0" },
        }),
      });
      if (!res.ok) throw new Error(`GitHub: ${res.status} ${await res.text()}`);
      const h = await json(res);
      console.log(`Hook created: id=${h.id} active=${h.active} -> ${url}`);
    },

    async unregisterWebhooks() {
      const list = await api(`/repos/${owner}/${repo}/hooks`);
      for (const h of (await json(list)) || []) {
        if (h.config?.url?.endsWith("/github")) {
          await api(`/repos/${owner}/${repo}/hooks/${h.id}`, { method: "DELETE" });
          console.log(`deleted hook ${h.id}`);
        }
      }
    },

    forgeCatchup(ref) {
      const n = numberOf(ref);
      const body = JSON.stringify({ action: "assigned", assignee: { login: pc.assigneeLogin }, issue: { number: Number(n) } });
      const sig = "sha256=" + crypto.createHmac("sha256", /** @type {string} */ (pc.webhookSecret)).update(body).digest("hex");
      return {
        path: "/github",
        body,
        headers: { "X-Hub-Signature-256": sig, "X-GitHub-Event": "issues", "X-GitHub-Delivery": `catchup-${n}` },
        dedupKey: `gh:catchup-${n}`,
      };
    },
  };
}
