// `agenthook init` — interactive scaffold of agenthook.config.json in the current
// dir (tsconfig-style). The provider-specific questions come from each adapter's
// wizardSteps() hook, which may hit the tracker API to let you PICK a workspace /
// project / repo instead of pasting gids. Secrets are written as ${ENV} refs so the
// file stays shareable; the live token (read from that env var now) powers discovery.
import fs from "node:fs";
import path from "node:path";
import { runWizard } from "../wizard.js";
import { TRACKERS, createAdapter } from "../trackers/index.js";
import { INGRESS } from "../ingress/index.js";

/** @type {Record<string, string>} */
const DEFAULT_TOKEN_ENV = { asana: "ASANA_TOKEN" };

// A starter pipeline: one coding step with placeholder section gids the user fills
// in. The config is unusable until these are real (loadConfig requires a pipeline),
// so init writes the skeleton + prints a TODO rather than a config that silently
// does nothing. (Interactive section discovery is a follow-up.)
const PLACEHOLDER_PIPELINE = [
  {
    id: "code",
    kind: "implement",
    createsWorktree: true,
    instructionsFile: "./INSTRUCTIONS_CODE.md",
    sourceSectionGid: "TODO_SOURCE_SECTION_GID",
    successSectionGid: "TODO_REVIEW_SECTION_GID",
    failureSectionGid: "TODO_BLOCKED_SECTION_GID",
  },
];

/** Turn collected answers into a config block: `<x>Env` answers become "${VAL}" refs.
 * @param {string} type @param {Record<string,any>} ans */
function blockFromAnswers(type, ans) {
  /** @type {Record<string, any>} */
  const block = { type };
  for (const [k, v] of Object.entries(ans)) {
    if (v === "" || v == null) continue;
    if (k.endsWith("Env")) block[k.slice(0, -3)] = `\${${v}}`;
    else block[k] = v;
  }
  return block;
}

/** @param {any} args */
export async function init(args) {
  const out = args.config ? path.resolve(args.config) : path.join(process.cwd(), "agenthook.config.json");
  if (fs.existsSync(out) && !args.force) {
    throw new Error(`${out} already exists. Re-run with --force to overwrite.`);
  }

  // --- core ---
  /** @type {Record<string, any>} */
  const core = {};
  await runWizard(
    [
      {
        key: "name",
        message: "Profile name (keys the state dir under ~/.agenthook)",
        default: path.basename(process.cwd()),
        validate: (v) => (/^[A-Za-z0-9._-]+$/.test(v) ? true : "use letters, digits, . _ -"),
      },
      { key: "repoPath", message: "Path to the repo agents work in", default: process.cwd() },
      { key: "trigger", message: "Comment trigger prefix", default: "@agent" },
      { key: "maxConcurrent", message: "Max concurrent agents", default: "2", validate: (v) => (Number(v) >= 1 ? true : "≥ 1") },
      { key: "port", message: "Local receiver port", default: "4123" },
      { key: "fullAuto", message: "Run claude with --dangerously-skip-permissions?", type: "confirm", default: true },
    ],
    core,
  );

  // --- tracker (type, token env, then adapter-driven live discovery) ---
  const trackerAns = await runWizard([
    { key: "type", message: "Tracker", type: "select", choices: Object.keys(TRACKERS).map((t) => ({ title: t, value: t })) },
  ]);
  const tokenEnv = (
    await runWizard([
      {
        key: "tokenEnv",
        message: `Env var holding the ${trackerAns.type} API token`,
        default: DEFAULT_TOKEN_ENV[trackerAns.type] || "API_TOKEN",
      },
    ])
  ).tokenEnv;

  const token = process.env[tokenEnv];
  if (!token) {
    throw new Error(
      `${tokenEnv} is not set. Export it (or add it to a .env here), then re-run \`agenthook init\` — ` +
        `the live token is needed to look up your workspace/project/repo.`,
    );
  }
  trackerAns.tokenEnv = tokenEnv;

  // Build a throwaway adapter purely for its wizardSteps() discovery.
  /** @type {any} */
  const stubStore = { getSecret: () => undefined, setSecret: () => {}, secretCount: () => 0, reloadSeen: () => {}, hasSeen: () => false, markSeen: () => {}, unmarkSeen: () => {}, seenCount: () => 0, seenFile: "" };
  /** @type {any} */
  const probeCfg = { provider: trackerAns.type, trigger: core.trigger, providerConfig: { type: trackerAns.type, token } };
  const adapter = createAdapter(probeCfg, stubStore);
  if (adapter.wizardSteps) await runWizard(adapter.wizardSteps(trackerAns), trackerAns);

  // --- ingress ---
  const ingressAns = await runWizard([
    {
      key: "type",
      message: "Ingress (how the receiver is reachable)",
      type: "select",
      choices: Object.keys(INGRESS).map((t) => ({ title: t, value: t })),
    },
  ]);
  /** @type {any} */
  const ingressFactory = INGRESS[ingressAns.type];
  const ingress = ingressFactory({ ingress: { type: ingressAns.type }, port: Number(core.port) });
  if (ingress.wizardSteps) await runWizard(ingress.wizardSteps(), ingressAns);

  // --- assemble + write ---
  const tracker = blockFromAnswers(trackerAns.type, trackerAns);
  tracker.pipeline = PLACEHOLDER_PIPELINE;
  const config = {
    name: core.name,
    repoPath: core.repoPath,
    trigger: core.trigger,
    maxConcurrent: Number(core.maxConcurrent),
    port: Number(core.port),
    fullAuto: !!core.fullAuto,
    claudeBin: "claude",
    tracker,
    ingress: blockFromAnswers(ingressAns.type, ingressAns),
  };

  fs.writeFileSync(out, JSON.stringify(config, null, 2) + "\n");
  console.log(`\nwrote ${out}`);
  console.log(`state dir will be ~/.agenthook/${config.name}`);
  console.log(`\nNext:`);
  console.log(`  - ensure ${tokenEnv}${config.ingress.type === "ngrok" ? " (+ ngrok authtoken)" : ""} is set in your env/.env`);
  console.log(`  - EDIT tracker.pipeline: replace the TODO_* section gids and add steps`);
  console.log(`  - drop the per-step instruction files beside the config (e.g. INSTRUCTIONS_CODE.md)`);
  console.log(`  - agenthook start            # boot this profile`);
}
