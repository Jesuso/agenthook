// `agenthook init` — interactive scaffold of agenthook.config.json in the current
// dir (tsconfig-style). The provider-specific questions come from each adapter's
// wizardSteps() hook, which may hit the tracker API to let you PICK a workspace /
// project / repo instead of pasting gids. Secrets are written as ${ENV} refs so the
// file stays shareable; the live token (read from that env var now) powers discovery.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { runWizard } from "../wizard.js";
import { TRACKERS, createAdapter } from "../trackers/index.js";
import { INGRESS } from "../ingress/index.js";
import { FORGES } from "../forges/index.js";
import { forgeOffer, mergeStepCandidates, forgeBlock } from "../forges/github.js";
import { parseGitlabRemote, forgeOffer as gitlabForgeOffer, forgeBlock as gitlabForgeBlock } from "../forges/gitlab.js";
import { installAh } from "./alias.js";
import { firstFreePort } from "../port.js";
import { registryDir } from "../config.js";
import { tildify } from "../profile.js";

/** @type {Record<string, string>} */
const DEFAULT_TOKEN_ENV = { asana: "ASANA_TOKEN", jira: "JIRA_API_TOKEN", github: "GITHUB_TOKEN", "github-projects": "GITHUB_TOKEN" };

// A starter pipeline: one coding step. When the tracker adapter can discover the
// real stages (the common path — see each adapter's wizardSteps + pipelineBindings),
// init writes a working binding and there is nothing to edit. The PLACEHOLDER below
// is the FALLBACK for an adapter that can't discover (or a project with no stages):
// the config is unusable until these are real (loadConfig requires a pipeline), so
// init writes the skeleton + prints a TODO rather than a config that silently does
// nothing. The binding fields differ per tracker — Asana sections, Jira statuses,
// GitHub labels — so the placeholder is shaped to match.
const base = { id: "code", kind: "implement", createsWorktree: true, instructionsFile: "./INSTRUCTIONS_CODE.md" };
/** @type {Record<string, any[]>} */
const PLACEHOLDER_PIPELINES = {
  asana: [{ ...base, sourceSectionGid: "TODO_SOURCE_SECTION_GID", successSectionGid: "TODO_REVIEW_SECTION_GID", failureSectionGid: "TODO_BLOCKED_SECTION_GID" }],
  jira: [{ ...base, sourceStatus: "TODO_SOURCE_STATUS", successStatus: "TODO_REVIEW_STATUS", failureStatus: "TODO_BLOCKED_STATUS" }],
  github: [{ ...base, sourceLabel: "TODO_SOURCE_LABEL", successLabel: "TODO_REVIEW_LABEL", failureLabel: "TODO_BLOCKED_LABEL" }],
  "github-projects": [{ ...base, sourceStatus: "TODO_SOURCE_STATUS", successStatus: "TODO_REVIEW_STATUS", failureStatus: "TODO_BLOCKED_STATUS" }],
};

/** Which forge `init` offers, by the origin remote: a GitLab remote → the gitlab forge;
 * anything else → the github forge, exactly as before. Pure.
 * @param {{remoteUrl?: string, trackerType?: string, trackerRepository?: string}} opts
 * @returns {{key: "github"|"gitlab", offer: Record<string, any>}} */
export function initForge({ remoteUrl, trackerType, trackerRepository } = {}) {
  if (parseGitlabRemote(remoteUrl)) return { key: "gitlab", offer: gitlabForgeOffer({ remoteUrl }) };
  return { key: "github", offer: forgeOffer({ trackerType, trackerRepository, remoteUrl }) };
}

/** The forge config block `init` writes from that forge's wizard answers. Pure.
 * @param {string} key @param {Record<string, any>} ans
 * @returns {import('../types.js').ForgeConfig} */
export function initForgeBlock(key, ans) {
  if (key === "gitlab") return gitlabForgeBlock({ project: ans.project, baseUrl: ans.baseUrl, tokenEnv: ans.tokenEnv });
  return forgeBlock({ repository: ans.repository, tokenEnv: ans.tokenEnv });
}

/** Turn collected answers into a config block: `<x>Env` answers become "${VAL}" refs.
 * @param {string} type @param {Record<string,any>} ans */
function blockFromAnswers(type, ans) {
  /** @type {Record<string, any>} */
  const block = { type };
  for (const [k, v] of Object.entries(ans)) {
    if (v === "" || v == null) continue;
    if (k.startsWith("_")) continue; // wizard-internal (e.g. pipeline stage picks) — not a tracker field
    if (k.endsWith("Env")) block[k.slice(0, -3)] = `\${${v}}`;
    else block[k] = v;
  }
  return block;
}

/** @param {string} base the branch agent worktrees start from */
const LOCAL_CODE_INSTRUCTIONS = (base) => `# Standing instructions — \`code\` step

You are an autonomous coding agent working in an isolated git worktree of this repo, on its own
branch (started from \`${base}\`). The task is appended below the \`=== TICKET ===\` marker.

- Make the smallest change that does what the task asks. Match the surrounding code's style.
- Stay in scope: don't reformat, rename or "tidy" unrelated code.
- If the repo has tests, run them and make them pass.
- Commit your work on this branch with a clear message. Don't push and don't open a PR — the
  branch is the deliverable.
- If the task is unclear or unsafe to do unattended, write a \`hold\` verdict with your question
  instead of guessing.
`;

/** @param {string} base the branch agent worktrees start from */
const LOCAL_REVIEW_INSTRUCTIONS = (base) => `# Standing instructions — \`review\` step

You review a change another agent made in this worktree. The task is appended below the
\`=== TICKET ===\` marker.

- Read everything the branch adds over its base: \`git log --oneline ${base}..HEAD\` and
  \`git diff ${base}...HEAD\`, plus \`git diff\` for anything left uncommitted.
- Check the change does what the task asks, stays in scope, and doesn't break anything. If the
  repo has tests, run them.
- Don't edit code. Report problems as a \`changes\` verdict with concrete findings; a correct,
  safe change \`advance\`s.
`;

/**
 * The `init --local` scaffold, pure: a local-tracker profile (code → review → done, no token,
 * no tunnel) plus its two starter instruction files (paths relative to the config's dir).
 * @param {{repoRoot: string, name: string, port: number, fullAuto: boolean, base?: string}} o
 * @returns {{config: Record<string, any>, files: Record<string, string>}}
 */
export function localScaffold({ repoRoot, name, port, fullAuto, base = "main" }) {
  const lanes = { failureStatus: "blocked", holdStatus: "held" };
  return {
    config: {
      name,
      repoPath: repoRoot,
      maxConcurrent: 2,
      port,
      fullAuto,
      claudeBin: "claude",
      // Nothing calls this URL (the local tracker registers no webhook); it only satisfies manual.up().
      ingress: { type: "manual", url: `http://127.0.0.1:${port}` },
      tracker: {
        type: "local",
        pipeline: [
          { id: "code", kind: "implement", sourceStatus: "code", successStatus: "review", ...lanes, createsWorktree: true, instructionsFile: "./INSTRUCTIONS_CODE.md" },
          { id: "review", kind: "review", sourceStatus: "review", successStatus: "done", ...lanes, instructionsFile: "./INSTRUCTIONS_REVIEW.md" },
          { id: "done", manual: true, sourceStatus: "done", drainWorktree: true },
        ],
      },
    },
    files: { "INSTRUCTIONS_CODE.md": LOCAL_CODE_INSTRUCTIONS(base), "INSTRUCTIONS_REVIEW.md": LOCAL_REVIEW_INSTRUCTIONS(base) },
  };
}

/** A profile name from free text: [A-Za-z0-9._-] only. @param {string} raw */
export function sanitizeName(raw) {
  return String(raw).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "local";
}

/** @param {string} cwd @param {string[]} gitArgs @returns {string|null} */
function gitOut(cwd, gitArgs) {
  try {
    return execFileSync("git", gitArgs, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

/**
 * `agenthook init --local`: a zero-setup profile on the local tracker — no tracker token, ingress
 * or forge wizard. One summary confirmation (--yes skips it) and a separate fullAuto opt-in that
 * defaults to No: only an interactive "y" or --full-auto enables it, never --yes.
 * @param {any} args @param {string} out
 */
async function initLocal(args, out) {
  const hint = "init --local must run inside a git repository (git init && git commit first)";
  const repoRoot = gitOut(process.cwd(), ["rev-parse", "--show-toplevel"]);
  if (!repoRoot || gitOut(repoRoot, ["rev-parse", "--verify", "HEAD"]) == null) throw new Error(hint); // worktrees need a HEAD; the CLI exits 1
  const base = gitOut(repoRoot, ["rev-parse", "--abbrev-ref", "origin/HEAD"])?.replace(/^origin\//, "") || gitOut(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]) || "main";
  const name = sanitizeName(typeof args.name === "string" ? args.name : path.basename(repoRoot));
  const port = await firstFreePort(4123);

  console.log(`\nagenthook init --local`);
  console.log(`  repo    ${repoRoot}`);
  console.log(`  name    ${name}  (state dir ${tildify(path.join(registryDir, name))})`);
  console.log(`  port    ${port}`);
  console.log(`  steps   code → review → done  (local board, no token, no tunnel)`);
  console.log(`  config  ${out}`);
  if (!args.yes) {
    const { ok } = await runWizard([{ key: "ok", message: "Write this profile?", type: "confirm", default: true }]);
    if (!ok) return console.log("aborted — nothing written.");
  }
  let fullAuto = args["full-auto"] === true;
  if (!fullAuto && !args.yes) {
    ({ fullAuto } = await runWizard([
      { key: "fullAuto", message: "fullAuto: run claude with --dangerously-skip-permissions (UNSANDBOXED code exec in this repo, no permission prompts)?", type: "confirm", default: false },
    ]));
  }

  const { config, files } = localScaffold({ repoRoot, name, port, fullAuto: !!fullAuto, base });
  fs.writeFileSync(out, JSON.stringify(config, null, 2) + "\n");
  console.log(`\nwrote ${out}`);
  for (const [file, text] of Object.entries(files)) {
    const p = path.join(path.dirname(out), file);
    if (fs.existsSync(p)) console.log(`kept existing ${p}`);
    else {
      fs.writeFileSync(p, text);
      console.log(`wrote ${p}`);
    }
  }
  if (!config.fullAuto) {
    console.warn(
      `\n[warn] fullAuto is off: the code step can't edit files unless this repo's .claude/settings.json ` +
        `allows Edit/Write/Bash, or you re-run \`agenthook init --local --force --full-auto\` (see docs/sandbox.md).`,
    );
  }
  console.log(`\nNext:`);
  console.log(`  agenthook start --detach           # boot the receiver`);
  console.log(`  agenthook ticket add "<what to do>" # the code step fires at once`);
  console.log(`  agenthook ui                       # watch it (or: agenthook events --follow)`);
  console.log(`  git log -p HEAD..agent/<ref>       # the result, once it reaches done`);
}

/** @param {any} args */
export async function init(args) {
  const out = args.config ? path.resolve(args.config) : path.join(process.cwd(), "agenthook.config.json");
  if (fs.existsSync(out) && !args.force) {
    throw new Error(`${out} already exists. Re-run with --force to overwrite.`);
  }
  if (args.local) return initLocal(args, out);

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
      { key: "fullAuto", message: "fullAuto: run claude with --dangerously-skip-permissions (UNSANDBOXED code exec from a webhook)?", type: "confirm", default: false },
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

  // The adapter turns its wizard's live stage picks (the `_*Stage` answers) into real
  // step bindings; only when it can't do we fall back to the editable TODO_* skeleton.
  const bindings = adapter.pipelineBindings?.(trackerAns);
  const pipeline = bindings ? [{ ...base, ...bindings }] : PLACEHOLDER_PIPELINES[trackerAns.type] || PLACEHOLDER_PIPELINES.asana;

  // --- forge (optional third axis: what happened to the code — e.g. a PR merged) ---
  // The origin remote picks the forge: a GitLab remote → gitlab, anything else → github.
  // A forge with no manual step to complete-on-merge still drains + cleans up (see the
  // issue's Evidence) — mergeStepCandidates is empty for init's single-`code` pipeline.
  let remoteUrl = "";
  try {
    remoteUrl = execFileSync("git", ["-C", core.repoPath, "remote", "get-url", "origin"], { encoding: "utf8" }).trim();
  } catch {
    // no origin remote — forgeOffer falls back to defaultYes:false
  }
  const picked = initForge({ remoteUrl, trackerType: trackerAns.type, trackerRepository: trackerAns.repository });
  const forgeKey = picked.key;
  const forge = FORGES[forgeKey](/** @type {any} */ ({ forge: { type: forgeKey } }), stubStore);
  /** @type {Record<string, any>} */
  let forgeAns = {};
  if (typeof forge.wizardSteps !== "function") {
    console.log(`\n(no forge adapter offers setup for this tracker yet — skipping)`);
  } else {
    forgeAns._forgeOffer = picked.offer;
    forgeAns._mergeStepCandidates = mergeStepCandidates(pipeline);
    if (forgeKey === "gitlab") forgeAns._defaultTokenEnv = "GITLAB_TOKEN";
    else forgeAns._defaultTokenEnv = trackerAns.type === "github" || trackerAns.type === "github-projects" ? tokenEnv : DEFAULT_TOKEN_ENV.github;
    await runWizard(forge.wizardSteps(forgeAns), forgeAns);
  }

  // --- assemble + write ---
  const tracker = blockFromAnswers(trackerAns.type, trackerAns);
  tracker.pipeline = pipeline;
  /** @type {Record<string, any>} */
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

  let forgeTokenEnv = "";
  if (forgeAns._useForge) {
    forgeTokenEnv = forgeAns.tokenEnv;
    config.forge = initForgeBlock(forgeKey, forgeAns);
    if (forgeAns._completeOnMerge) {
      const step = pipeline.find((s) => s.id === forgeAns._completeOnMerge);
      if (step) step.completeOnMerge = true;
    }
  }

  fs.writeFileSync(out, JSON.stringify(config, null, 2) + "\n");
  console.log(`\nwrote ${out}`);
  console.log(`state dir will be ${tildify(path.join(registryDir, config.name))}`);

  // Opt-in `ah` shortcut. Offer only — never force it (see commands/alias.js).
  const { ah } = await runWizard([{ key: "ah", message: "Add an `ah` shortcut for `agenthook`?", type: "confirm", default: true }]);
  if (ah) console.log(installAh().message);

  console.log(`\nNext:`);
  const envs = [tokenEnv, ...(forgeTokenEnv && forgeTokenEnv !== tokenEnv ? [forgeTokenEnv] : [])];
  console.log(`  - ensure ${envs.join(", ")}${config.ingress.type === "ngrok" ? " (+ ngrok authtoken)" : ""} is set in your env/.env`);
  if (bindings) console.log(`  - tracker.pipeline is bound to the stages you picked — add more steps for a longer pipeline`);
  else console.log(`  - EDIT tracker.pipeline: replace the TODO_* section gids and add steps`);
  console.log(`  - drop the per-step instruction files beside the config (e.g. INSTRUCTIONS_CODE.md)`);
  if (config.forge) {
    console.log(`  - forge webhook is served on /forge (auto-created on start; needs ngrok or a stable ingress URL)`);
    if (forgeKey === "gitlab") {
      console.log(`  - forge token: api scope + Maintainer role on ${config.forge.project} (see docs/gitlab.md)`);
    } else if (trackerAns.type !== "github" && trackerAns.type !== "github-projects") {
      console.log(`  - forge token scopes: repo + admin:repo_hook (classic), or Webhooks + Actions + Pull requests RW (fine-grained)`);
    }
  }
  console.log(`  - agenthook start            # boot this profile`);
}
