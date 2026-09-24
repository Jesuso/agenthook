// `agenthook doctor` — preflight a profile before you trust it. Loads the config,
// then checks the things that silently break a run: missing token, repoPath not a
// git repo, claude/ngrok binaries absent, port already taken, ingress misconfigured.
// Multi-repo profiles also get routing lints; ⚠ warnings print but don't fail the run.
// (Duplicate repo ids / paths / route keys and >1 default are already fatal in loadConfig.)
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { loadConfig } from "../config.js";
import { worktreeDir } from "../paths.js";
import { reposOf, defaultRepo } from "../repos.js";
import { listWorktrees } from "../worktree.js";

/** Is a TCP port already bound on 127.0.0.1? @param {number} port */
function portInUse(port) {
  return new Promise((resolve) => {
    const s = net.createConnection({ port, host: "127.0.0.1" });
    s.on("connect", () => {
      s.destroy();
      resolve(true);
    });
    s.on("error", () => resolve(false));
  });
}

/** @param {string} bin */
function onPath(bin) {
  const r = spawnSync(process.platform === "win32" ? "where" : "which", [bin], { encoding: "utf8" });
  return r.status === 0;
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

/** @param {any} args */
export async function doctor(args) {
  /** @type {{ok:boolean, warn?:boolean, label:string, note?:string}[]} */
  const checks = [];
  /** @param {boolean} ok @param {string} label @param {string} [note] */
  const add = (ok, label, note) => checks.push({ ok, label, note });
  /** A ⚠ line: shown, but not counted as a problem. @param {string} label @param {string} [note] */
  const warn = (label, note) => checks.push({ ok: true, warn: true, label, note });

  const cfg = loadConfig({ configPath: args.config }); // throws (and surfaces unset ${VARs}) if broken
  add(true, `config loaded: ${cfg.configPath}`);
  add(true, `profile "${cfg.name}" — state ${cfg.stateDir}`);

  add(!!cfg.providerConfig.token, `tracker token resolved (${cfg.provider})`, cfg.providerConfig.token ? "" : "empty — check the ${ENV} ref");

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

  add(onPath(cfg.claudeBin), `claude binary on PATH: ${cfg.claudeBin}`);

  if (cfg.ingress.type === "ngrok") {
    add(onPath(process.env.NGROK || "ngrok"), "ngrok binary on PATH");
  } else {
    add(!!cfg.ingress.url, `ingress.url set (${cfg.ingress.type})`, cfg.ingress.url || "missing");
  }

  const busy = await portInUse(cfg.port);
  add(!busy, `port ${cfg.port} is free`, busy ? "something is already listening" : "");

  const unfilled = unfilledBindings(cfg.pipeline);
  add(!unfilled.length, "pipeline bindings filled", unfilled.length ? `unfilled/placeholder: ${unfilled.join(", ")}` : "");

  let bad = 0;
  let warned = 0;
  for (const c of checks) {
    console.log(`${c.warn ? "⚠" : c.ok ? "✓" : "✗"} ${c.label}${c.note ? `  — ${c.note}` : ""}`);
    if (!c.ok) bad++;
    if (c.warn) warned++;
  }
  console.log(bad ? `\n${bad} problem(s) found.` : warned ? `\nno problems; ${warned} warning(s).` : `\nall good.`);
  if (bad) process.exitCode = 1;
}
