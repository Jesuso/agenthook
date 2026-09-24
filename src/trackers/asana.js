// Asana adapter — the reference implementation of the tracker interface.
//
// An adapter implements:
//   describe()                         -> { platform, taskNoun, trigger, commentHowTo }
//   authenticate({pathname,headers,rawBody}) -> {type:'handshake',headers} | {type:'reject'} | {type:'accept'}
//                                         (fast, no network — lets the engine ACK <10s)
//   processEvents({pathname,headers,rawBody}) -> [job]   (async; may hit the API)
//   fetchTask(ref)                     -> { name, description, url, completed, assignedToUs, ref, routeKeys }
//   advance(ref, stepId, verdict)      -> move the task to the section its outcome maps to
//                                         (advance/fail/hold section, or a `changes` target's source)
//   listResting()                      -> [job] for tasks resting in step sections (reconcile only)
//   listQueued(stepId)                 -> [ref] in the step's opt-in queue section, board order
//                                         (optional; only on run_end + once on boot, never a timer)
//   complete(ref)                      -> mark the task completed (optional; forge merge)
//   registerWebhook(publicUrl)         -> create the project hook (CLI)
//   unregisterWebhooks()               -> delete this provider's hooks (CLI)
//   forgeCatchup(ref)                  -> { path, body, sig } to replay a missed item (CLI)
//
// job: { kind:'pipeline', ref, stepId, dedupKey, comment? }
//
// Asana specifics: every webhook carries its OWN X-Hook-Secret, established by a
// handshake POST, so secrets are keyed by request path. One project webhook on
// /mytasks delivers task-added (a task created in a section) and story
// section_changed (a task moved between sections); both route to the step whose
// sourceSectionGid the task now rests in — unless the task has an incomplete "blocked
// by" dependency, in which case it rests there until its last blocker completes (task
// changed `completed` → the unblock release fires it).
// sourceSectionGid the task now rests in. The same hook's story comment_added carries
// the `@agent` resume: an OWNER-authored (created_by = userGid) comment starting with
// cfg.trigger on a held task re-runs the step that held, with the comment as `comment`.
import crypto from "node:crypto";
import { startsWithTrigger, resumeJob } from "../pipeline.js";

/**
 * Raw route keys from the custom field named `fieldName` (case-insensitive). Values are
 * returned as-is — `repos.normalizeKeys` does the lowercasing/dedup. Unset/absent → [].
 * @param {any} customFields
 * @param {string | undefined} fieldName
 * @returns {string[]}
 */
export function extractRouteKeys(customFields, fieldName) {
  const cf = findCustomField(customFields, fieldName);
  if (!cf) return [];
  const clean = (/** @type {any[]} */ vs) => vs.filter((v) => typeof v === "string" && v.trim() !== "");
  const multi = Array.isArray(cf.multi_enum_values) ? clean(cf.multi_enum_values.map((/** @type {any} */ v) => v?.name)) : [];
  if (multi.length) return multi;
  for (const v of [cf.enum_value?.name, cf.text_value, cf.display_value]) {
    const c = clean([v]);
    if (c.length) return c;
  }
  return [];
}

/** @param {any} customFields @param {string | undefined} fieldName */
function findCustomField(customFields, fieldName) {
  if (!fieldName || !Array.isArray(customFields)) return undefined;
  const want = String(fieldName).trim().toLowerCase();
  return customFields.find((f) => String(f?.name ?? "").trim().toLowerCase() === want);
}

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

  // Assign a task to us (pc.userGid). Required before injecting work so the task clears
  // the fail-closed scope gate. No userGid → we can't say who "us" is, so refuse.
  /** @param {string} ref */
  async function assignToUs(ref) {
    if (!pc.userGid) throw new Error("cannot assign — tracker.userGid is not set");
    const res = await api(`/tasks/${ref}`, { method: "PUT", body: JSON.stringify({ data: { assignee: pc.userGid } }) });
    if (!res.ok) throw new Error(`assign ${res.status}`);
  }

  /** @param {string} storyGid */
  async function fetchStory(storyGid) {
    const res = await api(`/stories/${storyGid}?opt_fields=text,type,resource_subtype,target.gid,created_by.gid`);
    if (!res.ok) throw new Error(`story fetch ${res.status}`);
    return (await json(res)).data;
  }

  // --- pipeline routing (opt-in; null when no pipeline configured) ---
  const pipeline = cfg.pipeline;
  // Assignee scoping — only act on tasks assigned to us. ON by default; ONLY an
  // explicit assigneeFilter:false opts into project-wide (any task, any assignee).
  // FAIL CLOSED: with scoping on but userGid unset, NOTHING qualifies as ours, so we
  // refuse every task rather than silently go project-wide. Going open is therefore
  // always a deliberate config choice, never an omission. (Symmetric with Jira.)
  const scopeToUser = pc.assigneeFilter !== false;
  /** @param {string|null|undefined} gid → is this assignee us? (false unless scoping off) */
  const isOurs = (gid) => !scopeToUser || (pc.userGid != null && gid === pc.userGid);
  /** @param {string} id */
  const stepById = (id) => pipeline?.find((s) => s.id === id);
  /** @param {string|undefined} sectionGid */
  const stepBySource = (sectionGid) => (sectionGid ? pipeline?.find((s) => s.sourceSectionGid === sectionGid) : undefined);
  /** Every distinct section gid the pipeline uses (source/success/failure/hold of every
   * step). The `run` guard treats a task in ANY of them as already in-flight. */
  const pipelineSections = () => {
    /** @type {Set<string>} */
    const s = new Set();
    for (const st of pipeline || []) for (const g of [st.sourceSectionGid, st.successSectionGid, st.failureSectionGid, st.holdSectionGid]) if (g) s.add(g);
    return s;
  };

  // Current section of a task → the step it now rests in (or undefined). We read the
  // task's live membership rather than trusting the move event's payload, so rapid
  // back-to-back moves resolve to the task's actual current state.
  /** @param {string} taskGid */
  async function stepForTask(taskGid) {
    const res = await api(`/tasks/${taskGid}?opt_fields=memberships.section.gid,assignee.gid`);
    if (!res.ok) throw new Error(`task section fetch ${res.status}`);
    const t = (await json(res)).data;
    if (!isOurs(t.assignee?.gid)) {
      console.log(`[assignee] skip ${taskGid} — not assigned to us`);
      return undefined;
    }
    for (const mem of t.memberships || []) {
      const step = stepBySource(mem.section?.gid);
      if (step) return step;
    }
    return undefined;
  }

  // --- native Asana task dependencies (the block gate; mirrors github.js) ---
  // Dependencies are LIVE data, queried per event with no caching, so a reopened blocker
  // or a fresh second blocker is always reflected. This is a WORKFLOW gate, not a security
  // boundary: on an API error we FAIL OPEN (treat as unblocked + warn) so a flaky
  // dependencies API can't freeze the pipeline — the opposite of the assignee scope.
  /** Gids of the tasks that BLOCK `gid` and are not yet completed. @param {string} gid @returns {Promise<string[]>} */
  async function openDependencies(gid) {
    const res = await api(`/tasks/${gid}/dependencies?opt_fields=completed`);
    if (!res.ok) {
      console.warn(`[blocked] could not read dependencies for ${gid} (${res.status}) — treating as unblocked`);
      return [];
    }
    return ((await json(res)).data || []).filter((/** @type {any} */ t) => t?.completed !== true).map((/** @type {any} */ t) => t.gid);
  }
  /** Tasks that `gid` BLOCKS (its dependents), with the fields the release checks read
   * (completed, assignee, section) so no per-dependent re-fetch. @param {string} gid @returns {Promise<any[]>} */
  async function dependents(gid) {
    const res = await api(`/tasks/${gid}/dependents?opt_fields=completed,assignee.gid,memberships.section.gid`);
    if (!res.ok) {
      console.warn(`[blocked] could not read dependents for ${gid} (${res.status})`);
      return [];
    }
    return (await json(res)).data || [];
  }
  /** The block gate: true (and logs) when `gid` has an incomplete dependency, so the
   * caller rests it in its source section (emits no job). @param {string} gid @returns {Promise<boolean>} */
  async function restIfBlocked(gid) {
    const blockers = await openDependencies(gid);
    if (!blockers.length) return false;
    console.log(`[blocked] ${gid} blocked by ${blockers.join(", ")} — resting`);
    return true;
  }

  // Fail-closed owner check used to gate task MUTATION (advance/moveToSection).
  // Any uncertainty — fetch error, non-2xx, missing/!matching assignee — returns
  // false, so we never move a task we can't positively confirm is ours.
  /** @param {string} ref @returns {Promise<boolean>} */
  async function ownedByUs(ref) {
    try {
      const res = await api(`/tasks/${ref}?opt_fields=assignee.gid`);
      if (!res.ok) return false;
      return isOurs((await json(res)).data?.assignee?.gid);
    } catch {
      return false;
    }
  }

  /** The `@agent` comment trigger for a comment_added story. Emits a resume job only
   * when ALL hold (anything uncertain → no job): the text starts with cfg.trigger, the
   * author is pc.userGid (strict — assigneeFilter:false does NOT open this up; an unset
   * userGid rejects), the task passes the assignee gate, and it is held on a runnable
   * step still under its attempt cap (resumeJob). Dedup: `trigger:<storyGid>`.
   * @param {any} story @param {string} storyGid @param {string|undefined} taskGid
   * @returns {Promise<import('../types.js').Job|null>} */
  async function resumeFromComment(story, storyGid, taskGid) {
    if (!taskGid || !startsWithTrigger(cfg.trigger, story.text)) return null;
    const author = story.created_by?.gid;
    if (!pc.userGid || !author || author !== pc.userGid) {
      console.log(`[trigger] ${taskGid}: comment ${storyGid} not by our user — ignoring`);
      return null;
    }
    if (!(await ownedByUs(taskGid))) {
      console.log(`[trigger] ${taskGid}: not assigned to us — ignoring`);
      return null;
    }
    return resumeJob(cfg, store, taskGid, storyGid, story.text);
  }

  return {
    describe: () => ({
      platform: "Asana",
      taskNoun: "task",
      trigger: cfg.trigger,
      commentHowTo: `post via the Asana API (token in env ASANA_TOKEN) using POST /tasks/<gid>/stories`,
      readCommentsHowTo: `GET /tasks/<gid>/stories via the Asana API (token in env ASANA_TOKEN); comments are stories with type "comment"`,
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
            if (step && !(await restIfBlocked(gid))) jobs.push({ kind: "pipeline", ref: gid, stepId: step.id, dedupKey: `step:${step.id}:${gid}` });
          } catch (e) {
            console.error(`[pipeline] route task ${gid} failed:`, e.message);
          }
        } else if (rt === "story" && ev.action === "added") {
          // Section move → fire the step the task now rests in. One story gid = one
          // move, so the key dedups webhook retries yet allows a later re-entry. A
          // comment story (the `@agent` resume) keys on the same gid as `trigger:`.
          const storyGid = ev.resource.gid;
          if (!storyGid || store.hasSeen(`secmove:${storyGid}`) || store.hasSeen(`trigger:${storyGid}`)) continue;
          let story;
          try {
            story = await fetchStory(storyGid);
          } catch (e) {
            console.error(`[story] fetch ${storyGid} failed:`, e.message);
            continue;
          }
          const taskGid = ev.parent?.gid || story.target?.gid;
          if (story.resource_subtype === "comment_added") {
            const job = await resumeFromComment(story, storyGid, taskGid);
            if (job) jobs.push(job);
            continue;
          }
          if (story.resource_subtype !== "section_changed") continue;
          try {
            const step = await stepForTask(taskGid);
            if (step && !(await restIfBlocked(taskGid))) jobs.push({ kind: "pipeline", ref: taskGid, stepId: step.id, dedupKey: `secmove:${storyGid}` });
          } catch (e) {
            console.error(`[pipeline] route move ${taskGid} failed:`, e.message);
          }
        } else if (rt === "task" && ev.action === "changed") {
          // Completion-release: when a task completes, fire any of OUR dependents it was
          // blocking that are now fully unblocked and resting in a step's source section.
          // The completed task itself needn't be ours — a human completing a blocker should
          // still release the bot's dependents. We re-read `completed` live (an un-complete
          // also delivers `changed`), so only a task that IS completed releases anything.
          const gid = ev.resource.gid;
          if (!gid || (ev.change?.field && ev.change.field !== "completed")) continue;
          try {
            const res = await api(`/tasks/${gid}?opt_fields=completed`);
            if (!res.ok) throw new Error(`task fetch ${res.status}`);
            if ((await json(res)).data?.completed !== true) continue;
            for (const dep of await dependents(gid)) {
              if (!dep?.gid || dep.completed) continue; // a dependent already completed: never fire an agent on it
              if (!isOurs(dep.assignee?.gid)) continue; // a dependent that isn't ours: untouched
              const step = (dep.memberships || []).map((/** @type {any} */ m) => stepBySource(m.section?.gid)).find(Boolean);
              if (!step || step.manual) continue; // not resting in a source section, or a manual one (no agent runs)
              if ((await openDependencies(dep.gid)).length) continue; // still blocked by another incomplete task
              console.log(`[unblock] ${gid} completed → firing ${dep.gid} (${step.id})`);
              jobs.push({ kind: "pipeline", ref: dep.gid, stepId: step.id, dedupKey: `unblock:${gid}:${dep.gid}` });
            }
          } catch (e) {
            console.error(`[unblock] release dependents of ${gid} failed:`, e.message);
          }
        }
      }
      return jobs;
    },

    async fetchTask(ref) {
      const res = await api(
        `/tasks/${ref}?opt_fields=name,notes,permalink_url,assignee.gid,completed,custom_fields.name,custom_fields.display_value,custom_fields.enum_value.name,custom_fields.multi_enum_values.name,custom_fields.text_value`,
      );
      if (!res.ok) throw new Error(`task fetch ${res.status}`);
      const t = (await json(res)).data;
      // Human id (e.g. "ID-2738") lives in a custom field; name configurable, default "ID".
      const idField = String(pc.displayIdField ?? "ID").toLowerCase();
      const idCf = (t.custom_fields || []).find((/** @type {any} */ f) => String(f?.name ?? "").toLowerCase() === idField);
      if (pc.routeField && !findCustomField(t.custom_fields, pc.routeField)) {
        console.log(`[route] ${ref}: no custom field "${pc.routeField}" — unrouted`);
      }
      return {
        ref,
        name: t.name,
        description: t.notes,
        url: t.permalink_url,
        completed: t.completed === true,
        assignedToUs: t.assignee?.gid === pc.userGid,
        displayId: idCf?.display_value ? String(idCf.display_value) : undefined,
        routeKeys: extractRouteKeys(t.custom_fields, pc.routeField),
      };
    },

    // Resolve a finished step's transition by moving the task to the section its verdict
    // maps to. Each move is itself the trigger for whatever step that section sources:
    //   advance → successSectionGid (the next step's source — drives forward)
    //   fail    → failureSectionGid (a human picks it up)
    //   hold    → holdSectionGid    (parked out of the queue; the owner's `@agent` reply
    //                                  resumes it, or a human drags it back)
    //   changes → the target step's sourceSectionGid (re-fires it — the rework loop;
    //             dispatch already resolved verdict.target to a concrete stepId)
    // A missing target section is a no-op: the task stays put, logged.
    async advance(ref, stepId, verdict) {
      const step = stepById(stepId);
      if (!step) return;
      // Mutation chokepoint: never move a task that isn't ours (covers the blind
      // recoverInterrupted path + defense-in-depth for dispatch). Fail-closed.
      if (scopeToUser && !(await ownedByUs(ref))) {
        console.log(`[assignee] refuse to move ${ref} (${stepId}:${verdict.outcome}) — not assigned to us`);
        return;
      }
      const { outcome, target } = verdict;
      let gid;
      if (outcome === "advance") gid = step.successSectionGid;
      else if (outcome === "fail") gid = step.failureSectionGid;
      else if (outcome === "hold") gid = step.holdSectionGid;
      else if (outcome === "changes" && target) gid = stepById(target)?.sourceSectionGid;
      if (!gid) {
        console.log(`[advance] ${stepId} ${outcome}: no target section — leaving ${ref} in place`);
        return;
      }
      await moveToSection(ref, gid, `${stepId}:${outcome}${outcome === "changes" ? `->${target}` : ""}`);
      // Entering a step flagged completeTask (e.g. the manual `done` step) marks the task
      // COMPLETED, so a blocker that finishes its own pipeline auto-releases its dependents
      // (the completion-release path in processEvents) without a human. Explicit, never implicit.
      const entered = stepBySource(gid);
      if (entered?.completeTask) {
        const res = await api(`/tasks/${ref}`, { method: "PUT", body: JSON.stringify({ data: { completed: true } }) });
        if (!res.ok) throw new Error(`complete task ${res.status}`);
        console.log(`[completed] ${ref} (step ${entered.id})`);
      }
    },

    // Inject work into a step (`agenthook run`): assign the task to us (unless
    // opts.assign===false) and addTask it INTO the step's SOURCE section. That move is
    // itself the section_changed webhook event that fires the step — no special dispatch.
    /** @param {string} ref @param {string} stepId @param {{assign?: boolean}} [opts] */
    async enterStage(ref, stepId, opts = {}) {
      const step = stepById(stepId);
      if (!step) throw new Error(`unknown step "${stepId}"`);
      if (!step.sourceSectionGid) throw new Error(`step "${stepId}" has no sourceSectionGid to enter`);
      if (opts.assign !== false) await assignToUs(ref);
      await moveToSection(ref, step.sourceSectionGid, `${stepId}:enter`);
      return { stage: step.sourceSectionGid };
    },

    // Mark the task completed (a forge saw its agent PR merge). Same fail-closed
    // mutation gate as advance: never complete a task that isn't ours.
    /** @param {string} ref */
    async complete(ref) {
      if (scopeToUser && !(await ownedByUs(ref))) {
        console.log(`[assignee] refuse to complete ${ref} — not assigned to us`);
        return;
      }
      const res = await api(`/tasks/${ref}`, { method: "PUT", body: JSON.stringify({ data: { completed: true } }) });
      if (!res.ok) throw new Error(`complete ${res.status}`);
      console.log(`[complete] ${ref} marked completed`);
    },

    // The pipeline section a task currently rests in (any source/success/failure/hold
    // section of any step), or null — backs `run`'s guard against re-injecting a task
    // already mid-flow. Read-only; no assignee gate (a section is occupied regardless).
    async currentStage(ref) {
      if (!pipeline) return null;
      const res = await api(`/tasks/${ref}?opt_fields=memberships.section.gid`);
      if (!res.ok) throw new Error(`task section fetch ${res.status}`);
      const gids = pipelineSections();
      for (const mem of (await json(res)).data.memberships || []) {
        if (mem.section?.gid && gids.has(mem.section.gid)) return mem.section.gid;
      }
      return null;
    },

    // Reconcile source (explicit `reconcile` command ONLY — never boot): every unblocked
    // task resting in a step's source section, as a pipeline job for that step. This is
    // the one deliberate board poll, user-triggered, to recover from a missed webhook
    // (incl. a cross-project blocker whose completion never reached our project hook).
    async listResting() {
      if (!pipeline) return [];
      /** @type {import('../types.js').Job[]} */
      const jobs = [];
      const seenGids = new Set();
      for (const step of pipeline) {
        if (!step.sourceSectionGid || step.manual) continue;
        const res = await api(`/sections/${step.sourceSectionGid}/tasks?opt_fields=completed,assignee.gid&limit=100`);
        if (!res.ok) throw new Error(`section ${step.sourceSectionGid} tasks ${res.status}`);
        for (const t of (await json(res)).data || []) {
          if (t.completed || seenGids.has(t.gid)) continue;
          if (!isOurs(t.assignee?.gid)) continue;
          if ((await openDependencies(t.gid)).length) continue; // blocked → reconcile must not re-inject it
          seenGids.add(t.gid);
          jobs.push({ kind: "pipeline", ref: t.gid, stepId: step.id, dedupKey: `reconcile:${step.id}:${t.gid}` });
        }
      }
      return jobs;
    },

    // Queue-stage source (the one narrow boot/run_end board read — see engine pullQueued):
    // tasks resting in the step's opt-in queueSectionGid, in the API's section order (the
    // board's top-to-bottom priority), filtered like listResting. [] without the key.
    /** @param {string} stepId */
    async listQueued(stepId) {
      const step = stepById(stepId);
      if (!step?.queueSectionGid || step.manual) return [];
      const res = await api(`/sections/${step.queueSectionGid}/tasks?opt_fields=completed,assignee.gid&limit=100`);
      if (!res.ok) throw new Error(`section ${step.queueSectionGid} tasks ${res.status}`);
      /** @type {string[]} */
      const refs = [];
      for (const t of (await json(res)).data || []) {
        if (t.completed || !isOurs(t.assignee?.gid)) continue;
        refs.push(t.gid);
      }
      return refs;
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
      // section_changed (moved between sections) — both route to a step — plus task
      // `completed` changes, which release the dependents a finished blocker was holding.
      // (The section_changed delivery on a project webhook is verified against Asana.)
      // section_changed (moved between sections) — both route to a step — plus story
      // comment_added (the `@agent` resume of a held step). (The section_changed
      // delivery on a project webhook is verified against Asana.)
      const res = await api(`/webhooks`, {
        method: "POST",
        body: JSON.stringify({
          data: {
            resource: pc.projectGid,
            target,
            filters: [
              { resource_type: "task", action: "added" },
              { resource_type: "story", action: "added", resource_subtype: "section_changed" },
              { resource_type: "task", action: "changed", fields: ["completed"] },
              { resource_type: "story", action: "added", resource_subtype: "comment_added" },
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
    //
    // dedupKey MUST equal the key processEvents will assign to this forged `task added`
    // event — `step:<id>:<ref>`, derived from the task's live section — so that
    // `catchup --force` clears the key the server actually checks (not a phantom
    // `task:<ref>:added` that the server never writes). reconcile passes the stepId it
    // already resolved (no extra fetch); catchup omits it, so we resolve via stepForTask
    // (which also applies the assignee gate — a foreign/sectionless ref yields the inert
    // `task:<ref>:added` fallback, matching the no-op the server would produce anyway).
    /** @param {string} ref @param {string} [stepId] */
    async forgeCatchup(ref, stepId) {
      const secret = store.getSecret("/mytasks");
      if (!secret) throw new Error("no /mytasks secret yet — run register first");
      const body = JSON.stringify({ events: [{ action: "added", resource: { gid: ref, resource_type: "task" } }] });
      const sig = crypto.createHmac("sha256", secret).update(body).digest("hex");
      const step = stepId ?? (await stepForTask(ref))?.id;
      const dedupKey = step ? `step:${step}:${ref}` : `task:${ref}:added`;
      return { path: "/mytasks/", body, headers: { "X-Hook-Signature": sig }, dedupKey, stepId: step };
    },

    // `agenthook init` discovery: pick workspace → project, read the token's user gid,
    // then bind the code step to real sections of the chosen project (no TODO_* editing).
    wizardSteps: () => {
      // The chosen project's sections — live, so the stage picks below are real gids.
      /** @param {Record<string,any>} a @returns {Promise<Array<{title:string,value:any}>>} */
      const sections = async (a) => {
        const res = await api(`/projects/${a.projectGid}/sections?opt_fields=name&limit=100`);
        if (!res.ok) throw new Error(`Asana sections ${res.status}`);
        return ((await json(res)).data || []).map((/** @type {any} */ s) => ({ title: `${s.name} (${s.gid})`, value: s.gid }));
      };
      return [
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
        { key: "_sourceStage", message: "Section that FIRES the code step (a task added here triggers the agent)", type: "select", choices: sections },
        { key: "_successStage", message: "Section to move to on SUCCESS (hand off to review)", type: "select", choices: sections },
        { key: "_failureStage", message: "Section to move to on FAILURE (blocked — a human picks it up)", type: "select", choices: sections },
      ];
    },

    // Map the wizard's live stage picks to this tracker's step bindings. Null when the
    // user never reached the section picks, so init falls back to the TODO_* skeleton.
    /** @param {Record<string,any>} a */
    pipelineBindings: (a) =>
      a._sourceStage ? { sourceSectionGid: a._sourceStage, successSectionGid: a._successStage, failureSectionGid: a._failureStage } : null,
  };
}
