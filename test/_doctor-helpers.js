// Shared fixtures for the doctor-*.test.js files (split from the former doctor.test.js so
// no single test file costs ~28K tokens to read — see #717). Not matched by the
// `test/*.test.js` glob `npm test` runs, so it is never itself executed as a test file.
// APP_PEM/appAuth/tokenFetch/runTokenFetch (the RSA keygen) stay local to
// doctor-auth-sandbox.test.js on purpose — they shouldn't run on every importer.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { worktreeDir } from "../src/paths.js";
import { loadConfig } from "../src/config/index.js";

export const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ah-doctor-"));

export const POSIX = process.platform !== "win32";
export const DEAD_PID = 2 ** 30; // above any pid_max: process.kill(…, 0) → ESRCH
/** @param {string} cwd @param {string[]} a */
export const git = (cwd, a) => execFileSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...a], { encoding: "utf8" });
let seq = 0;

/** A clean, loaded local profile: tmp root holding a git repo (`root/repo`, one commit), the
 * config + instruction files beside it (one under `prompts/`), a 0700 state dir and the default
 * worktree base (`root/repo-worktrees`). Each test then breaks exactly what it fixes.
 * @param {Record<string, any>} [over] extra top-level config keys */
export function cleanProfile(over = {}) {
  const root = tmp();
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  git(repo, ["init", "-q"]);
  git(repo, ["commit", "-q", "--allow-empty", "-m", "init"]);
  const file = path.join(root, "agenthook.config.json");
  const pipeline = [
    { id: "code", sourceStatus: "code", successStatus: "review", instructionsFile: "./prompts/CODE.md" },
    { id: "review", sourceStatus: "review", successStatus: "done" },
    { id: "done", manual: true, sourceStatus: "done" },
  ];
  fs.writeFileSync(file, JSON.stringify({ name: `ah-doctor-fix-${process.pid}-${++seq}`, repoPath: repo, ingress: { type: "manual", url: "http://127.0.0.1:1" }, tracker: { type: "local", pipeline }, ...over }));
  fs.mkdirSync(path.join(root, "prompts"));
  fs.writeFileSync(path.join(root, "prompts", "CODE.md"), "code rules\n");
  fs.writeFileSync(path.join(root, "INSTRUCTIONS.md"), "default rules\n");
  const cfg = loadConfig({ configPath: file });
  fs.mkdirSync(cfg.stateDir, { recursive: true });
  fs.chmodSync(cfg.stateDir, 0o700);
  fs.mkdirSync(worktreeDir(cfg), { recursive: true });
  return { cfg, root, repo };
}

/** A recording spawner; `run` really executes the call (else it reports success). @param {boolean} [run] */
export function recorder(run = false) {
  /** @type {{cmd: string, args: string[], cwd?: string}[]} */
  const calls = [];
  /** @type {import('../src/commands/doctor.js').Spawner} */
  const spawn = (cmd, args, opts) => {
    calls.push({ cmd, args, cwd: opts.cwd });
    return run ? spawnSync(cmd, args, opts) : { status: 0 };
  };
  return { calls, spawn };
}

/** Probes stubbed so only the filesystem/git state under test decides the outcome. A fixed
 * `env` keeps the agent-env lints from seeing the host's or sandbox's own vars (e.g. the
 * sandbox's injected GIT_CONFIG_*), which would otherwise plant an unplanned problem. @param {any} [over] */
export const io = (over = {}) => ({ userClaudeSettings: null, onPath: () => true, portInUse: async () => false, uiBundle: () => ({ state: "fresh" }), skills: () => [], spawn: recorder().spawn, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" }, ...over });

/** @param {import('../src/commands/doctor.js').Check} c */
export const problem = (c) => !c.info && (!c.ok || !!c.warn);
export const silent = { log: () => {} };
