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
  if (!ref) die("usage: agenthook run <ref> [stepId] [--no-assign]");
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

/** @param {string} msg @returns {never} */
function die(msg) {
  console.error(msg);
  process.exit(1);
}
