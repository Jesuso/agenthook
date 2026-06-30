// `agenthook run <ref> [stepId]` (alias: kick / start-step) — inject a backlog item
// into a pipeline step. Until now there was no first-class way to START work: kicking
// off a NEW item meant manually (a) assigning it to the token's own account (fail-closed
// scoping) AND (b) moving it into the first step's SOURCE stage. catchup/reconcile only
// replay items ALREADY resting in a source stage, so neither starts a fresh one.
//
// This resolves the target step (the pipeline's first, or the one named), assigns the
// item to us (unless --no-assign), and moves it INTO that step's source stage via the
// adapter's enterStage — the same label/section/status setter advance already uses. The
// live webhook then fires the step normally; there is no special dispatch path. With no
// server up, the item simply rests in the stage and a later `reconcile` picks it up.
import { loadConfig } from "../config.js";
import { createStore } from "../store.js";
import { createAdapter } from "../trackers/index.js";
import { isPipeline, findStep } from "../pipeline.js";
import { readProfile } from "../heartbeat.js";

/** @param {any} args */
export async function run(args) {
  const cfg = loadConfig({ configPath: args.config });
  const store = createStore(cfg.dataDir);
  const adapter = createAdapter(cfg, store);

  const ref = args._[0];
  if (!ref) die("usage: agenthook run <ref> [stepId] [--no-assign] [--force]");
  if (!isPipeline(cfg)) die(`run is for pipeline configs; "${cfg.name}" has no tracker.pipeline.`);
  if (typeof adapter.enterStage !== "function") die(`tracker "${cfg.provider}" has no run support`);

  // Resolve the target step: the one named, or the pipeline's first.
  const stepId = args._[1];
  const step = stepId ? findStep(cfg, stepId) : cfg.pipeline?.[0];
  if (!step) die(stepId ? `no step "${stepId}" in the pipeline.` : `pipeline is empty.`);

  // Confirm the item exists (clear error if not) and surface its current state.
  let task;
  try {
    task = await adapter.fetchTask(ref);
  } catch (e) {
    die(`${ref} not found (${e.message}). Check the ref.`);
    return; // unreachable; satisfies the type checker (die is `never`)
  }
  if (task.completed) console.warn(`[warn] ${ref} ("${task.name}") is already completed — entering it anyway.`);

  const assign = args["no-assign"] !== true;
  if (!assign && !task.assignedToUs && cfg.tracker.assigneeFilter !== false) {
    console.warn(`[warn] --no-assign and ${ref} is not assigned to us — the receiver will SKIP it (fail-closed scoping).`);
  }

  // Guard: one ref = one in-flight flow. The worktree (worktree.js) and crash-recovery
  // state (store.running) are BOTH keyed by ref, so re-injecting an item that's already
  // mid-flow double-dispatches — two agents race in ONE worktree and clobber each other's
  // running.json entry (the real #19 incident). Refuse if the item rests in any pipeline
  // stage or already has a running job, unless --force.
  const force = args.force === true;
  const running = force ? null : store.listRunning()[ref] || null;
  /** @type {string|null} */
  let inStage = null;
  if (!force && typeof adapter.currentStage === "function") {
    try {
      inStage = await adapter.currentStage(ref);
    } catch (e) {
      die(`could not verify ${ref} is not already in the pipeline (${e.message}) — pass --force to skip this check.`);
    }
  }
  const blocked = entryBlock(ref, { stage: inStage, running, force });
  if (blocked) die(blocked);

  // GitHub refuses to add a label that doesn't yet exist in the repo; boot creates the
  // pipeline labels via ensureLabels. Run it here too so `run` works before a first boot.
  // (No-op for trackers without it — Asana/Jira sections/statuses already exist.)
  if (typeof adapter.ensureLabels === "function") await adapter.ensureLabels();

  let stage;
  try {
    ({ stage } = await adapter.enterStage(ref, step.id, { assign }));
  } catch (e) {
    die(`could not enter ${ref} into step "${step.id}": ${e.message}`);
  }

  console.log(`${ref} -> step "${step.id}" (entered stage "${stage}"${assign ? ", assigned to us" : ""}).`);
  const profile = readProfile(cfg.name);
  if (profile.up) {
    console.log(`The running receiver picks it up from the webhook. If it doesn't fire, run \`agenthook reconcile\`.`);
  } else {
    console.log(`No receiver running for "${cfg.name}" — ${ref} now rests in the stage; start it (\`agenthook start\`) or run \`agenthook reconcile\` once it's up.`);
  }
}

/**
 * The `run` guard, pure so it's unit-testable. Returns a refusal message when the ref
 * is already mid-flow (resting in a pipeline stage, or carrying a running job), or null
 * to allow. `--force` always allows. One ref = one in-flight flow: the worktree and
 * running.json are per-ref by design, so a second concurrent entry would race the first.
 * @param {string} ref
 * @param {{ stage?: string|null, running?: import('../types.js').RunningInfo|null, force?: boolean }} [state]
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

/** @param {string} msg @returns {never} */
function die(msg) {
  console.error(msg);
  process.exit(1);
}
