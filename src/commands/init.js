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
const DEFAULT_TOKEN_ENV = { asana: "ASANA_TOKEN", github: "GITHUB_TOKEN" };

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
  const config = {
    name: core.name,
    repoPath: core.repoPath,
    trigger: core.trigger,
    maxConcurrent: Number(core.maxConcurrent),
    port: Number(core.port),
    fullAuto: !!core.fullAuto,
    claudeBin: "claude",
    instructionsFile: "./INSTRUCTIONS.md",
    tracker: blockFromAnswers(trackerAns.type, trackerAns),
    ingress: blockFromAnswers(ingressAns.type, ingressAns),
  };

  fs.writeFileSync(out, JSON.stringify(config, null, 2) + "\n");
  console.log(`\nwrote ${out}`);
  console.log(`state dir will be ~/.agenthook/${config.name}`);
  console.log(`\nNext:`);
  console.log(`  - ensure ${tokenEnv}${config.ingress.type === "ngrok" ? " (+ ngrok authtoken)" : ""} is set in your env/.env`);
  console.log(`  - drop an INSTRUCTIONS.md beside the config (standing agent rules)`);
  console.log(`  - agenthook start            # boot this profile`);
}
