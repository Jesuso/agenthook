// Asana adapter — the reference implementation of the tracker interface.
//
// An adapter implements:
//   describe()                         -> { platform, taskNoun, trigger, commentHowTo }
//   authenticate({pathname,headers,rawBody}) -> {type:'handshake',headers} | {type:'reject'} | {type:'accept'}
//                                         (fast, no network — lets the engine ACK <10s)
//   processEvents({pathname,headers,rawBody}) -> [job]   (async; may hit the API)
//   fetchTask(ref)                     -> { name, description, url, completed, assignedToUs, ref }
//   advance(ref, stepId, outcome)      -> move the task to the step's success/failure section
//   listResting()                      -> [job] for tasks resting in step sections (reconcile only)
//   registerWebhook(publicUrl)         -> create the project hook (CLI)
//   unregisterWebhooks()               -> delete this provider's hooks (CLI)
//   forgeCatchup(ref)                  -> { path, body, sig } to replay a missed item (CLI)
//
// job: { kind:'pipeline', ref, stepId, dedupKey }
//
// Asana specifics: every webhook carries its OWN X-Hook-Secret, established by a
// handshake POST, so secrets are keyed by request path. One project webhook on
// /mytasks delivers task-added (a task created in a section) and story
// section_changed (a task moved between sections); both route to the step whose
// sourceSectionGid the task now rests in.
import crypto from "node:crypto";

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

  /** @param {string|undefined} secret @param {string} raw @param {string|string[]|undefined} sig */
  const verify = (secret, raw, sig) => {
    const sigStr = Array.isArray(sig) ? sig[0] : sig;
    if (!secret || !sigStr) return false;
    const computed = crypto.createHmac("sha256", secret).update(raw).digest("hex");
    const a = Buffer.from(computed);
    const b = Buffer.from(sigStr);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };

  // Move a task into a project section (Asana: addTask to the section). Opt-in:
  // a falsy gid is a no-op, so the section lifecycle stays an optional feature.
  /** @param {string} ref @param {string|undefined} sectionGid @param {string} label */
  async function moveToSection(ref, sectionGid, label) {
    if (!sectionGid) return;
    const res = await api(`/sections/${sectionGid}/addTask`, {
      method: "POST",
      body: JSON.stringify({ data: { task: ref } }),
    });
    if (!res.ok) throw new Error(`addTask ${res.status}`);
    console.log(`[section] moved ${ref} -> ${label}`);
  }

  /** @param {string} storyGid */
  async function fetchStory(storyGid) {
    const res = await api(`/stories/${storyGid}?opt_fields=text,type,resource_subtype,target.gid`);
    if (!res.ok) throw new Error(`story fetch ${res.status}`);
    return (await json(res)).data;
  }

  // --- pipeline routing (opt-in; null when no pipeline configured) ---
  const pipeline = cfg.pipeline;
  /** @param {string} id */
  const stepById = (id) => pipeline?.find((s) => s.id === id);
  /** @param {string|undefined} sectionGid */
  const stepBySource = (sectionGid) => (sectionGid ? pipeline?.find((s) => s.sourceSectionGid === sectionGid) : undefined);

  // Current section of a task → the step it now rests in (or undefined). We read the
  // task's live membership rather than trusting the move event's payload, so rapid
  // back-to-back moves resolve to the task's actual current state.
  /** @param {string} taskGid */
  async function stepForTask(taskGid) {
    const res = await api(`/tasks/${taskGid}?opt_fields=memberships.section.gid`);
    if (!res.ok) throw new Error(`task section fetch ${res.status}`);
    const m = (await json(res)).data.memberships || [];
    for (const mem of m) {
      const step = stepBySource(mem.section?.gid);
      if (step) return step;
    }
    return undefined;
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
        // A task created directly in a section: route it to that section's step.
        if (rt === "task" && ev.action === "added") {
          const gid = ev.resource.gid;
          if (!gid) continue;
          try {
            const step = await stepForTask(gid);
            if (step) jobs.push({ kind: "pipeline", ref: gid, stepId: step.id, dedupKey: `step:${step.id}:${gid}` });
          } catch (e) {
            console.error(`[pipeline] route task ${gid} failed:`, e.message);
          }
        } else if (rt === "story" && ev.action === "added") {
          // Section move → fire the step the task now rests in. One story gid = one
          // move, so the key dedups webhook retries yet allows a later re-entry.
          const storyGid = ev.resource.gid;
          if (!storyGid || store.hasSeen(`secmove:${storyGid}`)) continue;
          let story;
          try {
            story = await fetchStory(storyGid);
          } catch (e) {
            console.error(`[story] fetch ${storyGid} failed:`, e.message);
            continue;
          }
          if (story.resource_subtype !== "section_changed") continue;
          const taskGid = ev.parent?.gid || story.target?.gid;
          try {
            const step = await stepForTask(taskGid);
            if (step) jobs.push({ kind: "pipeline", ref: taskGid, stepId: step.id, dedupKey: `secmove:${storyGid}` });
          } catch (e) {
            console.error(`[pipeline] route move ${taskGid} failed:`, e.message);
          }
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

    // Resolve a finished step's transition. 'advance' → the step's success
    // section (which is the next step's source, so the move itself fires the next
    // step). 'fail' → the failure section if configured, else leave the task in place
    // for a human. hold/changes are P2.
    async advance(ref, stepId, outcome) {
      const step = stepById(stepId);
      if (!step) return;
      const gid = outcome === "advance" ? step.successSectionGid : outcome === "fail" ? step.failureSectionGid : undefined;
      if (!gid) {
        console.log(`[advance] ${stepId} ${outcome}: no target section — leaving ${ref} in place`);
        return;
      }
      await moveToSection(ref, gid, `${stepId}:${outcome}`);
    },

    // Reconcile source (explicit `reconcile` command ONLY — never boot): every task
    // resting in a step's source section, as a pipeline job for that step. This is
    // the one deliberate board poll, user-triggered, to recover from a missed webhook.
    async listResting() {
      if (!pipeline) return [];
      /** @type {import('../types.js').Job[]} */
      const jobs = [];
      const seenGids = new Set();
      for (const step of pipeline) {
        if (!step.sourceSectionGid || step.manual) continue;
        const res = await api(`/sections/${step.sourceSectionGid}/tasks?opt_fields=completed&limit=100`);
        if (!res.ok) throw new Error(`section ${step.sourceSectionGid} tasks ${res.status}`);
        for (const t of (await json(res)).data || []) {
          if (t.completed || seenGids.has(t.gid)) continue;
          seenGids.add(t.gid);
          jobs.push({ kind: "pipeline", ref: t.gid, stepId: step.id, dedupKey: `reconcile:${step.id}:${t.gid}` });
        }
      }
      return jobs;
    },

    async registerWebhook(publicUrl) {
      const target = `${publicUrl.replace(/\/$/, "")}/mytasks/`;
      // Remove stale hooks first (tunnel URL rotates each boot).
      const list = await api(`/webhooks?workspace=${pc.workspaceGid}&opt_fields=target`);
      for (const w of (await json(list)).data || []) {
        await api(`/webhooks/${w.gid}`, { method: "DELETE" });
        console.log(`  deleted webhook ${w.gid}`);
      }
      // One project webhook delivers task-added (created in a section) and story
      // section_changed (moved between sections) — both route to a step. (The
      // section_changed delivery on a project webhook is verified against Asana.)
      const res = await api(`/webhooks`, {
        method: "POST",
        body: JSON.stringify({
          data: {
            resource: pc.projectGid,
            target,
            filters: [
              { resource_type: "task", action: "added" },
              { resource_type: "story", action: "added", resource_subtype: "section_changed" },
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

    // Forge a signed task-added event for the project hook, so a missed task replays
    // through the whole dispatch path. The server re-reads the task's live section and
    // routes it to the matching step (so this replays whatever step it now rests in).
    // Used by `catchup <ref>` and `reconcile`.
    forgeCatchup(ref) {
      const secret = store.getSecret("/mytasks");
      if (!secret) throw new Error("no /mytasks secret yet — run register first");
      const body = JSON.stringify({ events: [{ action: "added", resource: { gid: ref, resource_type: "task" } }] });
      const sig = crypto.createHmac("sha256", secret).update(body).digest("hex");
      return { path: "/mytasks/", body, headers: { "X-Hook-Signature": sig }, dedupKey: `task:${ref}:added` };
    },

    // `agenthook init` discovery: pick workspace → project, and read the token's user gid.
    wizardSteps: () => [
      {
        key: "workspaceGid",
        message: "Workspace",
        type: "select",
        choices: async () => {
          const res = await api(`/users/me?opt_fields=workspaces.name`);
          if (!res.ok) throw new Error(`Asana /users/me ${res.status}`);
          const me = (await json(res)).data;
          return (me.workspaces || []).map((/** @type {any} */ w) => ({ title: `${w.name} (${w.gid})`, value: w.gid }));
        },
      },
      {
        key: "projectGid",
        message: "Project to watch (tasks added here trigger the agent)",
        type: "select",
        // Live search: typeahead reaches every project by name, sidestepping the /projects
        // list cap (only the first 100 ever come back). Blank query falls back to that listing.
        search: async (query, answers) => {
          const ws = answers.workspaceGid;
          const url = query
            ? `/workspaces/${ws}/typeahead?resource_type=project&query=${encodeURIComponent(query)}&count=${50}&opt_fields=name`
            : `/projects?workspace=${ws}&archived=false&opt_fields=name&limit=100`;
          const res = await api(url);
          if (!res.ok) throw new Error(`Asana project search ${res.status}`);
          return ((await json(res)).data || []).map((/** @type {any} */ p) => ({ title: `${p.name} (${p.gid})`, value: p.gid }));
        },
      },
      {
        key: "userGid",
        message: "Assignee whose tasks the agent works (the token's user)",
        type: "select",
        choices: async () => {
          const res = await api(`/users/me?opt_fields=name`);
          if (!res.ok) throw new Error(`Asana /users/me ${res.status}`);
          const me = (await json(res)).data;
          return [{ title: `${me.name} (${me.gid})`, value: me.gid }];
        },
      },
    ],
  };
}
