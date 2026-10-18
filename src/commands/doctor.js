// `agenthook doctor` — preflight a profile before you trust it. Loads the config,
// then checks the things that silently break a run: missing token, repoPath not a
// git repo, agent/tunnel binaries absent, port already taken, ingress misconfigured.
// Multi-repo profiles also get routing lints; ⚠ warnings print but don't fail the run.
// (Duplicate repo ids / paths / route keys and >1 default are already fatal in loadConfig.)
import fs from "node:fs";
import { portInUse } from "../port.js";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { loadConfig } from "../config.js";
import { worktreeDir } from "../paths.js";
import { reposOf, defaultRepo } from "../repos.js";
import { listWorktrees } from "../worktree.js";
import { readProfile } from "../heartbeat.js";
import { systemdScopeAvailable, classifyCgroup } from "../respawn.js";
import { fileURLToPath } from "node:url";
import { agentFor } from "../agents/index.js";
import { hermesSourceHome, hermesProviderInfo } from "../agents/hermes-home.js";
import { uiBundleState } from "../ui-bundle.js";

const UI_SRC_DIR = fileURLToPath(new URL("../../ui/src/", import.meta.url));
const UI_DIST_DIR = fileURLToPath(new URL("../../ui/dist/", import.meta.url));

/** @param {string} bin */
function onPath(bin) {
  const r = spawnSync(process.platform === "win32" ? "where" : "which", [bin], { encoding: "utf8" });
  return r.status === 0;
}

/** The distinct agent binaries the pipeline spawns, resolved exactly like dispatch
 * (`step.bin || agent.defaults.bin || cfg.claudeBin`) for every non-manual step, each with
 * its agent and the step ids that use it — doctor checks each is on PATH. Pure.
 * @param {Pick<import('../types.js').Config, 'claudeBin'|'agent'|'pipeline'>} cfg
 * @returns {{ bin: string, agent: string, steps: string[] }[]} */
export function agentBinChecks(cfg) {
  /** @type {Map<string, { bin: string, agent: string, steps: string[] }>} */
  const byKey = new Map();
  for (const s of cfg.pipeline ?? []) {
    if (s.manual) continue;
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
 * neither of tunnel/hostname); a static ingress needs ingress.url.
 * @param {import('../types.js').IngressConfig} ingress @param {(bin: string) => boolean} [has]
 * @returns {{ ok: boolean, label: string, note?: string }[]} */
export function ingressChecks(ingress, has = onPath) {
  if (ingress.type === "ngrok") return [{ ok: has(process.env.NGROK || "ngrok"), label: "ngrok binary on PATH" }];
  if (ingress.type === "cloudflared") {
    /** @type {{ ok: boolean, label: string, note?: string }[]} */
    const checks = [{ ok: has(process.env.CLOUDFLARED || "cloudflared"), label: "cloudflared binary on PATH" }];
    if (ingress.tunnel || ingress.hostname) {
      const ok = !!ingress.tunnel && !!ingress.hostname;
      checks.push({ ok, label: "cloudflared named tunnel: tunnel + hostname both set", note: ok ? "" : `missing ingress.${ingress.tunnel ? "hostname" : "tunnel"}` });
    }
    return checks;
  }
  return [{ ok: !!ingress.url, label: `ingress.url set (${ingress.type})`, note: ingress.url || "missing" }];
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

/** @param {any} args */
export async function doctor(args) {
  /** @type {{ok:boolean, warn?:boolean, info?:boolean, label:string, note?:string}[]} */
  const checks = [];
  /** @param {boolean} ok @param {string} label @param {string} [note] */
  const add = (ok, label, note) => checks.push({ ok, label, note });
  /** A ⚠ line: shown, but not counted as a problem. @param {string} label @param {string} [note] */
  const warn = (label, note) => checks.push({ ok: true, warn: true, label, note });
  /** An ℹ line: informational only. @param {string} label @param {string} [note] */
  const info = (label, note) => checks.push({ ok: true, info: true, label, note });

  const cfg = loadConfig({ configPath: args.config }); // throws (and surfaces unset ${VARs}) if broken
  add(true, `config loaded: ${cfg.configPath}`);
  if (fs.existsSync(cfg.stateDir)) add(true, `profile "${cfg.name}" — state ${cfg.stateDir}`);
  else info(`profile "${cfg.name}" — state dir not created yet (profile never started)`, cfg.stateDir);

  const profile = readProfile(cfg.stateKey);

  if (cfg.provider === "local") info("local tracker — no token needed");
  else add(!!cfg.providerConfig.token, `tracker token resolved (${cfg.provider})`, cfg.providerConfig.token ? "" : "empty — check the ${ENV} ref");

  for (const repo of reposOf(cfg)) {
    const isGit = fs.existsSync(path.join(repo.path, ".git"));
    const label = cfg.multiRepo ? `repo "${repo.id}" is a git repo: ${repo.path}` : `repoPath is a git repo: ${repo.path}`;
    add(isGit, label, isGit ? "" : "no .git found");
  }
  for (const l of repoLints(cfg)) {
    if (l.level === "fail") add(false, l.label, l.note);
    else warn(l.label, l.note);
  }
  if (cfg.multiRepo) {
    for (const repo of reposOf(cfg)) {
      /** @type {string[]} */
      let paths;
      try {
        paths = listWorktrees(repo.path).map((w) => w.path);
      } catch {
        continue; // not a git repo — already flagged above
      }
      const orphans = legacyOrphans(cfg, repo, paths);
      if (orphans.length) warn(`legacy worktrees in "${repo.id}"`, `${orphans.join(", ")} — pre-repos layout; finish or drain them, then \`agenthook cleanup\``);
    }
  }

  const binChecks = agentBinChecks(cfg);
  for (const { bin, agent, steps } of binChecks) add(onPath(bin), `${agent} binary on PATH: ${bin} (steps: ${steps.join(", ")})`);
  // No step spawns claudeBin, but the on-demand Digest still does — missing it is a warning only.
  if (!binChecks.some((c) => c.bin === cfg.claudeBin) && !onPath(cfg.claudeBin)) {
    warn(`claude binary on PATH: ${cfg.claudeBin}`, "not found — no step uses it, but the Digest does");
  }
  for (const l of agentLints(cfg)) warn(l.label, l.note);
  const readFile = (/** @type {string} */ f) => {
    try {
      return fs.readFileSync(f, "utf8");
    } catch {
      return null;
    }
  };
  for (const l of hermesLints(cfg, { sourceHome: hermesSourceHome(), readFile })) warn(l.label, l.note);

  for (const c of ingressChecks(cfg.ingress)) add(c.ok, c.label, c.note);

  const busy = await portInUse(cfg.port);
  const pc = portCheck({ port: cfg.port, busy, profile: { up: profile.up, pid: profile.pid, heartbeatPort: profile.heartbeat?.port } });
  if (pc.level === "info") info(pc.label, pc.note);
  else add(pc.level === "ok", pc.label, pc.note);

  const unfilled = unfilledBindings(cfg.pipeline);
  add(!unfilled.length, "pipeline bindings filled", unfilled.length ? `unfilled/placeholder: ${unfilled.join(", ")}` : "");

  for (const l of forgeLints(cfg)) warn(l.label, l.note);

  const bundle = uiBundleState({ srcDir: UI_SRC_DIR, distDir: UI_DIST_DIR });
  if (bundle.state === "missing") warn("UI bundle built", "ui/dist missing — run `npm run build:ui`");
  else if (bundle.state === "stale") warn("UI bundle up to date", `${bundle.newest} is newer than ui/dist — run \`npm run build:ui\``);

  if (process.platform === "linux") {
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

  let bad = 0;
  let warned = 0;
  for (const c of checks) {
    console.log(`${c.info ? "ℹ" : c.warn ? "⚠" : c.ok ? "✓" : "✗"} ${c.label}${c.note ? `  — ${c.note}` : ""}`);
    if (!c.ok) bad++;
    if (c.warn) warned++;
  }
  console.log(bad ? `\n${bad} problem(s) found.` : warned ? `\nno problems; ${warned} warning(s).` : `\nall good.`);
  if (bad) process.exitCode = 1;
}
