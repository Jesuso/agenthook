// Install the portable `agenthook` agent skill (skills/agenthook/, the open SKILL.md format every
// coding agent loads) into the skill directories of the agents on this machine or in a repo. Pure
// copy + version stamp; nothing agent-specific inside the skill. `agenthook skill install`,
// `init` (opt-in offer) and `doctor` (stale-copy warning) all go through here.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installDir } from "./config.js";

export const SKILL_NAME = "agenthook";
export const SKILL_SRC = path.join(installDir, "skills", SKILL_NAME);
const STAMP_RE = /<!-- agenthook-skill (\S+) -->/;

/**
 * Where each agent looks for skills: `repo` = relative to a project root, `global` = under $HOME.
 * `agents` is the cross-agent convention (`.agents/skills`) the `skills` CLI also writes.
 * @type {Record<string, {repo: string, global: string, detect: string}>} */
export const AGENT_DIRS = {
  claude: { repo: ".claude/skills", global: ".claude/skills", detect: ".claude" },
  cursor: { repo: ".cursor/skills", global: ".cursor/skills", detect: ".cursor" },
  codex: { repo: ".codex/skills", global: ".codex/skills", detect: ".codex" },
  opencode: { repo: ".opencode/skill", global: ".config/opencode/skill", detect: ".config/opencode" },
  hermes: { repo: ".hermes/skills", global: ".hermes/skills", detect: ".hermes" },
  gemini: { repo: ".gemini/skills", global: ".gemini/skills", detect: ".gemini" },
  agents: { repo: ".agents/skills", global: ".agents/skills", detect: ".agents" },
};

/** Agents whose global config dir exists under `home` (so a global install lands somewhere read). @param {string} [home] */
export function detectAgents(home = os.homedir()) {
  return Object.entries(AGENT_DIRS)
    .filter(([, d]) => fs.existsSync(path.join(home, d.detect)))
    .map(([k]) => k);
}

/** @param {string} dir the skill's installed dir @returns {string|null} stamped version, null when not installed/unstamped */
export function installedVersion(dir) {
  try {
    return STAMP_RE.exec(fs.readFileSync(path.join(dir, "SKILL.md"), "utf8"))?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Target dirs for a set of agents. @param {string[]} agents @param {{home?: string, repoPath?: string|null}} o */
export function skillTargets(agents, { home = os.homedir(), repoPath = null } = {}) {
  /** @type {{agent: string, scope: 'global'|'repo', dir: string}[]} */
  const out = [];
  for (const a of agents) {
    const d = AGENT_DIRS[a];
    if (!d) throw new Error(`unknown agent "${a}"; known: ${Object.keys(AGENT_DIRS).join(", ")}`);
    if (repoPath) out.push({ agent: a, scope: "repo", dir: path.join(repoPath, d.repo, SKILL_NAME) });
    else out.push({ agent: a, scope: "global", dir: path.join(home, d.global, SKILL_NAME) });
  }
  return out;
}

/**
 * Copy the skill into `dir`, stamping `version`. Replaces a previous copy of OUR skill (stamped);
 * refuses to overwrite a foreign dir of the same name. Returns what happened.
 * @param {string} dir @param {string} version @param {{src?: string, dryRun?: boolean}} [o]
 * @returns {'installed'|'updated'|'current'|'foreign'}
 */
export function installSkillInto(dir, version, { src = SKILL_SRC, dryRun = false } = {}) {
  const have = installedVersion(dir);
  if (have === null && fs.existsSync(path.join(dir, "SKILL.md"))) return "foreign";
  if (have === version) return "current";
  if (!dryRun) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    fs.cpSync(src, dir, { recursive: true });
    const f = path.join(dir, "SKILL.md");
    fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace(STAMP_RE, `<!-- agenthook-skill ${version} -->`));
  }
  return have === null ? "installed" : "updated";
}

/** Package version (the stamp a fresh install carries). */
export function packageVersion() {
  return JSON.parse(fs.readFileSync(path.join(installDir, "package.json"), "utf8")).version;
}

/**
 * Every place our skill is installed (stamped) among the known agent dirs, with its version.
 * @param {{home?: string, repoPath?: string|null}} [o]
 */
export function installedSkills({ home = os.homedir(), repoPath = null } = {}) {
  const all = Object.keys(AGENT_DIRS);
  const targets = [...skillTargets(all, { home }), ...(repoPath ? skillTargets(all, { home, repoPath }) : [])];
  /** @type {{agent: string, scope: 'global'|'repo', dir: string, version: string}[]} */
  const out = [];
  for (const t of targets) {
    const version = installedVersion(t.dir);
    if (version !== null) out.push({ ...t, version });
  }
  return out;
}
