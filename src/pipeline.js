// Pipeline lookups. A pipeline is an ordered list of Steps (cfg.pipeline). The
// ENGINE reads only the platform-neutral fields here (id, kind, instructionsFile,
// createsWorktree, drainWorktree, manual, model); the tracker adapter reads the
// platform-specific binding (Asana section gids) off the SAME step objects. That
// split is what keeps the engine blind to the tracker.
//
// A pipeline is opt-in: cfg.pipeline is null unless the config declares one, in
// which case the legacy assignment/comment flow is bypassed for section routing.

// How many times one step may run for a single ref before a `changes` loop back into
// it is forced to fail (per-step `maxAttempts` overrides). Also caps `@agent` resumes:
// agents and the owner share one tracker identity, so this bounds a self-trigger loop.
export const DEFAULT_MAX_ATTEMPTS = 3;

/** @param {import('./types.js').Config} cfg @param {string} [stepId] */
export function findStep(cfg, stepId) {
  if (!cfg.pipeline || !stepId) return null;
  return cfg.pipeline.find((s) => s.id === stepId) || null;
}

/** The step before `stepId` in pipeline order — the default target a `changes`
 * verdict bounces back to (e.g. review → code). Null if first or unknown.
 * @param {import('./types.js').Config} cfg @param {string} stepId */
export function prevStep(cfg, stepId) {
  if (!cfg.pipeline) return null;
  const i = cfg.pipeline.findIndex((s) => s.id === stepId);
  return i > 0 ? cfg.pipeline[i - 1] : null;
}

/** @param {import('./types.js').Config} cfg */
export function isPipeline(cfg) {
  return Array.isArray(cfg.pipeline) && cfg.pipeline.length > 0;
}

/** The step's opt-in queue stage (backlog lane) under whichever tracker binding it uses
 * — Asana `queueSectionGid`, Jira/github-projects/local `queueStatus`, GitHub
 * `queueLabel` — or undefined. Setting one IS the opt-in to queue-stage pulls.
 * @param {import('./types.js').Step} step */
export function queueStageOf(step) {
  return step.queueSectionGid || step.queueStatus || step.queueLabel || undefined;
}

/** Does a comment body open with the trigger prefix (e.g. "@agent")? An unset trigger
 * matches nothing (fail-closed). @param {string|undefined} trigger @param {unknown} body */
export function startsWithTrigger(trigger, body) {
  return !!trigger && typeof body === "string" && body.trimStart().startsWith(trigger);
}

/**
 * The adapter-neutral half of the `@agent` comment trigger: given an item whose
 * comment already passed the author, prefix, and assignee checks, build the job that
 * resumes the step it is held on — or null (logged) when there is nothing to resume:
 * no held record, a held step that is unknown/manual, or the step at its attempt cap.
 * @param {import('./types.js').Config} cfg
 * @param {import('./types.js').Store} store
 * @param {string} ref
 * @param {string} commentId  provider-native comment id → dedupKey `trigger:<id>`
 * @param {string} body       the comment text, passed to the resumed step's prompt
 * @returns {import('./types.js').Job|null}
 */
export function resumeJob(cfg, store, ref, commentId, body) {
  const held = store.getHeld(ref);
  if (!held) {
    console.log(`[trigger] ${ref}: no held step — ignoring`);
    return null;
  }
  const step = findStep(cfg, held.stepId);
  if (!step || step.manual) {
    console.log(`[trigger] ${ref}: held step "${held.stepId}" is not a runnable step — ignoring`);
    return null;
  }
  const ran = store.getAttempt(ref, step.id);
  const cap = step.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  if (ran >= cap) {
    console.log(`[trigger] ${ref}: step "${step.id}" is at its attempt cap (${ran}/${cap}) — ignoring`);
    return null;
  }
  console.log(`[trigger] ${ref}: owner reply resumes held step "${step.id}"`);
  return { kind: "pipeline", ref, stepId: step.id, dedupKey: `trigger:${commentId}`, comment: body };
}
