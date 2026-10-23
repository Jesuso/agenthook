// `agenthook skill install|ls` — put the portable agent skill (skills/agenthook/) where coding
// agents load skills from. Default: every agent detected on this machine (global, ~/.<agent>/…).
// `--repo [path]` installs into a project instead (default: this profile's repoPath, else cwd) so
// the agents the receiver spawns there load it too. `--agent a,b|all` picks agents explicitly.
// Equivalent for users of the `skills` CLI: `npx skills add <owner>/agenthook`.
import fs from "node:fs";
import path from "node:path";
import { peekConfig } from "../config.js";
import { AGENT_DIRS, detectAgents, installedSkills, installSkillInto, packageVersion, skillTargets } from "../skill-install.js";

/** @param {any} args */
export async function skill(args) {
  const sub = args._[0];
  if (sub !== "install" && sub !== "ls") die(`usage: agenthook skill install [--agent a,b|all] [--repo [path]] [--dry-run]\n       agenthook skill ls`);
  const repoPath = repoArg(args);
  if (sub === "ls") {
    const rows = installedSkills({ repoPath });
    if (!rows.length) return void console.log(`no agenthook skill installed (agenthook skill install); package version ${packageVersion()}`);
    for (const r of rows) console.log(`${r.agent.padEnd(9)} ${r.scope.padEnd(6)} ${r.version.padEnd(8)} ${r.dir}`);
    return;
  }
  const agents = agentsArg(args);
  if (!agents.length) die(`no coding agent detected under ${process.env.HOME ?? "~"} — name one: --agent ${Object.keys(AGENT_DIRS).join("|")}`);
  const res = installSkill(agents, { repoPath, dryRun: args["dry-run"] === true });
  for (const r of res) console.log(`${r.result.padEnd(9)} ${r.dir}`);
}

/**
 * @param {string[]} agents @param {{repoPath?: string|null, dryRun?: boolean, home?: string}} [o]
 * @returns {{agent: string, scope: string, dir: string, result: string}[]}
 */
export function installSkill(agents, { repoPath = null, dryRun = false, home } = {}) {
  const version = packageVersion();
  return skillTargets(agents, { repoPath, ...(home ? { home } : {}) }).map((t) => ({ ...t, result: installSkillInto(t.dir, version, { dryRun }) }));
}

/** @param {any} args */
function agentsArg(args) {
  const a = args.agent;
  if (a === "all") return Object.keys(AGENT_DIRS);
  if (typeof a === "string" && a) return a.split(",").map((s) => s.trim()).filter(Boolean);
  return detectAgents();
}

/** `--repo` (this profile's repoPath, else cwd) or `--repo <path>`; null = global. @param {any} args */
function repoArg(args) {
  const r = args.repo;
  if (r === undefined) return null;
  if (typeof r === "string" && r.startsWith("--")) args[r.slice(2)] = true; // bare `--repo` swallowed the next flag
  else if (typeof r === "string" && r) return path.resolve(r);
  try {
    const { configPath } = peekConfig({ configPath: args.config });
    const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
    if (typeof raw.repoPath === "string") return path.resolve(path.dirname(configPath), raw.repoPath);
  } catch {}
  return process.cwd();
}


/** @param {string} msg @returns {never} */
function die(msg) {
  console.error(msg);
  process.exit(1);
}
