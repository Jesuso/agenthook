// Queue-stage pull — the ONE narrow exception to "no board poll outside reconcile".
// A step that sets a queue key (queueSectionGid / queueStatus / queueLabel) opts in to
// reading that one stage, only when a slot frees (a job settles) and once on boot —
// never on a timer. The top items (board order) are moved INTO the step with
// enterStage(…, {assign:false}) — the same move `ah run` makes — so the live webhook
// fires the step as usual; there is no direct enqueue. The in-memory queue stays FIFO:
// priority comes from only pulling into free slots, in board order.

/**
 * Free slots a pull may fill: `max − active − queued − pending`. `pending` counts refs a
 * pull already moved whose webhook-driven job hasn't arrived yet, so a second settle
 * can't over-pull into the same slot. Never negative.
 * @param {{max: number, active: number, queued: number, pending: number}} s
 */
export function freeSlots({ max, active, queued, pending }) {
  return Math.max(0, max - active - queued - pending);
}

/**
 * Pick which queue-stage items to pull into free slots. `candidates` is one entry per
 * queue step IN PIPELINE ORDER, each with its refs in board order (top first); we walk
 * them in that order, skip refs already pending/in flight (or picked for an earlier
 * step), and stop at `free`. `rank` is the ref's 0-based position in its step's list.
 * @param {{free: number, pending: Iterable<string>, inflightRefs: Iterable<string>,
 *   candidates: Array<{stepId: string, refs: string[]}>}} p
 * @returns {Array<{ref: string, stepId: string, rank: number}>}
 */
export function planPull({ free, pending, inflightRefs, candidates }) {
  const skip = new Set([...pending, ...inflightRefs]);
  /** @type {Array<{ref: string, stepId: string, rank: number}>} */
  const picks = [];
  for (const { stepId, refs } of candidates) {
    for (let rank = 0; rank < refs.length && picks.length < free; rank++) {
      const ref = refs[rank];
      if (skip.has(ref)) continue;
      skip.add(ref);
      picks.push({ ref, stepId, rank });
    }
  }
  return picks;
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
 *   max: number,
 *   queueState: () => {active: number, queued: number},
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
  const { steps, max, queueState, inflightRefs, listQueued, enterStage, stageOf, isDraining, emit, onDepth } = deps;
  const now = deps.now || Date.now;
  /** @type {Map<string, number>} ref → pulledAt (ms) */
  const pending = new Map();
  /** @type {Record<string, {depth: number, at: string}>} */
  const depth = {};
  let pulling = false;
  let again = false;

  const slots = () => freeSlots({ max, ...queueState(), pending: pending.size });

  async function pass() {
    const t = now();
    for (const [ref, at] of pending) if (t - at > PULL_TTL_MS) pending.delete(ref);
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
    const picks = planPull({ free: slots(), pending: pending.keys(), inflightRefs: inflightRefs(), candidates });
    for (const { ref, stepId, rank } of picks) {
      if (isDraining()) return;
      const step = steps.find((s) => s.id === stepId);
      pending.set(ref, now()); // before the move: its webhook may land before enterStage resolves
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
