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

// Wall-clock cap on one step run, in minutes (per-step `maxMinutes` overrides; 0 = off).
// An agent idling on something that will never happen (e.g. CI on a conflicting PR)
// would otherwise hold a maxConcurrent slot forever.
export const DEFAULT_MAX_MINUTES = 120;

/** @param {import('./types/config.js').Config} cfg @param {string} [stepId] */
export function findStep(cfg, stepId) {
  if (!cfg.pipeline || !stepId) return null;
  return cfg.pipeline.find((s) => s.id === stepId) || null;
}

/** The step before `stepId` in pipeline order — the default target a `changes`
 * verdict bounces back to (e.g. review → code). Null if first or unknown.
 * @param {import('./types/config.js').Config} cfg @param {string} stepId */
export function prevStep(cfg, stepId) {
  if (!cfg.pipeline) return null;
  const i = cfg.pipeline.findIndex((s) => s.id === stepId);
  return i > 0 ? cfg.pipeline[i - 1] : null;
}

/** The step whose SOURCE stage is `stage` (what adapter.currentStage returns: a label,
 * section gid or status), or null. Labels match case-insensitively, like the trackers.
 * @param {import('./types/config.js').Config} cfg @param {string|null|undefined} stage */
export function stepForStage(cfg, stage) {
  if (!cfg.pipeline || !stage) return null;
  const want = String(stage).toLowerCase();
  return (
    cfg.pipeline.find(
      (s) => s.sourceLabel?.toLowerCase() === want || s.sourceSectionGid === stage || s.sourceStatus === stage,
    ) || null
  );
}

/** @param {import('./types/config.js').Config} cfg */
export function isPipeline(cfg) {
  return Array.isArray(cfg.pipeline) && cfg.pipeline.length > 0;
}

/** The step's opt-in queue stage (backlog lane) under whichever tracker binding it uses
 * — Asana `queueSectionGid`, Jira/github-projects/local `queueStatus`, GitHub
 * `queueLabel` — or undefined. Setting one IS the opt-in to queue-stage pulls.
 * @param {import('./types/pipeline.js').Step} step */
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
 * @param {import('./types/config.js').Config} cfg
 * @param {import('./types/state.js').Store} store
 * @param {string} ref
 * @param {string} commentId  provider-native comment id → dedupKey `trigger:<id>`
 * @param {string} body       the comment text, passed to the resumed step's prompt
 * @returns {import('./types/pipeline.js').Job|null}
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

/**
 * The `run` guard, pure so it's unit-testable. Returns a refusal message when the ref
 * is already mid-flow (resting in a pipeline stage, or carrying a running job), or null
 * to allow. `--force` always allows. One ref = one in-flight flow: the worktree and
 * running.json are per-ref by design, so a second concurrent entry would race the first.
 * @param {string} ref
 * @param {{ stage?: string|null, running?: import('./types/state.js').RunningInfo|null, force?: boolean }} [state]
 * @returns {string|null}
 */
export function entryBlock(ref, { stage, running, force } = {}) {
  if (force) return null;
  const where = [];
  if (stage) where.push(stage);
  if (running) where.push(`running${running.stepId ? ` ${running.stepId}` : ""}`);
  if (!where.length) return null;
  return `${ref} is already in the pipeline (${where.join(" / ")}) — finish or reset it first, or pass --force.`;
}
