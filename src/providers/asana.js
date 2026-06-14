// Asana adapter.
//
// An adapter implements:
//   describe()                         -> { platform, taskNoun, trigger, commentHowTo }
//   authenticate({pathname,headers,rawBody}) -> {type:'handshake',headers} | {type:'reject'} | {type:'accept'}
//                                         (fast, no network — lets the engine ACK <10s)
//   processEvents({pathname,headers,rawBody}) -> [job]   (async; may hit the API)
//   fetchTask(ref)                     -> { name, description, url, completed, assignedToUs, ref }
//   ensureCommentWebhook(ref)          -> create the per-item comment hook (idempotent)
//   registerWebhook(publicUrl)         -> create the top-level hook (CLI)
//   unregisterWebhooks()               -> delete this provider's hooks (CLI)
//   forgeCatchup(ref)                  -> { path, body, sig } to replay a missed item (CLI)
//
// job: { kind:'implement'|'change', ref, text?, dedupKey }
//
// Asana specifics: every webhook carries its OWN X-Hook-Secret, established by a
// handshake POST, so secrets are keyed by request path. Two flows:
//   /mytasks       task enters My Tasks  -> implement
//   /task/<gid>    "@agent ..." comment  -> change
import crypto from "node:crypto";
import fs from "node:fs";

/** @type {import('../types.js').AdapterFactory} */
export function createAsanaAdapter(cfg, store) {
  const pc = cfg.providerConfig;
  const token = pc.token; // resolved from env/.env by loadConfig
  /** @param {string} p @param {RequestInit} [init] */
  const api = (p, init = {}) =>
    fetch(`https://app.asana.com/api/1.0${p}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers || {}) },
    });
  // External API payloads are untyped until an adapter maps them — parse as any.
  /** @param {Response} res @returns {Promise<any>} */
  const json = (res) => res.json();

  /** @param {string} pathname */
  const norm = (pathname) => pathname.replace(/\/$/, "") || "/";
  const baseUrl = () => fs.readFileSync(cfg.publicUrlFile, "utf8").trim().replace(/\/$/, "");

  /** @param {string|undefined} secret @param {string} raw @param {string|string[]|undefined} sig */
  const verify = (secret, raw, sig) => {
    const sigStr = Array.isArray(sig) ? sig[0] : sig;
    if (!secret || !sigStr) return false;
    const computed = crypto.createHmac("sha256", secret).update(raw).digest("hex");
    const a = Buffer.from(computed);
    const b = Buffer.from(sigStr);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };

  /** @param {string} storyGid */
  async function fetchStory(storyGid) {
    const res = await api(`/stories/${storyGid}?opt_fields=text,type,resource_subtype,target.gid`);
    if (!res.ok) throw new Error(`story fetch ${res.status}`);
    return (await json(res)).data;
  }

  return {
    describe: () => ({
      platform: "Asana",
      taskNoun: "task",
      trigger: cfg.trigger,
      commentHowTo: `post via the Asana API (token in env ASANA_TOKEN) using POST /tasks/<gid>/stories`,
    }),

    authenticate({ pathname, headers, rawBody }) {
      const key = norm(pathname);
      const raw = headers["x-hook-secret"];
      const incoming = Array.isArray(raw) ? raw[0] : raw;
      if (incoming) {
        store.setSecret(key, incoming);
        console.log(`[handshake] stored secret for ${key}`);
        return { type: "handshake", headers: { "X-Hook-Secret": incoming } };
      }
      if (!verify(store.getSecret(key), rawBody, headers["x-hook-signature"])) {
        console.warn(`[reject] bad signature on ${key}`);
        return { type: "reject" };
      }
      return { type: "accept" };
    },

    async processEvents({ rawBody }) {
      let events;
      try {
        events = JSON.parse(rawBody).events || [];
      } catch (e) {
        console.error("[parse]", e.message);
        return [];
      }
      /** @type {import('../types.js').Job[]} */
      const jobs = [];
      for (const ev of events) {
        const rt = ev.resource?.resource_type;
        if (rt === "task" && (ev.action === "added" || ev.action === "changed")) {
          const gid = ev.resource.gid;
          if (gid) jobs.push({ kind: "implement", ref: gid, dedupKey: `task:${gid}` });
        } else if (rt === "story" && ev.action === "added") {
          const storyGid = ev.resource.gid;
          if (!storyGid || store.hasSeen(`story:${storyGid}`)) continue; // skip refetch of seen comments
          let story;
          try {
            story = await fetchStory(storyGid);
          } catch (e) {
            console.error(`[story] fetch ${storyGid} failed:`, e.message);
            continue;
          }
          if (story.type !== "comment") continue;
          const text = (story.text || "").trim();
          if (!text.toLowerCase().startsWith(cfg.trigger.toLowerCase())) continue; // not for us
          const taskGid = ev.parent?.gid || story.target?.gid;
          jobs.push({
            kind: "change",
            ref: taskGid,
            text: text.slice(cfg.trigger.length).trim(),
            dedupKey: `story:${storyGid}`,
          });
        }
      }
      return jobs;
    },

    async fetchTask(ref) {
      const res = await api(`/tasks/${ref}?opt_fields=name,notes,permalink_url,assignee.gid,completed`);
      if (!res.ok) throw new Error(`task fetch ${res.status}`);
      const t = (await json(res)).data;
      return {
        ref,
        name: t.name,
        description: t.notes,
        url: t.permalink_url,
        completed: t.completed === true,
        assignedToUs: t.assignee?.gid === pc.userGid,
      };
    },

    async ensureCommentWebhook(ref) {
      const target = `${baseUrl()}/task/${ref}/`;
      const list = await api(`/webhooks?workspace=${pc.workspaceGid}&opt_fields=target`);
      const existing = (await json(list)).data || [];
      if (existing.some((/** @type {any} */ w) => w.target === target)) {
        console.log(`[hook] task ${ref} already watched`);
        return;
      }
      const res = await api(`/webhooks`, {
        method: "POST",
        body: JSON.stringify({
          data: { resource: ref, target, filters: [{ resource_type: "story", action: "added" }] },
        }),
      });
      const body = await json(res);
      if (body.errors) console.error(`[hook] create failed for ${ref}:`, JSON.stringify(body.errors));
      else console.log(`[hook] now watching comments on task ${ref}`);
    },

    async registerWebhook(publicUrl) {
      const target = `${publicUrl.replace(/\/$/, "")}/mytasks/`;
      // Remove stale hooks first (tunnel URL rotates each boot).
      const list = await api(`/webhooks?workspace=${pc.workspaceGid}&opt_fields=target`);
      for (const w of (await json(list)).data || []) {
        await api(`/webhooks/${w.gid}`, { method: "DELETE" });
        console.log(`  deleted webhook ${w.gid}`);
      }
      // Watch a project if configured, else fall back to the My Tasks list. Either
      // way, dispatch gates implement jobs on assignedToUs, so only the configured
      // user's tasks actually run.
      const resource = pc.projectGid || pc.myTasksGid;
      const res = await api(`/webhooks`, {
        method: "POST",
        body: JSON.stringify({
          data: {
            resource,
            target,
            filters: [
              { resource_type: "task", action: "added" },
              { resource_type: "task", action: "changed", fields: ["assignee"] },
            ],
          },
        }),
      });
      const body = await json(res);
      if (body.errors) throw new Error(`Asana: ${JSON.stringify(body.errors)}`);
      console.log(`Webhook created: gid=${body.data.gid} active=${body.data.active} -> ${target}`);
    },

    async unregisterWebhooks() {
      const list = await api(`/webhooks?workspace=${pc.workspaceGid}&opt_fields=target`);
      for (const w of (await json(list)).data || []) {
        await api(`/webhooks/${w.gid}`, { method: "DELETE" });
        console.log(`deleted webhook ${w.gid}`);
      }
    },

    // Forge the exact event Asana POSTs for a newly-assigned task, signed with the
    // live /mytasks secret, so a missed task replays through the whole dispatch path.
    forgeCatchup(ref) {
      const secret = store.getSecret("/mytasks");
      if (!secret) throw new Error("no /mytasks secret yet — run register first");
      const body = JSON.stringify({ events: [{ action: "added", resource: { gid: ref, resource_type: "task" } }] });
      const sig = crypto.createHmac("sha256", secret).update(body).digest("hex");
      return { path: "/mytasks/", body, headers: { "X-Hook-Signature": sig }, dedupKey: `task:${ref}` };
    },
  };
}
