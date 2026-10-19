// `agenthook doctor` — preflight a profile before you trust it. Loads the config,
// then checks the things that silently break a run: missing token, repoPath not a
// git repo, agent/tunnel binaries absent, port already taken, ingress misconfigured.
// Multi-repo profiles also get routing lints; ⚠ warnings print but don't fail the run.
// (Duplicate repo ids / paths / route keys and >1 default are already fatal in loadConfig.)
// `--fix` applies the safe, local, idempotent fixes a ✗/⚠ check carries, then re-checks.
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import { portInUse } from "../port.js";
import path from "node:path";
import { execFile, spawnSync } from "node:child_process";
import { loadConfig, ensurePrivateDir } from "../config.js";
import { worktreeDir } from "../paths.js";
import { reposOf, defaultRepo, primaryRepo } from "../repos.js";
import { listWorktrees } from "../worktree.js";
import { readProfile, isAlive, instructionTargets } from "../heartbeat.js";
import { systemdScopeAvailable, classifyCgroup } from "../respawn.js";
import { fileURLToPath } from "node:url";
import { agentFor } from "../agents/index.js";
import { hermesSourceHome, hermesProviderInfo } from "../agents/hermes-home.js";
import { uiBundleState } from "../ui-bundle.js";
import { isAppAuth, normalizePem, createGithubAuth, mintInstallationToken } from "../github-auth.js";
import { runTokenPermissions, revokeRunToken, originUrl } from "../github-run-token.js";
import { parseGithubRemote } from "../forges/github.js";
import { isSandboxed } from "../sandbox/names.js";
import { DEFAULT_IMAGE, AGENT_DOCKERFILE, buildImageArgs } from "../sandbox/image.js";
import { claudePermissionArgs, claudePolicyArgs, sandboxCredentialProblem } from "../agents/claude.js";
import { agentSpawnEnv } from "../dispatch/spawn.js";
import { hostGitFacts, inferredForgeEgressHosts } from "../dispatch/sandbox.js";
import { agentEnvAllow, buildAgentEnv, envNameMatches, looksSecret, strippedNames } from "../agent-env.js";
import { TRACKER_AGENT_ENV, TRACKER_EGRESS_HOSTS } from "../trackers/index.js";
import { FORGE_AGENT_ENV, FORGE_EGRESS_HOSTS } from "../forges/index.js";
import { egressPolicy, egressRules, needsEgressProxy } from "../sandbox/egress.js";

const UI_SRC_DIR = fileURLToPath(new URL("../../ui/src/", import.meta.url));
const UI_DIST_DIR = fileURLToPath(new URL("../../ui/dist/", import.meta.url));

/** One CLI call for the sandbox checks: a non-zero exit resolves, a spawn failure rejects.
 * @type {import('../types.js').IngressRun} */
const execRun = (bin, args, { timeoutMs }) =>
  new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, encoding: "utf8" }, (err, stdout, stderr) => {
      if (err && typeof err.code !== "number") return reject(err);
      resolve({ code: err ? Number(err.code) : 0, stdout, stderr });
    });
  });

/** @param {string} bin */
function onPath(bin) {
  const r = spawnSync(process.platform === "win32" ? "where" : "which", [bin], { encoding: "utf8" });
  return r.status === 0;
}

/** The distinct agent binaries the pipeline spawns ON THE HOST, resolved exactly like dispatch
 * (`step.bin || agent.defaults.bin || cfg.claudeBin`) for every non-manual step, each with
 * its agent and the step ids that use it — doctor checks each is on PATH. A sandboxed step's
 * binary resolves inside the image instead (sandboxChecks). Pure.
 * @param {Pick<import('../types.js').Config, 'claudeBin'|'agent'|'pipeline'|'sandbox'>} cfg
 * @returns {{ bin: string, agent: string, steps: string[] }[]} */
export function agentBinChecks(cfg) {
  /** @type {Map<string, { bin: string, agent: string, steps: string[] }>} */
  const byKey = new Map();
  for (const s of cfg.pipeline ?? []) {
    if (s.manual || isSandboxed(cfg, s)) continue;
    const agent = agentFor(cfg, s);
    const bin = s.bin || agent.defaults.bin || cfg.claudeBin;
    const name = agent.describe().name;
    const key = `${name}\0${bin}`;
    const group = byKey.get(key) ?? { bin, agent: name, steps: [] };
    group.steps.push(s.id);
    byKey.set(key, group);
  }
  return [...byKey.values()];
}

/** Per-step agent lints that pass loadConfig yet weaken the pipeline. Pure (config only).
 * Today: a text-only agent (no structured stream — hermes) with `requireVerdict: false`
 * set explicitly, so a run that wrote no verdict file advances unchecked.
 * @param {Pick<import('../types.js').Config, 'agent'|'pipeline'>} cfg
 * @returns {{ level: 'warn', label: string, note: string }[]} */
export function agentLints(cfg) {
  /** @type {{ level: 'warn', label: string, note: string }[]} */
  const out = [];
  for (const s of cfg.pipeline ?? []) {
    if (s.manual || s.requireVerdict !== false) continue;
    const d = agentFor(cfg, s).describe();
    if (d.stdout !== "text") continue;
    out.push({ level: "warn", label: `step "${s.id}" requires a verdict`, note: `${d.name} output is plain text — with requireVerdict:false a run that wrote no verdict file advances` });
  }
  return out;
}

/** First words of an `allow.commands` entry that run arbitrary code (interpreters, shells, build
 * tools, wrappers): allowing one makes the allowlist advisory. */
const CODE_RUNNERS = new Set(["node", "python", "python3", "sh", "bash", "zsh", "npx", "npm", "pnpm", "yarn", "bun", "deno", "make", "perl", "ruby", "env", "xargs", "eval", "docker"]);

/** Per-step `allow`/`deny` policy lints (#475). Pure (config only). ✗ a policy the step's agent
 * can't enforce (its runs are refused); ⚠ an allowed command that runs arbitrary code, an allow
 * policy outside the sandbox, an implement/worktree step whose allowlist lacks git (or gh with a
 * forge) the prompt asks for; ℹ the effective claude permission tail (claudePermissionArgs).
 * @param {Pick<import('../types.js').Config, 'agent'|'pipeline'|'sandbox'|'forge'|'fullAuto'>} cfg
 * @returns {{ level: 'fail'|'warn'|'info', label: string, note: string }[]} */
export function policyLints(cfg) {
  /** @type {{ level: 'fail'|'warn'|'info', label: string, note: string }[]} */
  const out = [];
  /** @param {import('../types.js').Step} s */
  const rules = (s) => claudePermissionArgs({ fullAuto: cfg.fullAuto, allow: s.allow, deny: s.deny, cwd: "/<cwd>", verdictFile: "/<verdictFile>" }).join(" ");
  for (const s of cfg.pipeline ?? []) {
    if (s.manual || (!s.allow && !s.deny)) continue;
    const d = agentFor(cfg, s).describe();
    const unenforced = /** @type {const} */ (["allow", "deny"]).filter((k) => s[k] && !d.policy?.[k]);
    for (const k of unenforced) {
      out.push({ level: "fail", label: `step "${s.id}" ${k} policy`, note: `${d.name} cannot enforce it — runs of this step are refused; use agent "claude" or remove the policy` });
    }
    if (!s.allow) {
      if (!unenforced.length) out.push({ level: "info", label: `step "${s.id}" claude rules`, note: rules(s) });
      continue;
    }
    const label = `step "${s.id}" allow policy`;
    const cmds = s.allow.commands ?? [];
    for (const c of cmds) {
      if (CODE_RUNNERS.has(c) || CODE_RUNNERS.has(c.split(/\s+/)[0]) || c.startsWith("git -c")) {
        out.push({ level: "warn", label, note: `"${c}" lets the agent run arbitrary code — the allowlist is advisory for this step` });
      }
    }
    if (!isSandboxed(cfg, s)) {
      out.push({ level: "warn", label, note: "without a sandbox the allow policy is advisory against an injected agent (sh -c, absolute paths and interpreters bypass it); path limits are only structural inside the sandbox" });
    }
    if (s.createsWorktree || (s.kind ?? "implement") === "implement") {
      const covers = (/** @type {string} */ tool) => cmds.some((c) => c === tool || c.startsWith(`${tool} `));
      const missing = ["git", ...(cfg.forge ? ["gh"] : [])].filter((t) => !covers(t));
      for (const t of missing) out.push({ level: "warn", label, note: `allow.commands has no "${t}" entry — the prompt asks for it` });
    }
    if (!unenforced.length) out.push({ level: "info", label: `step "${s.id}" claude rules`, note: rules(s) });
  }
  return out;
}

/** The agent env allowlist's pattern sources for this profile (#470), each tagged for doctor's
 * lines: the tracker prompt's, the forge's, the operator's, and each agent the pipeline spawns.
 * @param {Pick<import('../types.js').Config, 'agent'|'pipeline'|'provider'|'forge'|'agentEnvPassthrough'>} cfg */
function agentEnvSources(cfg) {
  const tracker = TRACKER_AGENT_ENV[cfg.provider] ?? [];
  const forge = cfg.forge ? (FORGE_AGENT_ENV[cfg.forge.type] ?? []) : [];
  const operator = cfg.agentEnvPassthrough ?? [];
  /** @type {Map<string, {name: string, envPassthrough: string[], steps: import('../types.js').Step[]}>} */
  const agents = new Map();
  const steps = (cfg.pipeline ?? []).filter((s) => !s.manual);
  for (const s of steps.length ? steps : [undefined]) {
    const a = agentFor(cfg, s);
    const name = a.describe().name;
    const g = agents.get(name) ?? { name, envPassthrough: a.envPassthrough ?? [], steps: [] };
    if (s) g.steps.push(s);
    agents.set(name, g);
  }
  /** The allowlist one agent's runs get. @param {string[]} agentPatterns */
  const allowFor = (agentPatterns) => agentEnvAllow({ agent: agentPatterns, tracker, forge, operator });
  return { tracker, forge, operator, agents: [...agents.values()], allowFor };
}

/** Agent env lints (#470), names only — never values. The migration view (receiver credentials
 * no longer passed), the credentials agents still get and why, a `"*"` passthrough, and the
 * variables a run likely needs but loses: Bedrock/Vertex for claude, provider keys for opencode
 * or a non-isolated hermes, a tracker token the prompt names under a different variable, git's
 * own settings. Pure given `env` (and the config file `tokenVar` reads).
 * @param {Pick<import('../types.js').Config, 'agent'|'pipeline'|'provider'|'forge'|'agentEnvPassthrough'|'configPath'>} cfg
 * @param {{env?: Record<string, string|undefined>, platform?: string}} [io]
 * @returns {{ level: 'info'|'warn', label: string, note?: string, fix?: Fix }[]} */
export function agentEnvLints(cfg, { env = process.env, platform = process.platform } = {}) {
  /** @type {{ level: 'info'|'warn', label: string, note?: string, fix?: Fix }[]} */
  const out = [];
  const { tracker, forge, operator, agents, allowFor } = agentEnvSources(cfg);
  const set = Object.keys(env).filter((k) => env[k] !== undefined);
  const stripFor = (/** @type {string[]} */ agentPatterns) => strippedNames({ source: env, allow: allowFor(agentPatterns), platform });
  // A name stripped for every agent the pipeline spawns.
  const stripped = agents.map((a) => new Set(stripFor(a.envPassthrough))).reduce((acc, s2) => new Set([...acc].filter((n) => s2.has(n))));
  const passthroughFix = (/** @type {string[]} */ names) => ({ manual: `add ${names.join(", ")} to agentEnvPassthrough in the config (or set them in the step's env)` });

  if (operator.includes("*")) {
    const secrets = set.filter(looksSecret).sort();
    out.push({ level: "warn", label: `agent env: agentEnvPassthrough is "*"`, note: `agents inherit the receiver's whole environment${secrets.length ? `, including ${secrets.join(", ")}` : ""}`, fix: { manual: `list only the names agents need in agentEnvPassthrough` } });
  } else {
    const gone = [...stripped].filter(looksSecret).sort();
    if (gone.length) out.push({ level: "info", label: "agent env: not passed to agents", note: gone.join(", ") });
    /** @type {[string, readonly string[]][]} */
    const sources = [
      ["tracker prompt", tracker],
      [`forge (${cfg.forge?.type === "github" ? "gh" : cfg.forge?.type})`, forge],
      ...agents.map((a) => /** @type {[string, readonly string[]]} */ ([a.name, a.envPassthrough])),
      ["agentEnvPassthrough", operator],
    ];
    const kept = set
      .filter((k) => looksSecret(k) && !stripped.has(k))
      .sort()
      .map((k) => `${k} (${sources.filter(([, p]) => envNameMatches(k, p, platform)).map(([src]) => src).join(", ") || "allowlist"})`);
    if (kept.length) out.push({ level: "info", label: "agent env: credentials agents still get", note: kept.join(", ") });
  }

  const truthy = (/** @type {string} */ k) => !!env[k] && env[k] !== "0" && env[k]?.toLowerCase() !== "false";
  const claude = agents.find((a) => a.name === "claude");
  if (claude) {
    const lost = new Set(stripFor(claude.envPassthrough));
    if (truthy("CLAUDE_CODE_USE_BEDROCK")) {
      const aws = [...lost].filter((n) => n.startsWith("AWS_"));
      if (aws.length) out.push({ level: "warn", label: "agent env: claude on Bedrock loses AWS credentials", note: `stripped: ${aws.join(", ")}`, fix: passthroughFix(["AWS_*"]) });
    }
    if (truthy("CLAUDE_CODE_USE_VERTEX")) {
      const gcp = ["GOOGLE_APPLICATION_CREDENTIALS", "CLOUD_ML_REGION", "GOOGLE_CLOUD_PROJECT"].filter((n) => lost.has(n));
      if (gcp.length) out.push({ level: "warn", label: "agent env: claude on Vertex loses its Google settings", note: `stripped: ${gcp.join(", ")}`, fix: passthroughFix(gcp) });
    }
  }
  for (const a of agents) {
    if (a.name !== "opencode" && !(a.name === "hermes" && a.steps.some((s) => s.isolated === false))) continue;
    const keys = stripFor(a.envPassthrough).filter((n) => /_API_KEY$/.test(n));
    if (keys.length) out.push({ level: "warn", label: `agent env: ${a.name} provider keys stripped`, note: `${a.name} may read provider keys from env: ${keys.join(", ")}; add the ones it uses to agentEnvPassthrough`, fix: passthroughFix(keys) });
  }

  const v = cfg.provider === "local" ? null : tokenVar(cfg.configPath);
  for (const name of tracker) {
    if (v && v !== name && env[name] === undefined) {
      out.push({ level: "warn", label: `agent env: tracker token is \${${v}} but the prompt tells agents to use $${name}, which is unset`, note: "agents can't comment", fix: { manual: `also set ${name} in .env (or set it in each step's env: {"${name}": "\${${v}}"})` } });
    }
  }

  const git = [...stripped].filter((n) => n === "GIT_SSH_COMMAND" || n === "GIT_ASKPASS" || n.startsWith("GIT_CONFIG_"));
  if (git.length) out.push({ level: "warn", label: "agent env: git in the agent loses its settings", note: `git in the agent loses ${git.join(", ")}`, fix: passthroughFix(git) });
  return out;
}

/** Can the agents' `gh` authenticate (#470)? Every non-local tracker's prompts open and review PRs
 * with `gh`, which reads GH_TOKEN / GITHUB_TOKEN or its own login — run `gh auth status` with the
 * env the profile's default agent would get. The receiver's own env never reaches the probe.
 * @param {Pick<import('../types.js').Config, 'agent'|'pipeline'|'provider'|'forge'|'agentEnvPassthrough'>} cfg
 * @param {{spawn: Spawner, onPath: (bin: string) => boolean, env?: Record<string, string|undefined>, platform?: string}} io
 * @returns {Finding[]} */
export function ghAuthLints(cfg, { spawn, onPath: have, env = process.env, platform = process.platform }) {
  if (cfg.provider === "local") return [];
  if (!have("gh")) return [{ level: "warn", label: "gh not on PATH", note: "agents open and review PRs with gh", fix: { manual: "install the GitHub CLI (https://cli.github.com)" } }];
  const { allowFor } = agentEnvSources(cfg);
  const agentEnv = buildAgentEnv({ source: env, allow: allowFor(agentFor(cfg).envPassthrough ?? []), platform });
  const r = spawn("gh", ["auth", "status"], { stdio: "ignore", env: agentEnv, timeout: 15000 });
  if (r.status === 0) return [];
  return [{ level: "warn", label: "gh is not authenticated for agents (they open and review PRs with gh)", fix: { manual: "add GH_TOKEN to agentEnvPassthrough (or set it in the step env), or run gh auth login" } }];
}

/** Isolated hermes steps (the default) whose run would fail for want of credentials: the
 * source `config.yaml` an isolated home copies is missing, or the step's provider (step →
 * cfg.agentProvider → config.yaml `model.provider`) is not a local `providers:` entry.
 * Pure given `readFile` (returns the text, or null when missing); an undecidable provider
 * stays silent, like the run's own fail-open check.
 * @param {Pick<import('../types.js').Config, 'agent'|'pipeline'|'agentProvider'>} cfg
 * @param {{sourceHome: string, readFile: (file: string) => string|null}} io
 * @returns {{ level: 'warn', label: string, note: string }[]} */
export function hermesLints(cfg, { sourceHome, readFile }) {
  /** @type {{ level: 'warn', label: string, note: string }[]} */
  const out = [];
  const file = path.join(sourceHome, "config.yaml");
  /** @type {string|null|undefined} */
  let text;
  for (const s of cfg.pipeline ?? []) {
    if (s.manual || s.isolated === false || s.env?.HERMES_HOME || agentFor(cfg, s).describe().name !== "hermes") continue;
    if (text === undefined) text = readFile(file);
    const label = `step "${s.id}" isolated hermes home`;
    if (text === null) {
      out.push({ level: "warn", label, note: `${file} is missing — the run will fail; create it or set isolated:false` });
      continue;
    }
    const { effective, local } = hermesProviderInfo(text, s.provider ?? cfg.agentProvider);
    if (local === false) out.push({ level: "warn", label, note: `provider "${effective}" is not a local providers: entry in ${file} — an isolated run has no credentials; use a local provider or set isolated:false` });
  }
  return out;
}

/** Pipeline step bindings (the source-, success-, failure-, hold-prefixed keys)
 * left empty or still an `init` `TODO_*` placeholder. These pass every other
 * check yet match no incoming event, so the receiver silently does nothing — the
 * common first-run trap. Returns `step.id.key` per offender (absent optional
 * bindings are fine).
 * @param {import('../types.js').Step[]|null} pipeline */
export function unfilledBindings(pipeline) {
  /** @type {string[]} */
  const out = [];
  for (const step of pipeline || []) {
    for (const [k, v] of Object.entries(step)) {
      if (/^(source|success|failure|hold)/.test(k) && typeof v === "string" && (v.trim() === "" || v.startsWith("TODO_"))) {
        out.push(`${step.id}.${k}`);
      }
    }
  }
  return out;
}

/** Pre-`repos` worktrees (`<base>/<safeRef>`, depth 1 under the repo's worktree base).
 * Multi-repo paths nest one level deeper (`<base>/<repo.id>/<ref>`), so these are
 * orphans left from before `repos` was declared.
 * @param {import('../types.js').Config} cfg @param {import('../types.js').RepoConfig} repo
 * @param {string[]} worktreePaths  e.g. listWorktrees(repo.path).map((w) => w.path) */
export function legacyOrphans(cfg, repo, worktreePaths) {
  if (!cfg.multiRepo) return [];
  const base = worktreeDir(cfg, repo);
  return worktreePaths.filter((p) => path.dirname(p) === base);
}

/** Multi-repo routing lints that pass loadConfig yet leave tickets unroutable or
 * unparkable. Pure (config only). Empty for single-repo profiles.
 * @param {import('../types.js').Config} cfg
 * @returns {{ level: 'fail'|'warn', label: string, note?: string }[]} problems only */
export function repoLints(cfg) {
  /** @type {{ level: 'fail'|'warn', label: string, note?: string }[]} */
  const out = [];
  if (!cfg.multiRepo) return out;
  const repos = reposOf(cfg);
  if (repos.length > 1 && !cfg.providerConfig?.routeField) {
    out.push({ level: "fail", label: "tracker.routeField set", note: `${repos.length} repos but no routeField — nothing can ever route` });
  }
  if (!defaultRepo(cfg)) {
    out.push({ level: "warn", label: "a default repo is set", note: "none — every unrouted ticket will HOLD (mark one repo default:true)" });
  }
  const noHold = (cfg.pipeline || [])
    .filter((s) => !s.manual && !Object.entries(s).some(([k, v]) => k.startsWith("hold") && typeof v === "string" && v.trim()))
    .map((s) => s.id);
  if (noHold.length) {
    out.push({ level: "warn", label: "steps have a hold binding", note: `${noHold.join(", ")} — routing errors have nowhere to park` });
  }
  return out;
}

/** Warn when a `github` tracker has no forge block — merge/CI events never arrive
 * and the event-driven loop quietly falls back to polling — or when a `gitlab` forge
 * block is missing what it needs. Pure (config only).
 * @param {import('../types.js').Config} cfg
 * @returns {{level: 'warn', label: string, note: string}[]} */
export function forgeLints(cfg) {
  if (cfg.forge?.type === "gitlab") return gitlabForgeLints(cfg.forge);
  if (cfg.provider !== "github" || cfg.forge) return [];
  return [{ level: "warn", label: "forge configured", note: "no forge block — merge/CI events will not arrive" }];
}

/** A `gitlab` forge needs a `group/project` path, a token, and an http(s) base URL. Pure.
 * @param {import('../types.js').ForgeConfig} fc
 * @returns {{level: 'warn', label: string, note: string}[]} */
function gitlabForgeLints(fc) {
  /** @type {{level: 'warn', label: string, note: string}[]} */
  const out = [];
  const project = typeof fc.project === "string" ? fc.project.trim() : "";
  if (!project.includes("/")) {
    out.push({ level: "warn", label: "forge.project set", note: project ? `"${project}" is not group/project` : "gitlab forge has no forge.project (group/sub/project)" });
  }
  const token = typeof fc.token === "string" ? fc.token.trim() : "";
  if (!token || /\$\{[^}]*\}/.test(token)) {
    out.push({ level: "warn", label: "forge.token set", note: "gitlab forge token is empty or unresolved — set it (e.g. ${GITLAB_TOKEN})" });
  }
  if (fc.baseUrl != null && !/^https?:\/\/[^/\s]+/.test(String(fc.baseUrl))) {
    out.push({ level: "warn", label: "forge.baseUrl is an http(s) URL", note: `"${fc.baseUrl}"` });
  }
  return out;
}

/** The ingress preflight: a managed tunnel needs its binary on PATH (cloudflared also both or
 * neither of tunnel/hostname); tailscale needs only its CLI; a static ingress needs ingress.url.
 * @param {import('../types.js').IngressConfig} ingress @param {(bin: string) => boolean} [has]
 * @returns {{ ok: boolean, label: string, note?: string, manual: string }[]} */
export function ingressChecks(ingress, has = onPath) {
  if (ingress.type === "ngrok") return [{ ok: has(process.env.NGROK || "ngrok"), label: "ngrok binary on PATH", manual: "install ngrok or put it on PATH (or set $NGROK)" }];
  if (ingress.type === "tailscale") return [{ ok: has(process.env.TAILSCALE || "tailscale"), label: "tailscale binary on PATH", manual: "install tailscale or put it on PATH (or set $TAILSCALE)" }];
  if (ingress.type === "cloudflared") {
    /** @type {{ ok: boolean, label: string, note?: string, manual: string }[]} */
    const checks = [{ ok: has(process.env.CLOUDFLARED || "cloudflared"), label: "cloudflared binary on PATH", manual: "install cloudflared or put it on PATH (or set $CLOUDFLARED)" }];
    if (ingress.tunnel || ingress.hostname) {
      const ok = !!ingress.tunnel && !!ingress.hostname;
      checks.push({ ok, label: "cloudflared named tunnel: tunnel + hostname both set", note: ok ? "" : `missing ingress.${ingress.tunnel ? "hostname" : "tunnel"}`, manual: "set both ingress.tunnel and ingress.hostname, or neither for a quick tunnel" });
    }
    return checks;
  }
  return [{ ok: !!ingress.url, label: `ingress.url set (${ingress.type})`, note: ingress.url || "missing", manual: "set ingress.url in the config" }];
}

/** The default image builder: `<bin> build -t <image> -` with the Dockerfile on stdin.
 * @param {string} bin @param {string[]} args @param {string} dockerfile */
const buildImage = (bin, args, dockerfile) => spawnSync(bin, args, { input: dockerfile, stdio: ["pipe", "inherit", "inherit"] });

/**
 * The per-run sandbox preflight (only with a `sandbox` block): the runtime CLI on PATH and
 * reachable, the image present (fix: build the default recipe), and per sandboxed step an
 * agent that supports the sandbox, claude's credential var, and a binary that resolves
 * inside the image.
 * @param {import('../types.js').Config} cfg
 * @param {{run: import('../types.js').IngressRun, has?: (bin: string) => boolean, build?: (bin: string, args: string[], dockerfile: string) => { status: number|null }}} io
 * @returns {Promise<Check[]>}
 */
export async function sandboxChecks(cfg, { run, has = onPath, build = buildImage }) {
  if (!cfg.sandbox) return [];
  const runtime = cfg.sandbox.type;
  const env = runtime.toUpperCase();
  const bin = process.env[env] || runtime;
  const image = cfg.sandbox.image || DEFAULT_IMAGE;
  /** @type {Check[]} */
  const out = [];
  if (!has(bin)) {
    out.push({ ok: false, label: `sandbox: ${runtime} binary on PATH`, note: bin, fix: { manual: `install ${runtime} or put it on PATH (or set $${env})` } });
    return out;
  }
  out.push({ ok: true, label: `sandbox: ${runtime} binary on PATH`, note: bin });
  const info = await run(bin, ["info"], { timeoutMs: 30_000 }).catch((e) => ({ code: 1, stdout: "", stderr: e.message }));
  const rootNote = runtime === "docker" ? "docker group membership is root-equivalent; prefer rootless podman" : "";
  if (info.code !== 0) {
    out.push({ ok: false, label: `sandbox: \`${bin} info\` succeeds`, note: (info.stderr || info.stdout).trim().split("\n")[0], fix: { manual: `start the ${runtime} daemon/socket, or give this user access to it` } });
    return out;
  }
  out.push({ ok: true, label: `sandbox: \`${bin} info\` succeeds`, note: rootNote });
  // The egress proxy runs the built-in image, so an allowlist profile with a custom image needs both.
  for (const img of new Set([image, ...(needsEgressProxy(cfg) ? [DEFAULT_IMAGE] : [])])) {
    const r = await run(bin, ["image", "inspect", img], { timeoutMs: 30_000 }).catch((e) => ({ code: 1, stdout: "", stderr: e.message }));
    out.push({
      ok: r.code === 0,
      label: `sandbox image present: ${img}${img !== image ? " (egress proxy)" : ""}`,
      note: r.code === 0 ? "" : "missing",
      fix: img === DEFAULT_IMAGE
        ? {
            describe: `build ${img}`,
            apply: () => {
              const b = build(bin, buildImageArgs(runtime, img), AGENT_DOCKERFILE);
              if (b.status !== 0) throw new Error(`\`${bin} build\` exited ${b.status}`);
            },
          }
        : { manual: `build ${img} (FROM ${DEFAULT_IMAGE}, with sh, git, gh and the agent CLI on PATH) — see docs/sandbox.md` },
    });
  }
  for (const s of cfg.pipeline ?? []) {
    if (s.manual || !isSandboxed(cfg, s)) continue;
    const agent = agentFor(cfg, s);
    const name = agent.describe().name;
    if (!agent.sandbox) {
      out.push({ ok: false, label: `step "${s.id}" (${name}) can run sandboxed`, note: `${name} does not support the sandbox yet — its runs are refused`, fix: { manual: `set "sandbox": false on step "${s.id}" to run it on the host, or use the claude agent` } });
      continue;
    }
    if (name === "claude") {
      const problem = sandboxCredentialProblem(agentSpawnEnv({ cfg, agent, agentEnv: agent.env?.({ cfg, step: s }), env: s.env }));
      out.push({ ok: !problem, label: `step "${s.id}" has a claude credential for the sandbox`, note: problem ? "no CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY / …" : "", fix: { manual: problem ?? "" } });
    }
    const stepBin = s.bin || agent.defaults.bin || cfg.claudeBin;
    if (path.isAbsolute(stepBin)) {
      out.push({ ok: true, warn: true, label: `step "${s.id}" agent binary is a host path: ${stepBin}`, note: "a sandboxed run resolves it inside the image — likely exit 127; use a name on the image's PATH" });
    }
  }
  return out;
}

/** Lockfiles at a repo root → the registry preset its agents likely need. */
const LOCKFILE_PRESETS = /** @type {[RegExp, string][]} */ ([
  [/^(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml)$/, "@npm"],
  [/^yarn\.lock$/, "@yarn"],
  [/^(poetry\.lock|requirements.*\.txt|uv\.lock|pyproject\.toml)$/, "@pypi"],
  [/^Cargo\.lock$/, "@crates"],
  [/^go\.sum$/, "@go"],
  [/^Gemfile\.lock$/, "@rubygems"],
  [/^(pom\.xml|build\.gradle.*)$/, "@maven"],
]);

/** @param {string|undefined} url */
function isLoopbackUrl(url) {
  try {
    const h = new URL(String(url)).hostname.replace(/^\[(.*)\]$/, "$1").toLowerCase();
    return h === "localhost" || h.endsWith(".localhost") || /^127\./.test(h) || h === "::1";
  } catch {
    return false;
  }
}

/**
 * Egress lints for a sandboxed profile (#473): ⚠ an `open` mode (profile or step), ⚠ a loopback
 * ANTHROPIC_BASE_URL a container can't reach, ℹ a registry preset a repo-root lockfile suggests
 * (when a sandboxed allowlist step lacks it), and ℹ each sandboxed step's effective policy.
 * Pure given `files` (the repo root listing) and `env` (the receiver env agents draw from).
 * @param {import('../types.js').Config} cfg
 * @param {{files?: string[], env?: Record<string, string|undefined>, origins?: string[]}} [io]  `origins`: the repos' origin URLs (a profile with no forge block infers its forge hosts from them, as dispatch does)
 * @returns {{ level: 'info'|'warn', label: string, note?: string }[]} */
export function egressLints(cfg, { files = [], env = process.env, origins = [] } = {}) {
  if (!cfg.sandbox) return [];
  /** @type {{ level: 'info'|'warn', label: string, note?: string }[]} */
  const out = [];
  const exfil = "sandboxed runs can reach any host — an injected agent can exfiltrate the worktree and its env";
  if (cfg.sandbox.egress?.mode === "open") out.push({ level: "warn", label: `sandbox egress mode is "open"`, note: exfil });
  const steps = (cfg.pipeline ?? []).filter((s) => !s.manual && isSandboxed(cfg, s));
  for (const s of steps) if (s.egress?.mode === "open") out.push({ level: "warn", label: `step "${s.id}" egress mode is "open"`, note: exfil });

  const tracker = TRACKER_AGENT_ENV[cfg.provider] ?? [];
  const forge = cfg.forge ? (FORGE_AGENT_ENV[cfg.forge.type] ?? []) : [];
  /** @type {Map<string, string[]>} */
  const loopback = new Map();
  for (const s of steps) {
    const agent = agentFor(cfg, s);
    const allow = agentEnvAllow({ agent: agent.envPassthrough, tracker, forge, operator: cfg.agentEnvPassthrough });
    const spawnEnv = buildAgentEnv({ source: env, allow, layers: [agent.env?.({ cfg, step: s }), s.env] });
    const base = spawnEnv.ANTHROPIC_BASE_URL;
    if (agent.describe().name === "claude" && base && isLoopbackUrl(base)) loopback.set(base, [...(loopback.get(base) ?? []), s.id]);
    const policy = egressPolicy(cfg, s);
    if (policy.mode !== "allowlist") {
      if (policy.mode === "none") out.push({ level: "info", label: `step "${s.id}" egress: none`, note: "no network at all" });
      continue;
    }
    try {
      const rules = egressRules({
        agentHosts: agent.egressHosts?.(spawnEnv) ?? [],
        trackerHosts: TRACKER_EGRESS_HOSTS[cfg.provider]?.(cfg.providerConfig) ?? [],
        forgeHosts: cfg.forge ? (FORGE_EGRESS_HOSTS[cfg.forge.type]?.(cfg.forge) ?? []) : origins.flatMap(inferredForgeEgressHosts),
        allow: policy.allow,
        deny: policy.deny,
      });
      out.push({ level: "info", label: `step "${s.id}" egress allowlist`, note: `${rules.join(", ")} + the repo's origin host` });
    } catch (e) {
      out.push({ level: "warn", label: `step "${s.id}" egress allowlist`, note: e.message });
    }
  }
  for (const [url, ids] of loopback) {
    out.push({ level: "warn", label: `ANTHROPIC_BASE_URL is loopback (steps: ${ids.join(", ")})`, note: `the sandbox cannot reach ${url}; use a host-reachable address (host.docker.internal / host.containers.internal) and allow it` });
  }
  const allowSteps = steps.filter((s) => egressPolicy(cfg, s).mode === "allowlist");
  /** @type {Map<string, string[]>} */
  const hints = new Map();
  for (const f of files) {
    const preset = LOCKFILE_PRESETS.find(([re]) => re.test(f))?.[1];
    if (preset && allowSteps.some((s) => !egressPolicy(cfg, s).allow.includes(preset))) hints.set(preset, [...(hints.get(preset) ?? []), f]);
  }
  for (const [preset, found] of hints) {
    out.push({ level: "info", label: `egress: ${found.join(", ")} found — registries are not allowed by default`, note: `add "${preset}" to sandbox.egress.allow (or a step's egress.allow) if agents install packages` });
  }
  return out;
}

/** Whether a busy port is this profile's own receiver (info, not a problem) or a real
 * conflict (fail). Pure.
 * @param {{ port: number, busy: boolean, profile: { up: boolean, pid: number, heartbeatPort?: number|null } }} args
 * @returns {{ level: 'ok'|'info'|'fail', label: string, note?: string }} */
export function portCheck({ port, busy, profile }) {
  if (!busy) return { level: "ok", label: `port ${port} is free` };
  if (profile.up && (profile.heartbeatPort == null || profile.heartbeatPort === port)) {
    return { level: "info", label: `port ${port} is in use by this profile's receiver (pid ${profile.pid})` };
  }
  return { level: "fail", label: `port ${port} is free`, note: "something is already listening" };
}

/** A check's remedy: a safe local fix (`describe` is its `--dry-run` text) or the manual
 * action for a problem that is never auto-fixed. Only ✗/⚠ checks carry one.
 * @typedef {{ describe: string, apply: () => void|Promise<void> } | { manual: string }} Fix */
/** @typedef {{ ok: boolean, warn?: boolean, info?: boolean, label: string, note?: string, fix?: Fix }} Check */
/** A detector's problem (`info`: a ✓-side note, never a problem). @typedef {{ level: 'fail'|'warn'|'info', label: string, note?: string, fix?: Fix }} Finding */
/** The child-process seam for the two fixers that shell out (tests inject a recorder).
 * @typedef {(cmd: string, args: string[], opts: {cwd?: string, stdio?: any, env?: Record<string, string>, timeout?: number, encoding?: BufferEncoding}) => { status: number|null, stdout?: string|Buffer }} Spawner */

/** A pidfile's raw text and pid (0 when unparsable); null when absent/unreadable. @param {string} file */
function readPidFile(file) {
  try {
    const text = fs.readFileSync(file, "utf8");
    return { text, pid: Number(text.trim()) || 0 };
  } catch {
    return null;
  }
}

/** The state dir exists but group/other can read it (POSIX only) — run logs, verdicts and
 * the control socket live there. A missing dir is not a problem (boot creates it 0700).
 * @param {Pick<import('../types.js').Config, 'stateDir'>} cfg @param {{platform?: string}} [io]
 * @returns {Finding[]} */
export function stateDirLints(cfg, { platform = process.platform } = {}) {
  if (platform === "win32" || !fs.existsSync(cfg.stateDir)) return [];
  const mode = fs.statSync(cfg.stateDir).mode & 0o777;
  if (!(mode & 0o077)) return [];
  return [
    {
      level: "warn",
      label: "state dir is private (0700)",
      note: `mode 0${mode.toString(8)} — group/other can read it`,
      fix: { describe: `chmod 0700 ${cfg.stateDir}`, apply: () => void ensurePrivateDir(cfg.stateDir, { tighten: true }) },
    },
  ];
}

/** A pidfile whose pid is not alive: the receiver died without cleaning up. The fix removes
 * it only if it still holds the same content (a receiver booting meanwhile rewrites it).
 * @param {Pick<import('../types.js').Config, 'pidFile'>} cfg @param {{isAlive?: (pid: number) => boolean}} [io]
 * @returns {Finding[]} */
export function pidfileLints(cfg, { isAlive: alive = isAlive } = {}) {
  const rec = readPidFile(cfg.pidFile);
  if (!rec || alive(rec.pid)) return [];
  return [
    {
      level: "warn",
      label: "stale pidfile",
      note: `${cfg.pidFile} names pid ${rec.pid || "?"}, which is not running`,
      fix: {
        describe: `remove ${cfg.pidFile}`,
        apply: () => {
          if (readPidFile(cfg.pidFile)?.text !== rec.text) throw new Error("the pidfile changed — a receiver may be starting; re-run doctor");
          fs.rmSync(cfg.pidFile, { force: true });
        },
      },
    },
  ];
}

/** Connect to a unix socket: `open` (something listens), `dead` (ECONNREFUSED/ENOENT — no
 * listener), `unknown` (any other error or no answer within `timeoutMs`).
 * @param {string} sock @param {number} [timeoutMs] @returns {Promise<'open'|'dead'|'unknown'>} */
export function probeSocket(sock, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const s = net.connect(sock);
    /** @param {'open'|'dead'|'unknown'} r */
    const done = (r) => {
      s.destroy();
      resolve(r);
    };
    s.once("connect", () => done("open"));
    s.once("error", (/** @type {any} */ e) => done(e.code === "ECONNREFUSED" || e.code === "ENOENT" ? "dead" : "unknown"));
    s.setTimeout(timeoutMs, () => done("unknown"));
  });
}

/** A leftover `control.sock` (POSIX only): present, no live pid in the pidfile, AND nothing
 * accepts a connect. A dead pid alone is not proof — a booting receiver listens on the socket
 * before it writes its pidfile. The fix re-probes before removing it.
 * @param {Pick<import('../types.js').Config, 'pidFile'|'controlSock'>} cfg
 * @param {{isAlive?: (pid: number) => boolean, probe?: (sock: string) => Promise<'open'|'dead'|'unknown'>, platform?: string}} [io]
 * @returns {Promise<Finding[]>} */
export async function controlSockLints(cfg, { isAlive: alive = isAlive, probe = probeSocket, platform = process.platform } = {}) {
  if (platform === "win32" || !fs.existsSync(cfg.controlSock)) return [];
  if (alive(readPidFile(cfg.pidFile)?.pid ?? 0)) return [];
  if ((await probe(cfg.controlSock)) !== "dead") return [];
  return [
    {
      level: "warn",
      label: "stale control socket",
      note: `${cfg.controlSock} has no listener`,
      fix: {
        describe: `remove ${cfg.controlSock}`,
        apply: async () => {
          if ((await probe(cfg.controlSock)) !== "dead") throw new Error("something now listens on it — a receiver may be starting");
          fs.rmSync(cfg.controlSock, { force: true });
        },
      },
    },
  ];
}

/** Step/default/repo instruction files that don't exist — a run reads them as "" and goes
 * with no standing instructions, silently. The fix copies the packaged template in, never
 * overwriting (`wx`; EEXIST counts as fixed). The Digest's SOUL file is out of scope.
 * @param {import('../types.js').Config} cfg @returns {Finding[]} */
export function instructionLints(cfg) {
  const template = path.join(cfg.installDir, "INSTRUCTIONS.example.md");
  /** @type {Finding[]} */
  const out = [];
  for (const t of instructionTargets(cfg)) {
    if (t.scope === "soul" || fs.existsSync(t.path)) continue;
    out.push({
      level: "warn", // a warning, not a ✗: configs that ran this way before must not start failing doctor
      label: `instructions file exists: ${t.path}`,
      note: `missing — ${t.scope === "repo" ? "repo" : "step"} ${t.ids.join(", ")} would run with empty standing instructions`,
      fix: {
        describe: `create ${t.path} from INSTRUCTIONS.example.md`,
        apply: () => {
          const text = fs.readFileSync(template);
          fs.mkdirSync(path.dirname(t.path), { recursive: true });
          try {
            fs.writeFileSync(t.path, text, { flag: "wx" });
          } catch (e) {
            if (e.code !== "EEXIST") throw e;
          }
        },
      },
    });
  }
  return out;
}

/** The existing UI-bundle warning (checkout only — an npm install is `no-src`), with
 * `npm run build:ui` in the install dir as its fix.
 * @param {{state: string, newest?: string}} bundle @param {{installDir: string, spawn?: Spawner}} io
 * @returns {Finding[]} */
export function uiBundleLints(bundle, { installDir, spawn = spawnSync }) {
  /** @type {Fix} */
  const fix = {
    describe: `run \`npm run build:ui\` in ${installDir}`,
    apply: () => {
      const r = spawn("npm", ["run", "build:ui"], { cwd: installDir, stdio: "inherit" });
      if (r.status !== 0) throw new Error(`run \`npm run build:ui\` in ${installDir}`);
    },
  };
  if (bundle.state === "missing") return [{ level: "warn", label: "UI bundle built", note: "ui/dist missing — run `npm run build:ui`", fix }];
  if (bundle.state === "stale") return [{ level: "warn", label: "UI bundle up to date", note: `${bundle.newest} is newer than ui/dist — run \`npm run build:ui\``, fix }];
  return [];
}

/** Per git repo: a missing worktree base (fix: create it), and worktrees git reports as
 * prunable under that base (fix: `git worktree prune`, which only drops git's admin entries
 * for already-deleted dirs — branches and commits stay). Repos without `.git` are skipped
 * (doctor already fails them).
 * @param {import('../types.js').Config} cfg
 * @param {{listWorktrees?: (repoPath: string) => { path: string, prunable?: boolean }[], spawn?: Spawner}} [io]
 * @returns {Finding[]} */
export function worktreeLints(cfg, { listWorktrees: list = listWorktrees, spawn = spawnSync } = {}) {
  /** @type {Finding[]} */
  const out = [];
  const seenBase = new Set();
  for (const repo of reposOf(cfg)) {
    if (!fs.existsSync(path.join(repo.path, ".git"))) continue;
    const base = worktreeDir(cfg, repo);
    const who = cfg.multiRepo ? ` for "${repo.id}"` : "";
    if (!seenBase.has(base) && !fs.existsSync(base)) {
      out.push({ level: "warn", label: `worktree base exists${who}: ${base}`, note: "missing", fix: { describe: `mkdir -p ${base}`, apply: () => void fs.mkdirSync(base, { recursive: true }) } });
    }
    seenBase.add(base);
    /** @type {string[]} */
    let prunable;
    try {
      prunable = list(repo.path)
        .filter((w) => w.prunable && w.path.startsWith(base + path.sep))
        .map((w) => w.path);
    } catch {
      continue;
    }
    if (!prunable.length) continue;
    const argv = ["-C", repo.path, "worktree", "prune"];
    out.push({
      level: "warn",
      label: `prunable worktrees${who}`,
      note: `${prunable.join(", ")} — dir gone, git still lists it`,
      fix: {
        describe: `git ${argv.join(" ")}`,
        apply: () => {
          const r = spawn("git", argv, { stdio: "ignore" });
          if (r.status !== 0) throw new Error(`\`git ${argv.join(" ")}\` exited ${r.status}`);
        },
      },
    });
  }
  return out;
}

/** GitHub App auth preflight for one config block (`tracker` or `forge`), in place of the token
 * check: the private key parses, an installation token is fetchable (one live call), and — for
 * the tracker — `assigneeLogin` (the human the App acts for) is set. With `runTokenRepo`
 * ("owner/name", agent run tokens on, #474) it also mints a run token for the `implement`
 * permission set on that repo and revokes it at once (one more call each way).
 * @param {{auth?: import('../types.js').GithubAuthConfig, assigneeLogin?: string}} block
 * @param {'tracker'|'forge'} at @param {{fetch?: typeof fetch, runTokenRepo?: string|null}} [io] @returns {Promise<Check[]>} */
export async function githubAppChecks(block, at, { fetch: f, runTokenRepo } = {}) {
  const auth = /** @type {import('../types.js').GithubAuthConfig} */ (block.auth);
  /** @type {Check[]} */
  const out = [];
  let keyOk = false;
  let keyNote = "";
  try {
    crypto.createPrivateKey(normalizePem(auth.privateKey || ""));
    keyOk = true;
  } catch (e) {
    keyNote = e?.message ?? String(e);
  }
  out.push({ ok: keyOk, label: `${at} GitHub App private key parses (app ${auth.appId})`, note: keyNote, fix: { manual: `set ${at}.auth.privateKey to the App's PEM (a \${VAR} ref; literal \\n is fine) or ${at}.auth.privateKeyPath to the .pem file` } });
  if (keyOk) {
    let tokOk = false;
    let tokNote = "";
    try {
      await createGithubAuth(block, f ? { fetch: f } : {}).header();
      tokOk = true;
    } catch (e) {
      tokNote = e?.message ?? String(e);
    }
    out.push({ ok: tokOk, label: `${at} GitHub App installation token fetchable (installation ${auth.installationId})`, note: tokNote, fix: { manual: `check ${at}.auth.appId / installationId and that the App is installed on the repo/org (see docs/github-app.md)` } });
    if (tokOk && runTokenRepo) {
      const permissions = runTokenPermissions("implement");
      const writes = Object.keys(permissions).filter((k) => permissions[k] === "write");
      let runOk = false;
      let runNote = "";
      try {
        const { token } = await mintInstallationToken(auth, { repositories: [runTokenRepo.split("/")[1]], permissions }, f ? { fetch: f } : {});
        runOk = true;
        await revokeRunToken(token, f ? { fetch: f } : {});
      } catch (e) {
        runNote = e?.message ?? String(e);
      }
      out.push({ ok: runOk, label: `${at} GitHub App can mint agent run tokens (${writes.map((k) => `${k}:write`).join(", ")})`, note: runNote || runTokenRepo, fix: { manual: "grant the App Contents: Read & write and Pull requests: Read & write (docs/github-app.md#agent-run-tokens)" } });
    }
  }
  if (at === "tracker") {
    const login = typeof block.assigneeLogin === "string" ? block.assigneeLogin.trim() : "";
    out.push({ ok: !!login, label: `tracker.assigneeLogin set (the human the App acts for)`, note: login || "missing", fix: { manual: "set tracker.assigneeLogin to your GitHub login" } });
  }
  return out;
}

/** "owner/name" a GitHub config block names (`repository`, or `owner` + `repo`), else null.
 * @param {{repository?: string, owner?: string, repo?: string}|undefined} block */
const blockRepo = (block) => (block?.repository ? String(block.repository) : block?.owner && block?.repo ? `${block.owner}/${block.repo}` : null);

/** Per-run GitHub App tokens (#474), from config alone (plus each repo's `origin`): an ℹ when
 * GitHub agents use a personal token (no App), a ⚠ when App auth is on but `githubRunToken` is
 * false, when a step `env` overrides the run token with GH_TOKEN/GITHUB_TOKEN, or when a repo's
 * `origin` isn't github.com under a GitHub tracker (its run tokens cover issues only).
 * @param {Pick<import('../types.js').Config, 'provider'|'providerConfig'|'forge'|'pipeline'|'githubRunToken'|'repos'|'repoPath'>} cfg
 * @param {{originRepo?: (repoPath: string) => string|null}} [io]
 * @returns {{ level: 'info'|'warn', label: string, note?: string }[]} */
export function runTokenLints(cfg, { originRepo = (p) => parseGithubRemote(originUrl(p)) } = {}) {
  const githubTracker = cfg.provider === "github" || cfg.provider === "github-projects";
  const githubForge = cfg.forge?.type === "github";
  if (!githubTracker && !githubForge) return [];
  const forgeApp = githubForge && isAppAuth(cfg.forge);
  if (!(githubTracker && isAppAuth(cfg.providerConfig)) && !forgeApp) {
    return [{ level: "info", label: "agents use your personal GitHub token (no GitHub App)", note: "an App gives each run a 1h token scoped to one repo: docs/github-app.md#agent-run-tokens" }];
  }
  if (cfg.githubRunToken === false) return [{ level: "warn", label: "agents use your own GitHub credentials, not a scoped run token", note: "githubRunToken is false under GitHub App auth" }];
  /** @type {{ level: 'info'|'warn', label: string, note?: string }[]} */
  const out = [];
  for (const s of cfg.pipeline ?? []) {
    for (const name of ["GH_TOKEN", "GITHUB_TOKEN"]) if (s.env?.[name]) out.push({ level: "warn", label: `step "${s.id}" env ${name} overrides the per-run App token` });
  }
  // A github App forge falls back to its own repository, so only a tracker-only App is issues-only.
  if (githubTracker && !forgeApp) {
    for (const repo of reposOf(/** @type {import('../types.js').Config} */ (cfg))) {
      if (!originRepo(repo.path)) out.push({ level: "warn", label: `run tokens for "${repo.id}" cover issues only; pushes use your own git credentials`, note: "its origin is not a github.com remote" });
    }
  }
  return out;
}

/** Whether agents get per-run GitHub App tokens (#474): a GitHub tracker or forge on App auth, and
 * `githubRunToken` not false — the same condition runTokenLints uses. Pure.
 * @param {Pick<import('../types.js').Config, 'provider'|'providerConfig'|'forge'|'githubRunToken'>} cfg */
const usesRunTokens = (cfg) =>
  cfg.githubRunToken !== false && (((cfg.provider === "github" || cfg.provider === "github-projects") && isAppAuth(cfg.providerConfig)) || (cfg.forge?.type === "github" && isAppAuth(cfg.forge)));

/** The git `url.<base>.insteadof` rules that rewrite https://github.com/ to SSH ("force SSH"):
 * a run token's HTTPS push then goes out over SSH with the operator's key. `text` is the stdout of
 * `git config --global --get-regexp '^url\..*\.insteadof$'` (`url.<base>.insteadof <value>` per
 * line, key case-insensitive). Returns the matched keys. Pure.
 * @param {string} text @returns {string[]} */
export function parseForceSshRewrites(text) {
  /** @type {string[]} */
  const out = [];
  for (const line of String(text ?? "").split("\n")) {
    const m = /^url\.(.+)\.insteadof\s+(\S+)$/i.exec(line.trim());
    if (!m) continue;
    const [, base, value] = m;
    const v = value.toLowerCase();
    if (!(v === "https://github.com" || v.startsWith("https://github.com/"))) continue;
    if (base.toLowerCase().startsWith("git@github.com:") || base.toLowerCase().startsWith("ssh://")) out.push(`url.${base}.insteadof`);
  }
  return out;
}

/** The fullAuto:false migration line (CHANGELOG, doctor). */
const PINNED_MIGRATION = 'to let a non-fullAuto step edit files, allow it explicitly: "permissions": {"allow": ["Edit", "Bash(npm test)"]} in the repo\'s .claude/settings.json, or a step allow policy (docs/configuration.md)';

/** A `permissions.allow` rule that grants a whole tool: a bare tool name, or `<Tool>(*)` / `(**)` / `(//**)`. */
const BROAD_RULE = /^(Bash|Edit|Write|MultiEdit|NotebookEdit)(\((\*|\*\*|\/\/\*\*)\))?$/;

/** How many rules claudePolicyArgs emits for a policy (flags and the mode value left out). @param {string[]} args */
const ruleCount = (args) => args.filter((a) => !a.startsWith("--") && a !== "dontAsk").length;

/**
 * The isolation report (#476): one view of what a run can reach — sandbox, env, egress,
 * credentials, each step's permission mode, prompt fencing. Rows are ℹ or ⚠, never ✗ (fullAuto
 * without a sandbox is warn-only). Pure given `userClaudeSettings` (parsed ~/.claude/settings.json,
 * or null) and `gitInsteadOf` (the global `url.*.insteadof` rules, or "").
 * @param {import('../types.js').Config} cfg
 * @param {{userClaudeSettings?: any, gitInsteadOf?: string, user?: string}} [io]
 * @returns {{ level: 'info'|'warn', label: string, note: string }[]} */
export function isolationReport(cfg, { userClaudeSettings = null, gitInsteadOf = "", user = os.userInfo().username } = {}) {
  /** @type {{ level: 'info'|'warn', label: string, note: string }[]} */
  const out = [];
  /** @param {'info'|'warn'} level @param {string} what @param {string} note */
  const row = (level, what, note) => out.push({ level, label: `isolation · ${what}`, note });
  const steps = (cfg.pipeline ?? []).filter((s) => !s.manual);
  const onHost = steps.filter((s) => !isSandboxed(cfg, s)).map((s) => s.id);

  row("info", "sandbox", cfg.sandbox ? `${cfg.sandbox.type}, image ${cfg.sandbox.image ?? DEFAULT_IMAGE}` : "none (agents run on this host)");
  if (cfg.fullAuto && !cfg.sandbox) row("warn", "sandbox", `fullAuto without a sandbox — a verified webhook runs code on this host as ${user}; see docs/sandbox.md`);
  if (cfg.fullAuto && cfg.sandbox) for (const id of onHost) row("warn", "sandbox", `step "${id}" runs on the host under fullAuto`);

  const passthrough = cfg.agentEnvPassthrough ?? [];
  if (passthrough.includes("*")) row(cfg.fullAuto ? "warn" : "info", "env", `not stripped — agents inherit the receiver's full env ("*")`);
  else row("info", "env", `stripped; passes through ${passthrough.length ? passthrough.join(", ") : "nothing extra"}`);

  if (!cfg.sandbox) row("info", "egress", "n/a (no sandbox — the host's network)");
  else {
    const mode = cfg.sandbox.egress?.mode ?? "allowlist";
    const overrides = steps.filter((s) => isSandboxed(cfg, s) && s.egress?.mode).map((s) => `${s.id}=${s.egress?.mode}`);
    row("info", "egress", `${mode === "allowlist" ? `allowlist (defaults + ${cfg.sandbox.egress?.allow?.length ?? 0} extra)` : mode}${overrides.length ? `; step overrides: ${overrides.join(", ")}` : ""}`);
  }

  const runTokens = usesRunTokens(cfg);
  const envPassthrough = cfg.agentEnvPassthrough ?? [];
  const ghTokenPassthrough = envNameMatches("GH_TOKEN", envPassthrough) || envNameMatches("GITHUB_TOKEN", envPassthrough);
  const ghTokenStepEnv = steps.some((s) => s.env && ("GH_TOKEN" in s.env || "GITHUB_TOKEN" in s.env));
  const noCredentials =
    !runTokens &&
    !(TRACKER_AGENT_ENV[cfg.provider] ?? []).length &&
    !cfg.forge &&
    !ghTokenPassthrough &&
    !ghTokenStepEnv;
  if (runTokens && !onHost.length) row("info", "credentials", "per-run GitHub App token (1h, repo-scoped)");
  else if (runTokens) row("warn", "credentials", `step(s) ${onHost.join(", ")}: scoped run token given, but the host gh login and ~/.ssh stay readable`);
  else if (noCredentials) row("info", "credentials", `none (${cfg.provider} tracker, no forge)`);
  else row(cfg.fullAuto ? "warn" : "info", "credentials", "your own token (tracker/forge token or gh login) — usable until you revoke it");
  const forceSsh = runTokens && onHost.length ? parseForceSshRewrites(gitInsteadOf) : [];
  if (forceSsh.length) row("warn", "credentials", `host git config rewrites https://github.com/ to SSH (${forceSsh.join(", ")}) — run pushes use your SSH key; remove the rule or enable the sandbox`);

  let claudeSteps = 0;
  let pinned = 0;
  for (const s of steps) {
    const name = agentFor(cfg, s).describe().name;
    const deny = s.deny ? `, deny policy (${ruleCount(claudePolicyArgs({ deny: s.deny, cwd: "/<cwd>" }))} rules)` : "";
    let mode;
    if (name !== "claude") mode = cfg.fullAuto ? "skip-permissions (fullAuto)" : "agent CLI default";
    else {
      claudeSteps++;
      if (cfg.fullAuto && !s.allow) mode = `skip-permissions (fullAuto)${deny}`;
      else {
        pinned++;
        mode = s.allow ? `allow policy (dontAsk, ${ruleCount(claudePolicyArgs({ allow: s.allow, cwd: "/<cwd>" }))} rules)${deny}` : `dontAsk (pinned; repo/user allow rules apply)${deny}`;
      }
    }
    row("info", "permissions", `step "${s.id}" (${name}): ${mode}`);
  }
  const defaultMode = userClaudeSettings?.permissions?.defaultMode;
  if (claudeSteps && typeof defaultMode === "string" && defaultMode) {
    const ignored = `~/.claude/settings.json defaultMode "${defaultMode}" is ignored — agenthook pins the mode`;
    if (defaultMode === "acceptEdits") row("warn", "permissions", `${ignored}; ${PINNED_MIGRATION}`);
    else row("info", "permissions", ignored);
  }
  const userAllow = userClaudeSettings?.permissions?.allow;
  if (pinned && Array.isArray(userAllow)) {
    for (const r of userAllow) {
      if (typeof r === "string" && BROAD_RULE.test(r.trim())) row("warn", "permissions", `~/.claude/settings.json allows "${r}" — it widens every pinned claude step (allow policies included)`);
    }
  }

  row("info", "untrusted input", "ticket/comment text is fenced as data (SECURITY.md#prompt-injection) — a mitigation, not a boundary");
  return out;
}

/** The env var the raw config's `tracker.token` references (`${VAR}`), for the remedy text.
 * @param {string} configPath @returns {string|null} */
export function tokenVar(configPath) {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
    return /\$\{(\w+)\}/.exec(String(raw?.tracker?.token ?? raw?.token ?? ""))?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Doctor's side-effecting probes, overridable for tests.
 * @typedef {{
 *   onPath?: (bin: string) => boolean,
 *   portInUse?: (port: number) => Promise<boolean>,
 *   isAlive?: (pid: number) => boolean,
 *   probe?: (sock: string) => Promise<'open'|'dead'|'unknown'>,
 *   spawn?: Spawner,
 *   listWorktrees?: (repoPath: string) => { path: string, branch: string, prunable?: boolean }[],
 *   uiBundle?: () => {state: 'no-src'|'missing'|'stale'|'fresh', newest?: string},
 *   platform?: string,
 *   fetch?: typeof fetch,
 *   run?: import('../types.js').IngressRun,
 *   build?: (bin: string, args: string[], dockerfile: string) => { status: number|null },
 *   env?: Record<string, string|undefined>,
 *   userClaudeSettings?: any,
 * }} DoctorIo */

/** Parsed ~/.claude/settings.json, or null (missing/unreadable). Read only, never written. */
function readUserClaudeSettings() {
  try {
    return JSON.parse(fs.readFileSync(path.join(os.homedir(), ".claude", "settings.json"), "utf8"));
  } catch {
    return null;
  }
}

/** The global git `url.*.insteadof` rules (`git config --get-regexp` stdout), "" on any failure. @param {Spawner} spawn */
function readGitInsteadOf(spawn) {
  try {
    const r = spawn("git", ["config", "--global", "--get-regexp", "^url\\..*\\.insteadof$"], { stdio: ["ignore", "pipe", "ignore"], encoding: "utf8", timeout: 5000 });
    return r.status === 0 && typeof r.stdout === "string" ? r.stdout : "";
  } catch {
    return "";
  }
}

/** Run every check against a loaded config; prints nothing.
 * @param {import('../types.js').Config} cfg @param {DoctorIo} [io] @returns {Promise<Check[]>} */
export async function runChecks(cfg, io = {}) {
  const {
    onPath: have = onPath,
    portInUse: busyPort = portInUse,
    isAlive: alive = isAlive,
    probe = probeSocket,
    spawn = spawnSync,
    listWorktrees: list = listWorktrees,
    uiBundle = () => uiBundleState({ srcDir: UI_SRC_DIR, distDir: UI_DIST_DIR }),
    platform = process.platform,
    fetch: f,
    run = execRun,
    build,
    env = process.env,
    userClaudeSettings = readUserClaudeSettings(),
  } = io;
  /** @type {Check[]} */
  const checks = [];
  /** @param {boolean} ok @param {string} label @param {string} [note] @param {Fix} [fix] */
  const add = (ok, label, note, fix) => checks.push({ ok, label, note, fix });
  /** A ⚠ line: shown, but not counted as a problem. @param {string} label @param {string} [note] @param {Fix} [fix] */
  const warn = (label, note, fix) => checks.push({ ok: true, warn: true, label, note, fix });
  /** An ℹ line: informational only, never carries a fix. @param {string} label @param {string} [note] */
  const info = (label, note) => checks.push({ ok: true, info: true, label, note });
  /** @param {Finding} f */
  const finding = (f) => (f.level === "fail" ? add(false, f.label, f.note, f.fix) : f.level === "info" ? info(f.label, f.note) : warn(f.label, f.note, f.fix));

  add(true, `config loaded: ${cfg.configPath}`);
  if (fs.existsSync(cfg.stateDir)) add(true, `profile "${cfg.name}" — state ${cfg.stateDir}`);
  else info(`profile "${cfg.name}" — state dir not created yet (profile never started)`, cfg.stateDir);
  stateDirLints(cfg, { platform }).forEach(finding);
  pidfileLints(cfg, { isAlive: alive }).forEach(finding);
  (await controlSockLints(cfg, { isAlive: alive, probe, platform })).forEach(finding);

  const profile = readProfile(cfg.stateKey);

  if (cfg.provider === "local") info("local tracker — no token needed");
  else if (isAppAuth(cfg.providerConfig)) {
    const runTokenRepo = cfg.githubRunToken !== false ? (blockRepo(cfg.providerConfig) ?? parseGithubRemote(originUrl(primaryRepo(cfg).path))) : null;
    checks.push(...(await githubAppChecks(cfg.providerConfig, "tracker", { fetch: f, runTokenRepo })));
  }
  else {
    const v = tokenVar(cfg.configPath);
    add(!!cfg.providerConfig.token, `tracker token resolved (${cfg.provider})`, cfg.providerConfig.token ? "" : "empty — check the ${ENV} ref", { manual: v ? `set ${v} in .env (or the env), then re-run doctor` : "set tracker.token to a ${VAR} ref, set that VAR in .env (or the env), then re-run doctor" });
  }

  for (const repo of reposOf(cfg)) {
    const isGit = fs.existsSync(path.join(repo.path, ".git"));
    const label = cfg.multiRepo ? `repo "${repo.id}" is a git repo: ${repo.path}` : `repoPath is a git repo: ${repo.path}`;
    add(isGit, label, isGit ? "" : "no .git found", { manual: `point ${cfg.multiRepo ? `repo "${repo.id}"'s path` : "repoPath"} at a git checkout (or \`git init\` it)` });
  }
  for (const l of repoLints(cfg)) {
    if (l.level === "fail") add(false, l.label, l.note, { manual: "set tracker.routeField in the config to the field that names each ticket's repo" });
    else warn(l.label, l.note);
  }
  if (cfg.multiRepo) {
    for (const repo of reposOf(cfg)) {
      /** @type {string[]} */
      let paths;
      try {
        paths = list(repo.path).map((w) => w.path);
      } catch {
        continue; // not a git repo — already flagged above
      }
      const orphans = legacyOrphans(cfg, repo, paths);
      if (orphans.length) warn(`legacy worktrees in "${repo.id}"`, `${orphans.join(", ")} — pre-repos layout; finish or drain them, then \`agenthook cleanup\``);
    }
  }
  instructionLints(cfg).forEach(finding);

  const binChecks = agentBinChecks(cfg);
  for (const { bin, agent, steps } of binChecks) add(have(bin), `${agent} binary on PATH: ${bin} (steps: ${steps.join(", ")})`, undefined, { manual: `install ${bin} or put it on PATH` });
  // No step spawns claudeBin, but the on-demand Digest still does — missing it is a warning only.
  if (!binChecks.some((c) => c.bin === cfg.claudeBin) && !have(cfg.claudeBin)) {
    warn(`claude binary on PATH: ${cfg.claudeBin}`, "not found — no step uses it, but the Digest does");
  }
  for (const l of agentLints(cfg)) warn(l.label, l.note);
  policyLints(cfg).forEach(finding);
  for (const l of agentEnvLints(cfg, { env, platform })) l.level === "info" ? info(l.label, l.note) : warn(l.label, l.note, l.fix);
  ghAuthLints(cfg, { spawn, onPath: have, env, platform }).forEach(finding);
  const readFile = (/** @type {string} */ f) => {
    try {
      return fs.readFileSync(f, "utf8");
    } catch {
      return null;
    }
  };
  for (const l of hermesLints(cfg, { sourceHome: hermesSourceHome(), readFile })) warn(l.label, l.note);

  for (const c of ingressChecks(cfg.ingress, have)) add(c.ok, c.label, c.note, { manual: c.manual });
  checks.push(...(await sandboxChecks(cfg, { run, has: have, build })));
  const rootFiles = (/** @type {string} */ dir) => {
    try {
      return fs.readdirSync(dir);
    } catch {
      return [];
    }
  };
  const files = [...new Set(reposOf(cfg).flatMap((r) => rootFiles(r.path)))];
  const origins = cfg.sandbox && !cfg.forge ? reposOf(cfg).flatMap((r) => hostGitFacts(r.path).originUrl ?? []) : [];
  for (const l of egressLints(cfg, { files, env, origins })) l.level === "info" ? info(l.label, l.note) : warn(l.label, l.note);

  const busy = await busyPort(cfg.port);
  const pc = portCheck({ port: cfg.port, busy, profile: { up: profile.up, pid: profile.pid, heartbeatPort: profile.heartbeat?.port } });
  if (pc.level === "info") info(pc.label, pc.note);
  else add(pc.level === "ok", pc.label, pc.note, { manual: `stop whatever listens on port ${cfg.port}, or set a different "port" in the config` });

  const unfilled = unfilledBindings(cfg.pipeline);
  add(!unfilled.length, "pipeline bindings filled", unfilled.length ? `unfilled/placeholder: ${unfilled.join(", ")}` : "", { manual: `fill ${unfilled.join(", ")} in the config with real tracker stages` });

  for (const l of forgeLints(cfg)) warn(l.label, l.note);
  if (cfg.forge?.type === "github" && isAppAuth(cfg.forge)) checks.push(...(await githubAppChecks(cfg.forge, "forge", { fetch: f, runTokenRepo: cfg.githubRunToken !== false ? blockRepo(cfg.forge) : null })));
  for (const l of runTokenLints(cfg)) l.level === "info" ? info(l.label, l.note) : warn(l.label, l.note);
  // The global force-SSH rules only matter when a run token is used on the host: read them then.
  const gitInsteadOf = usesRunTokens(cfg) && (cfg.pipeline ?? []).some((s) => !s.manual && !isSandboxed(cfg, s)) ? readGitInsteadOf(spawn) : "";
  isolationReport(cfg, { userClaudeSettings, gitInsteadOf }).forEach(finding);

  uiBundleLints(uiBundle(), { installDir: cfg.installDir, spawn }).forEach(finding);
  worktreeLints(cfg, { listWorktrees: list, spawn }).forEach(finding);

  if (platform === "linux") {
    const scopeOn = systemdScopeAvailable();
    info(`start --detach will use a systemd user scope: ${scopeOn}`, process.env.AGENTHOOK_NO_SYSTEMD_SCOPE === "1" ? "AGENTHOOK_NO_SYSTEMD_SCOPE=1 disables it" : "");
    if (profile.up) {
      try {
        const { scope, terminal } = classifyCgroup(fs.readFileSync(`/proc/${profile.pid}/cgroup`, "utf8"));
        if (scope) {
          info(`scope: ${scope}`);
          if (terminal) warn("receiver scope", "will die with this terminal — restart it with `agenthook restart` or `start --detach` (now scope-escaping)");
        }
      } catch {
        /* /proc unreadable — not fatal */
      }
    }
  }
  return checks;
}

/** A ✗ or ⚠ check (ℹ and ✓ lines are never problems). @param {Check} c */
const isProblem = (c) => !c.info && (!c.ok || !!c.warn);
/** @param {Fix|undefined} fix @returns {fix is { describe: string, apply: () => void|Promise<void> }} */
const autoFix = (fix) => !!fix && "apply" in fix;

/** How many ✗/⚠ checks `--fix` can repair. @param {Check[]} checks */
export const fixableCount = (checks) => checks.filter((c) => isProblem(c) && autoFix(c.fix)).length;

/** Apply (or under `dryRun`, plan) every problem's fix in check order, one line each:
 * `fixed:`, `would fix:`, or `can't fix:` (manual-only, or `apply` threw — never aborts the rest).
 * @param {Check[]} checks @param {{dryRun?: boolean, log?: (line: string) => void}} [opts]
 * @returns {Promise<string[]>} the printed lines */
export async function applyFixes(checks, { dryRun = false, log = console.log } = {}) {
  /** @type {string[]} */
  const lines = [];
  /** @param {string} l */
  const say = (l) => (lines.push(l), log(l));
  for (const c of checks) {
    if (!isProblem(c) || !c.fix) continue;
    const fix = c.fix;
    if (!autoFix(fix)) say(`can't fix: ${c.label} — ${"manual" in fix ? fix.manual : ""}`);
    else if (dryRun) say(`would fix: ${c.label} — ${fix.describe}`);
    else {
      try {
        await fix.apply();
        say(`fixed: ${c.label}`);
      } catch (e) {
        say(`can't fix: ${c.label} — ${e?.message ?? e}`);
      }
    }
  }
  return lines;
}

/** Print the ✓/✗/⚠/ℹ report and summary; returns the ✗ count.
 * @param {Check[]} checks @param {{hint?: boolean, log?: (line: string) => void}} [opts] */
export function report(checks, { hint = true, log = console.log } = {}) {
  let bad = 0;
  let warned = 0;
  for (const c of checks) {
    log(`${c.info ? "ℹ" : c.warn ? "⚠" : c.ok ? "✓" : "✗"} ${c.label}${c.note ? `  — ${c.note}` : ""}`);
    if (!c.ok) bad++;
    if (c.warn) warned++;
  }
  log(bad ? `\n${bad} problem(s) found.` : warned ? `\nno problems; ${warned} warning(s).` : `\nall good.`);
  const n = fixableCount(checks);
  if (hint && n) log(`${n} can be fixed with \`agenthook doctor --fix\``);
  return bad;
}

/** @param {any} args */
export async function doctor(args) {
  const cfg = loadConfig({ configPath: args.config }); // throws (and surfaces unset ${VARs}) if broken
  if (args.fix) {
    await applyFixes(await runChecks(cfg), { dryRun: !!args["dry-run"] });
    if (args["dry-run"]) return;
    console.log("");
  }
  if (report(await runChecks(cfg), { hint: !args.fix })) process.exitCode = 1;
}
