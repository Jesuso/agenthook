// Pipeline lookups. A pipeline is an ordered list of Steps (cfg.pipeline). The
// ENGINE reads only the platform-neutral fields here (id, kind, instructionsFile,
// createsWorktree, drainWorktree, manual, model); the tracker adapter reads the
// platform-specific binding (Asana section gids) off the SAME step objects. That
// split is what keeps the engine blind to the tracker.
//
// A pipeline is opt-in: cfg.pipeline is null unless the config declares one, in
// which case the legacy assignment/comment flow is bypassed for section routing.

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
