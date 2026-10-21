// Operator commands served over the control socket (src/control.js) — the live half of the
// agent-facing surface (`agenthook mcp`, docs/mcp.md). Reads that need the tracker/forge
// (`board`, `prs`, `epics`) and writes that need the engine (`pause`, `cancel`, `run`, …) live here;
// everything readable from the state dir is read by the MCP process directly, receiver up or not.
//
// Every write is audited to <stateDir>/control-audit.jsonl (0600) with the caller's `actor`;
// free text (a `release` comment, a `ticket_add` body) is logged as its length only.
// Writes never bypass a gate: `run` is the `agenthook run` move (the webhook then fires the
// step), `release` reuses the `@agent` resume gate (held + under the attempt cap), and the
// dispatcher's own fail-closed assignee check still decides whether any agent spawns.
import fs from "node:fs";
import path from "node:path";
import { isPipeline, findStep, resumeJob, queueStageOf } from "./pipeline.js";
import { entryBlock } from "./commands/run.js";
import { runMergeCatchup, runReconcile } from "./commands/reconcile.js";
import { isStateDedupKey } from "./store.js";
import { CANCELLED_REASON } from "./events.js";
import { EPIC_REF_RE, epicDetail, epicStats } from "./epics.js";
import { repositoryOf } from "./heartbeat.js";
import { buildRows, readProfileState } from "./ui/rows.js";
import { readHistory } from "./ui/stats.js";

const BOARD_TTL_MS = 30 * 1000;
const OWNERSHIP_TTL_MS = 5 * 60 * 1000;
/** Known-PR state lookups per `prs` cache fill (each is one forge GET). */
const MAX_PR_STATE_LOOKUPS = 20;
const COMMENT_MAX = 8000;
/** A `ticket_add` body's cap in JSON-encoded UTF-8 bytes: the whole request must fit control.sock's 64 KB line. */
export const TICKET_BODY_MAX = 48 * 1024;
const MAX_ERROR_CHARS = 500;
const RELEASE_SETTLE_MS = 15_000;

/**
 * Append one line to `<stateDir>/control-audit.jsonl` (0600). Best-effort: a failed write warns.
 * Shared with the engine's quota pacer, whose automatic pauses are audited like operator writes.
 * @param {string} stateDir @param {Record<string, any>} line
 */
export function appendControlAudit(stateDir, line) {
  try {
    fs.appendFileSync(path.join(stateDir, "control-audit.jsonl"), JSON.stringify(line) + "\n", { mode: 0o600 });
  } catch (e) {
    console.warn(`[ops] audit write failed: ${e.message}`);
  }
}

/** @param {any} v @param {string} what */
function needString(v, what) {
  if (typeof v !== "string" || !v.trim()) throw new Error(`${what} is required`);
  return v.trim();
}

/**
 * TTL cache: concurrent calls share one in-flight fetch, failures are never cached.
 * @template T
 * @param {() => Promise<T>} fn @param {number} ttlMs @param {() => number} now
 * @returns {(() => Promise<T>) & {reset(): void}}
 */
export function ttlCache(fn, ttlMs, now = Date.now) {
  /** @type {{value: T, at: number}|null} */
  let hit = null;
  /** @type {Promise<T>|null} */
  let pending = null;
  let gen = 0; // bumped by reset(): a fetch started before it must not be cached or shared
  const get = () => {
    if (hit && now() - hit.at < ttlMs) return Promise.resolve(hit.value);
    if (pending) return pending;
    const mine = gen;
    const p = fn().then(
      (value) => {
        if (mine === gen) {
          hit = { value, at: now() };
          pending = null;
        }
        return value;
      },
      (e) => {
        if (mine === gen) pending = null;
        throw e;
      },
    );
    pending = p;
    return p;
  };
  return Object.assign(get, {
    reset: () => {
      gen++;
      hit = null;
      pending = null;
    },
  });
}

/**
 * @param {{
 *   cfg: import('./types.js').Config,
 *   store: import('./types.js').Store,
 *   adapter: import('./types.js').Adapter,
 *   forge: import('./types.js').Forge|null,
 *   queue: ReturnType<typeof import('./queue.js').createQueue>,
 *   cancelRun: (ref: string) => boolean,
 *   intake: (jobs: import('./types.js').Job[], opts?: {force?: boolean}) => number,
 *   emit: (event: string, ref: string, step: string, extra?: Record<string, any>) => void,
 *   heartbeat: {update(p: Record<string, any>): void},
 *   pull: () => Promise<void>,
 *   leavePipeline?: (ref: string) => void,
 *   isLocked: () => boolean,
 *   now?: () => number,
 *   digester?: { request(): Promise<any> },
 *   onEpicChanged?: (reset: () => void) => void,
 *   pacer?: { operatorPause(): void, operatorResume(): string|null },
 * }} deps  isLocked: a restart/decommission/shutdown owns the queue pause — `resume` must not undo it.
 *   pacer: the quota pacer (src/quota.js) — told about operator pauses so its reset never undoes one,
 *   and an operator `resume` overrides a quota pause until that window resets.
 *   onEpicChanged: handed the epics-cache reset so the engine can drop it on an `epic_changed`
 *   signal — a callback, not a property of the returned map (every own property is a control op)
 * @returns {Record<string, (args: any) => Promise<any>>}
 */
export function createOps(deps) {
  const { cfg, store, adapter, forge, queue, cancelRun, intake, emit, heartbeat, pull, isLocked, leavePipeline, pacer } = deps;
  const digester = deps.digester;
  const now = deps.now ?? Date.now;

  /** @param {string} cmd @param {any} args @param {{ok: boolean, error?: string}} outcome */
  function audit(cmd, args, outcome) {
    const { comment, body, actor, ...rest } = args && typeof args === "object" ? args : /** @type {any} */ ({});
    const line = {
      ts: new Date().toISOString(),
      cmd,
      actor: typeof actor === "string" ? actor.slice(0, 40) : "unknown",
      args: {
        ...rest,
        ...(typeof comment === "string" ? { commentChars: comment.length } : {}),
        ...(typeof body === "string" ? { bodyChars: body.length } : {}),
      },
      ...outcome,
    };
    appendControlAudit(cfg.stateDir, line);
  }

  /** Wrap a write: audit success and failure alike. Writes that move tickets drop the cached
   * board/PR reads, so the next `tick` never shows the pre-write board. @param {string} cmd @param {(args: any) => Promise<any>} fn */
  const write = (cmd, fn) => async (/** @type {any} */ args) => {
    try {
      const result = await fn(args ?? {});
      board.reset();
      prs.reset();
      epics.reset();
      audit(cmd, args, { ok: true });
      return result;
    } catch (e) {
      audit(cmd, args, { ok: false, error: e.message });
      throw e;
    }
  };

  /** @param {string} id */
  const stepOrThrow = (id) => {
    const s = findStep(cfg, id);
    if (!s) throw new Error(`no step "${id}" in the pipeline`);
    return s;
  };

  const board = ttlCache(
    async () => {
      if (!isPipeline(cfg)) throw new Error("board is for pipeline configs");
      const resting = typeof adapter.listResting === "function" ? await adapter.listResting() : [];
      const meta = store.listRefMeta();
      const running = store.listRunning();
      /** @param {string} ref */
      const card = (ref) => ({ ref, ...(meta[ref]?.displayId ? { id: meta[ref].displayId } : {}), ...(meta[ref]?.title ? { title: meta[ref].title } : {}), ...(ref in running ? { running: true } : {}) });
      const steps = await Promise.all(
        (cfg.pipeline ?? [])
          .filter((step) => !step.manual)
          .map(async (step) => {
            const refs = resting.filter((j) => j.stepId === step.id).map((j) => j.ref);
            const queued = queueStageOf(step) && typeof adapter.listQueued === "function" ? await adapter.listQueued(step.id) : [];
            return { step: step.id, resting: refs.map(card), ...(queued.length ? { backlog: queued.map(card) } : {}) };
          }),
      );
      return { at: new Date(now()).toISOString(), steps };
    },
    BOARD_TTL_MS,
    now,
  );

  // Per-ref ownership cache backing `prs`' `mine` flag: only "ours"/"not_ours" are
  // cached (never "check_failed" or a thrown error), 5 min TTL. Cleared on `fresh:true`
  // alongside the PR list cache so a reassignment is picked up without waiting it out.
  /** @type {Map<string, {v: "ours"|"not_ours", at: number}>} */
  const ownershipCache = new Map();
  /** @param {string} ref @param {(ref: string) => Promise<"ours"|"not_ours"|"check_failed">} ownership @returns {Promise<"ours"|"not_ours"|"check_failed"|undefined>} */
  async function ownershipOf(ref, ownership) {
    const hit = ownershipCache.get(ref);
    if (hit && now() - hit.at < OWNERSHIP_TTL_MS) return hit.v;
    let v;
    try {
      v = await ownership(ref);
    } catch (e) {
      console.warn(`[ops] ownership(${ref}) failed: ${e.message}`);
      return undefined;
    }
    if (v === "ours" || v === "not_ours") ownershipCache.set(ref, { v, at: now() });
    return v === "check_failed" ? undefined : v;
  }

  /**
   * Known PRs (refmeta.pr) missing from the open list may have been merged/closed without the
   * forge hook firing: look a bounded few up and record a terminal state, so the UI stops
   * counting them as awaiting merge. Only runs inside the `prs` loader (an explicit call) — no
   * timer. A failed lookup writes nothing and never fails `prs`. A terminal state whose PR is
   * open again (reopened) is dropped, no lookup needed.
   * @param {Set<number>} open  PR numbers listAgentPrs just reported open
   */
  async function learnPrStates(open) {
    const prState = forge?.prState;
    if (typeof prState !== "function") return;
    const metas = Object.entries(store.listRefMeta());
    for (const [ref, m] of metas) if (m?.prState && open.has(/** @type {number} */ (m.pr))) store.setRefMeta(ref, { prState: null });
    const todo = metas
      .filter(([, m]) => Number.isInteger(m?.pr) && (m.pr ?? 0) > 0 && m.prState !== "merged" && m.prState !== "closed" && !open.has(/** @type {number} */ (m.pr)))
      .slice(0, MAX_PR_STATE_LOOKUPS);
    await Promise.all(
      todo.map(async ([ref, m]) => {
        try {
          const s = await prState(/** @type {number} */ (m.pr));
          if (s === "merged" || s === "closed") store.setRefMeta(ref, { prState: s });
        } catch (e) {
          console.warn(`[ops] prState(#${m.pr}) for ${ref} failed: ${e.message}`);
        }
      }),
    );
  }

  const prs = ttlCache(
    async () => {
      if (!forge?.listAgentPrs) throw new Error("no forge with PR support configured (add a `forge` block)");
      const rows = await forge.listAgentPrs();
      await learnPrStates(new Set(rows.map((r) => r.number)));
      const ownership = adapter.ownership;
      const withMine =
        cfg.tracker?.assigneeFilter !== false && typeof ownership === "function"
          ? await Promise.all(
              rows.map(async (r) => {
                const o = await ownershipOf(r.ref, ownership);
                return o === "ours" ? { ...r, mine: true } : o === "not_ours" ? { ...r, mine: false } : r;
              }),
            )
          : rows;
      return { at: new Date(now()).toISOString(), prs: withMine };
    },
    BOARD_TTL_MS,
    now,
  );

  // Every epic and its tickets, one fan-out per fill (listEpicTickets for each epic). Only the
  // `epics` op calls it — no timer. The local join (rows/events) runs outside, on every call.
  const epics = ttlCache(
    async () => {
      const list = await /** @type {NonNullable<typeof adapter.listEpics>} */ (adapter.listEpics)();
      const listTickets = /** @type {NonNullable<typeof adapter.listEpicTickets>} */ (adapter.listEpicTickets);
      const entries = await Promise.all(list.map(async (epic) => ({ epic, tickets: await listTickets(epic.ref) })));
      return { at: new Date(now()).toISOString(), epics: entries };
    },
    BOARD_TTL_MS,
    now,
  );
  deps.onEpicChanged?.(() => epics.reset());

  /**
   * `review` = the newest stored summary among the pipeline's review-kind steps for the PR's
   * ref; `outcome`/`at` are spread last so the agent's keys can't override them. No summary →
   * the row is returned unchanged. @param {import('./types.js').AgentPr} r
   */
  function withReview(r) {
    const all = store.getSummaries(r.ref);
    if (!all) return r;
    let best = null;
    for (const s of cfg.pipeline ?? []) {
      if (s.kind !== "review") continue;
      const rec = all[s.id];
      if (rec && typeof rec.at === "string" && (!best || rec.at > best.at)) best = rec;
    }
    return best ? { ...r, review: { ...best.summary, outcome: best.outcome, at: best.at } } : r;
  }

  /** @type {Record<string, (args: any) => Promise<any>>} */
  const commands = {
    // ---- reads that need the tracker / forge (cached ~30s; `fresh:true` bypasses) ----
    async board(/** @type {any} */ args) {
      if (args?.fresh) board.reset();
      return board();
    },
    async prs(/** @type {any} */ args) {
      if (args?.fresh) {
        prs.reset();
        ownershipCache.clear();
      }
      const cached = await prs();
      // Review summaries are a local read, attached outside the cache so they're always fresh.
      const out = { ...cached, prs: cached.prs.map(withReview) };
      if (typeof args?.mine !== "boolean") return out;
      return { ...out, prs: out.prs.filter((r) => r.mine === args.mine) };
    },
    async epics(/** @type {any} */ args) {
      const ref = args?.ref;
      if (ref !== undefined && (typeof ref !== "string" || !EPIC_REF_RE.test(ref))) throw new Error("invalid epic ref");
      const tz = args?.tz ?? 0;
      if (typeof tz !== "number" || !Number.isFinite(tz) || Math.abs(tz) > 14 * 60) throw new Error("invalid tz");
      if (typeof adapter.listEpics !== "function" || typeof adapter.listEpicTickets !== "function") {
        const at = new Date(now()).toISOString();
        return ref !== undefined ? { at, live: true, supported: false, epic: null } : { at, live: true, supported: false, epics: [] };
      }
      if (args?.fresh) epics.reset();
      const cached = await epics();
      // The local join is fresh on every call, like `prs`' review summaries.
      const join = {
        rows: buildRows(cfg.name, readProfileState(cfg.stateDir), { repository: repositoryOf(cfg) }),
        events: readHistory(path.join(cfg.stateDir, "events.jsonl")).events,
        forge: !!forge,
        now: now(),
        tzOffset: tz,
        live: true,
      };
      if (ref === undefined) return { at: cached.at, live: true, supported: true, epics: cached.epics.map((e) => epicStats(e.epic, e.tickets, join)) };
      const hit = cached.epics.find((e) => e.epic.ref === ref);
      if (!hit) throw new Error(`no epic ${ref}`);
      return { at: cached.at, live: true, supported: true, epic: epicDetail(hit.epic, hit.tickets, join) };
    },

    // ---- writes ----
    pause: write("pause", async () => {
      pacer?.operatorPause();
      queue.pause();
      heartbeat.update({ paused: true });
      return { paused: true, ...queue.state() };
    }),
    resume: write("resume", async () => {
      if (isLocked()) return { paused: queue.isPaused(), note: "a restart/decommission/shutdown holds the queue; not resumed", ...queue.state() };
      const overrideUntil = pacer?.operatorResume() ?? null;
      queue.resume();
      heartbeat.update({ paused: false });
      await pull().catch((e) => console.warn(`[ops] pull after resume failed: ${e.message}`)); // pulls were skipped while paused
      return { paused: false, ...(overrideUntil ? { note: `quota pause overridden until ${overrideUntil}` } : {}), ...queue.state() };
    }),
    set_concurrency: write("set_concurrency", async (args) => {
      const n = args.max;
      if (!Number.isInteger(n) || n < 1 || n > 64) throw new Error("max must be an integer 1..64");
      queue.setMax(n);
      heartbeat.update({ maxConcurrent: n });
      return { maxConcurrent: n, note: "runtime only; the config file is unchanged", ...queue.state() };
    }),
    cancel: write("cancel", async (args) => {
      const ref = needString(args.ref, "ref");
      const dropped = queue.remove(ref);
      const killed = cancelRun(ref);
      const held = store.getHeld(ref);
      if (!killed && !dropped.length && !held) throw new Error(`${ref} is not running, queued or held here`);
      store.reloadSeen();
      for (const j of dropped) if (isStateDedupKey(j.dedupKey)) store.unmarkSeen(j.dedupKey); // else a later re-entry of the same stage would be deduped away
      const stepId = dropped[0]?.stepId ?? held?.stepId;
      for (const j of dropped) emit("dequeued", ref, j.stepId, { by: "operator" });
      // A killed agent resolves through dispatch (fail verdict -> failure lane, state cleared). A
      // waiting job or a held record never reaches dispatch, so finish the abandon here: move the
      // ticket out of its source/hold stage (else `reconcile` or a restart would re-fire it) and
      // drop the per-ref state a terminal fail would drop.
      /** @type {{moved?: boolean, moveError?: string}} */
      let outcome = {};
      if (!killed && stepId && (held || dropped.some((j) => (j.kind ?? "pipeline") === "pipeline"))) {
        try {
          await adapter.advance(ref, stepId, { outcome: "fail", reason: CANCELLED_REASON });
          outcome = { moved: true };
        } catch (e) {
          outcome = { moved: false, moveError: String(e.message).slice(0, 200) };
        }
        store.clearAttempts(ref);
        store.clearDifficulty(ref);
        store.clearRepo(ref);
        store.clearHeld(ref);
        store.clearFindings(ref);
        store.clearSummaries(ref);
        leavePipeline?.(ref);
        emit("failed", ref, stepId, { reason: CANCELLED_REASON });
      }
      return { ref, killed, dequeued: dropped.map((j) => j.stepId), ...(held && !killed ? { releasedHold: true } : {}), ...outcome };
    }),
    dismiss: write("dismiss", async (args) => {
      const ref = needString(args.ref, "ref");
      if (ref in store.listRunning()) throw new Error(`${ref} is running — nothing to dismiss`);
      if (store.listQueued().some((j) => j.ref === ref)) throw new Error(`${ref} is queued — nothing to dismiss`);
      if (store.getHeld(ref)) throw new Error(`${ref} is held — answer it with release, or abandon it with cancel`);
      emit("dismissed", ref, "", { by: "operator" });
      return { ref, dismissed: true };
    }),
    run: write("run", async (args) => {
      const ref = needString(args.ref, "ref");
      if (!isPipeline(cfg)) throw new Error("run is for pipeline configs");
      if (typeof adapter.enterStage !== "function") throw new Error(`tracker "${cfg.provider}" has no run support`);
      const step = args.step ? stepOrThrow(String(args.step)) : cfg.pipeline?.[0];
      if (!step) throw new Error("pipeline is empty");
      const force = args.force === true;
      // Like the CLI: confirm the item exists first (a clear error beats a tracker 404 from
      // enterStage), and don't re-enter a completed one unless forced.
      /** @type {import('./types.js').Task} */
      let task;
      try {
        task = await adapter.fetchTask(ref);
      } catch (e) {
        throw new Error(`${ref} not found (${String(e.message).slice(0, 120)}). Check the ref.`);
      }
      if (task.completed && !force) throw new Error(`${ref} ("${task.name}") is already completed — pass force to enter it anyway`);
      let stage = null;
      if (!force && typeof adapter.currentStage === "function") stage = await adapter.currentStage(ref);
      const blocked = entryBlock(ref, { stage, running: store.listRunning()[ref] ?? null, force });
      if (blocked) throw new Error(blocked);
      await adapter.ensureLabels?.();
      const entered = await adapter.enterStage(ref, step.id, { assign: args.assign !== false });
      return { ref, step: step.id, stage: entered.stage, note: "the tracker webhook fires the step; `reconcile` if it does not. Already resting there? use `catchup` instead" };
    }),
    // `agenthook ticket add` with the receiver up: the board write and its push must happen in
    // this process (the adapter's in-process sink lives here). Local tracker only (createTask).
    ticket_add: write("ticket_add", async (args) => {
      const title = needString(args.title, "title");
      if (typeof adapter.createTask !== "function") throw new Error(`tracker "${cfg.provider}" has no ticket add — add the item on its board, then \`run\` it`);
      const body = typeof args.body === "string" ? args.body.slice(0, TICKET_BODY_MAX) : "";
      const created = await adapter.createTask({ name: title, description: body, ...(args.step ? { stepId: String(args.step) } : {}) });
      return { ref: created.ref, step: created.stepId, stage: created.stage };
    }),
    catchup: write("catchup", async (args) => {
      const ref = needString(args.ref, "ref");
      if (!isPipeline(cfg)) throw new Error("catchup is for pipeline configs");
      if (typeof adapter.forgeCatchup !== "function") throw new Error(`tracker "${cfg.provider}" has no catchup support`);
      let task;
      try {
        task = await adapter.fetchTask(ref);
      } catch (e) {
        throw new Error(`${ref} not found (${String(e.message).slice(0, 120)}). Check the ref.`);
      }
      if (!task.assignedToUs) throw new Error(`${ref} is not assigned to us`);
      const forged = await adapter.forgeCatchup(ref);
      if (!forged.stepId) throw new Error(`${ref} is not in any pipeline source stage — nothing to replay. Use run to start it.`);
      const force = args.force === true;
      store.reloadSeen();
      const wasSeen = store.hasSeen(forged.dedupKey);
      if (wasSeen && !force) {
        return { ref, step: forged.stepId, dispatched: false, reason: "already seen — the server would dedup-skip it; pass force to re-fire" };
      }
      const accepted = intake([{ kind: "pipeline", ref, stepId: forged.stepId, dedupKey: forged.dedupKey }], { force }) > 0;
      return {
        ref,
        step: forged.stepId,
        dispatched: accepted,
        ...(force ? { clearedDedup: wasSeen } : {}),
        reason: accepted ? "queued" : "a run for this step is queued or running, or the receiver is shutting down",
      };
    }),
    release: write("release", async (args) => {
      const ref = needString(args.ref, "ref");
      const comment = typeof args.comment === "string" ? args.comment.slice(0, COMMENT_MAX) : "";
      const job = resumeJob(cfg, store, ref, `mcp-${now()}`, comment);
      if (!job) throw new Error(`${ref} cannot be released: not held, held step is manual/unknown, or its attempt cap is reached`);
      // The `blocked` event (what a supervisor waits on) lands before the held run's own cleanup
      // (label move) finishes; an enqueue in that window is coalesced away. Wait for it to settle.
      if (!(await queue.whenFree(job, RELEASE_SETTLE_MS))) {
        throw new Error(`${ref}: its previous run is still finishing — try release again in a moment`);
      }
      if (intake([job], { force: true }) < 1) {
        throw new Error(`${ref}: the resume job was not accepted (a run for this step is queued or running, or the receiver is shutting down) — check status, then retry`);
      }
      return { ref, step: job.stepId, queued: true };
    }),
    reconcile: write("reconcile", async () => {
      const lines = /** @type {string[]} */ ([]);
      const r = await runReconcile(cfg, { store, adapter, intake, log: (m) => lines.push(m) });
      const { merged } = await runMergeCatchup(cfg, { store, adapter, forge, intake, log: (m) => lines.push(m) });
      return { ...r, merged, log: lines.slice(-20) };
    }),
    // Just the merge catch-up: the CLI `reconcile` on a webhook tracker replays resting tasks
    // over HTTP itself, then asks for this (it has no intake of its own).
    reconcile_merges: write("reconcile_merges", async () => {
      const lines = /** @type {string[]} */ ([]);
      const r = await runMergeCatchup(cfg, { store, adapter, forge, intake, log: (m) => lines.push(m) });
      return { ...r, log: lines.slice(-20) };
    }),
    // The Digest (src/digest.js): a tool-less summary outside the slot pool. Waits for the result;
    // a request while one runs joins it. Never touches the board, so it is not a ticket write.
    digest: write("digest", async () => {
      if (!digester) throw new Error("digest is not available on this receiver");
      return await digester.request();
    }),
    pull: write("pull", async () => {
      await pull();
      return { ...queue.state() };
    }),
  };
  // The control socket hides error text by default (unknown internals); these are operator
  // commands whose refusals ("not held", "already in the pipeline") ARE the answer.
  return Object.fromEntries(
    Object.entries(commands).map(([name, fn]) => [
      name,
      async (/** @type {any} */ args) => {
        try {
          return await fn(args);
        } catch (e) {
          // Bounded: tracker/forge errors can embed whole API error bodies (third-party text).
          const msg = String(e?.message ?? e);
          throw Object.assign(new Error(msg.length > MAX_ERROR_CHARS ? msg.slice(0, MAX_ERROR_CHARS - 1) + "…" : msg), { expose: true });
        }
      },
    ]),
  );
}
