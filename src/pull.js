// Queue-stage pull — the ONE narrow exception to "no board poll outside reconcile".
// A step that sets a queue key (queueSectionGid / queueStatus / queueLabel) opts in to
// reading that one stage, only when a slot frees (a job settles) and once on boot —
// never on a timer. The top items (board order) are moved INTO the step with
// enterStage(…, {assign:false}) — the same move `ah run` makes — so the live webhook
// fires the step as usual; there is no direct enqueue. The in-memory queue stays FIFO:
// priority comes from only pulling into free slots, in board order.

/**
 * Free slots a pull may fill: `max − active − (queued − capped) − pending`. `pending` counts
 * refs a pull already moved whose webhook-driven job hasn't arrived yet, so a second settle
 * can't over-pull into the same slot. `capped` queued jobs wait on their step's own cap, not
 * on a slot, so they don't hold one. Never negative.
 * @param {{max: number, active: number, queued: number, capped?: number, pending: number}} s
 */
export function freeSlots({ max, active, queued, capped = 0, pending }) {
  return Math.max(0, max - active - (queued - capped) - pending);
}

/**
 * Pick which queue-stage items to pull into free slots. `candidates` is one entry per
 * queue step IN PIPELINE ORDER, each with its refs in board order (top first); we walk
 * them in that order, skip refs already pending/in flight (or picked for an earlier
 * step), and stop at `free`. `rank` is the ref's 0-based position in its step's list.
 * `budget` (stepId → n) bounds a step with its own `maxConcurrent`: its remaining room
 * (cap − active − queued − pending for that step). A step absent from it is unbounded.
 * @param {{free: number, pending: Iterable<string>, inflightRefs: Iterable<string>,
 *   candidates: Array<{stepId: string, refs: string[]}>, budget?: Record<string, number>}} p
 * @returns {Array<{ref: string, stepId: string, rank: number}>}
 */
export function planPull({ free, pending, inflightRefs, candidates, budget = {} }) {
  const skip = new Set([...pending, ...inflightRefs]);
  /** @type {Array<{ref: string, stepId: string, rank: number}>} */
  const picks = [];
  for (const { stepId, refs } of candidates) {
    let room = Object.hasOwn(budget, stepId) ? Math.max(0, budget[stepId]) : Infinity;
    for (let rank = 0; rank < refs.length && picks.length < free && room > 0; rank++) {
      const ref = refs[rank];
      if (skip.has(ref)) continue;
      skip.add(ref);
      picks.push({ ref, stepId, rank });
      room--;
    }
  }
  return picks;
}

/**
 * Remaining pull budget per CAPPED step: `cap − active − queued − pending` for that step,
 * never negative. Uncapped steps are absent (unbounded).
 * @param {Record<string, number>} caps  stepId → the step's maxConcurrent
 * @param {Record<string, {active: number, queued: number}>} stepState  the queue's per-step counts
 * @param {Iterable<string>} pendingSteps  the stepId of every pending pull
 * @returns {Record<string, number>}
 */
export function stepBudget(caps, stepState, pendingSteps) {
  /** @type {Record<string, number>} */
  const pendingOf = {};
  for (const id of pendingSteps) pendingOf[id] = (pendingOf[id] ?? 0) + 1;
  /** @type {Record<string, number>} */
  const out = {};
  for (const [id, cap] of Object.entries(caps)) {
    const s = Object.hasOwn(stepState, id) ? stepState[id] : { active: 0, queued: 0 };
    out[id] = Math.max(0, cap - s.active - s.queued - (pendingOf[id] ?? 0));
  }
  return out;
}

/** How long a pulled ref holds its slot waiting for its webhook before it's forgotten
 * (checked lazily on the next trigger — never by a timer). */
export const PULL_TTL_MS = 10 * 60 * 1000;

/**
 * The puller the engine wires to boot + every job settle. Single-flight: a trigger while
 * a pass runs sets a flag and exactly one more pass follows. Best-effort: a listQueued /
 * enterStage failure is logged and skipped — the next settle retries naturally. `steps`
 * are the queue steps in pipeline order (empty ⇒ pull is a no-op); `inflightRefs` are the
 * refs in running.json + queue.json.
 * @param {{
 *   steps: import('./types.js').Step[],
 *   max: number | (() => number),   // a function tracks the live cap (`set_concurrency`)
 *   queueState: () => {active: number, queued: number, capped?: number},
 *   stepState?: () => Record<string, {active: number, queued: number}>,  // per-step counts (only read for capped steps)
 *   inflightRefs: () => string[],
 *   listQueued: (stepId: string) => Promise<string[]>,
 *   enterStage: (ref: string, stepId: string, opts: {assign: boolean}) => Promise<unknown>,
 *   stageOf: (step: import('./types.js').Step) => string|undefined,
 *   isDraining: () => boolean,
 *   emit?: (event: string, ref: string, step: string, extra?: Record<string, any>) => void,
 *   onDepth?: (depth: Record<string, {depth: number, at: string}>) => void,
 *   now?: () => number,
 * }} deps
 */
export function createPuller(deps) {
  const { steps, max, queueState, stepState, inflightRefs, listQueued, enterStage, stageOf, isDraining, emit, onDepth } = deps;
  const now = deps.now || Date.now;
  /** @type {Record<string, number>} stepId → maxConcurrent, for the queue steps that set one */
  const caps = {};
  for (const s of steps) if (s.maxConcurrent != null) caps[s.id] = s.maxConcurrent;
  /** @type {Map<string, {at: number, stepId: string}>} ref → when + into which step it was pulled */
  const pending = new Map();
  /** @type {Record<string, {depth: number, at: string}>} */
  const depth = {};
  let pulling = false;
  let again = false;

  const slots = () => freeSlots({ max: typeof max === "function" ? max() : max, ...queueState(), pending: pending.size });

  async function pass() {
    const t = now();
    for (const [ref, { at }] of pending) if (t - at > PULL_TTL_MS) pending.delete(ref);
    if (!slots()) return;
    /** @type {Array<{stepId: string, refs: string[]}>} */
    const candidates = [];
    for (const step of steps) {
      try {
        const refs = await listQueued(step.id);
        candidates.push({ stepId: step.id, refs });
        depth[step.id] = { depth: refs.length, at: new Date(now()).toISOString() };
      } catch (e) {
        console.error(`[pull] listQueued ${step.id} failed (continuing):`, e.message);
      }
    }
    onDepth?.(depth);
    // Re-read the slots: a webhook may have enqueued work while we listed.
    const budget = stepBudget(caps, stepState?.() ?? {}, [...pending.values()].map((p) => p.stepId));
    const picks = planPull({ free: slots(), pending: pending.keys(), inflightRefs: inflightRefs(), candidates, budget });
    for (const { ref, stepId, rank } of picks) {
      if (isDraining()) return;
      const step = steps.find((s) => s.id === stepId);
      pending.set(ref, { at: now(), stepId }); // before the move: its webhook may land before enterStage resolves
      try {
        await enterStage(ref, stepId, { assign: false });
        console.log(`[pull] ${ref} -> ${stepId} (queue rank ${rank})`);
        emit?.("pulled", ref, stepId, { from: step && stageOf(step), rank });
      } catch (e) {
        pending.delete(ref);
        console.error(`[pull] enterStage ${ref} (${stepId}) failed (continuing):`, e.message);
      }
    }
  }

  return {
    /** Run a pull pass (or flag one to follow the pass in progress). Never throws. */
    async pull() {
      if (!steps.length || isDraining()) return;
      if (pulling) {
        again = true;
        return;
      }
      pulling = true;
      try {
        do {
          again = false;
          await pass();
        } while (again && !isDraining());
      } catch (e) {
        console.error("[pull] failed (continuing):", e.message);
      } finally {
        pulling = false;
      }
    },
    /** A job for `ref` reached intake — its slot is now counted by the queue. @param {string} ref */
    arrived(ref) {
      pending.delete(ref);
    },
    /** Refs pulled but not yet arrived (for tests/diagnostics). */
    pending: () => [...pending.keys()],
  };
}
