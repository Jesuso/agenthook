// Install the portable `agenthook` agent skill (skills/agenthook/, the open SKILL.md format every
// coding agent loads) into one canonical dir plus a symlink per agent that doesn't read it
// natively. `agenthook skill install`, `init` (opt-in offer) and `doctor` (stale-copy warning)
// all go through here.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installDir } from "./config/index.js";

export const SKILL_NAME = "agenthook";
export const SKILL_SRC = path.join(installDir, "skills", SKILL_NAME);
const STAMP_RE = /<!-- agenthook-skill (\S+) -->/;

/**
 * Where each agent looks for skills: `repo` = relative to a project root, `global` = under $HOME.
 * `native[scope]` = the agent already reads the cross-agent `.agents/skills` convention at that
 * scope, so it only ever needs a symlink there, never its own copy; `agents` is that canonical
 * entry itself. `legacy[scope]` lists old/wrong dirs (relative to the same base) that are only
 * scanned for cleanup of a previously-installed stamped copy — never installed into.
 * @type {Record<string, {repo: string, global: string, detect: string, native: {repo: boolean, global: boolean}, legacy?: {repo?: string[], global?: string[]}}>} */
export const AGENT_DIRS = {
  claude: { repo: ".claude/skills", global: ".claude/skills", detect: ".claude", native: { repo: false, global: false } },
  // Cursor and Gemini CLI read `.agents/skills` at the repo level, but at the user level the
  // `skills` CLI's own agent table has them reading `~/.cursor/skills` / `~/.gemini/skills`
  // instead — not `~/.agents/skills` — so a global install still needs a link for them.
  cursor: { repo: ".cursor/skills", global: ".cursor/skills", detect: ".cursor", native: { repo: true, global: false } },
  codex: { repo: ".codex/skills", global: ".codex/skills", detect: ".codex", native: { repo: true, global: true } },
  opencode: {
    repo: ".opencode/skills",
    global: ".config/opencode/skills",
    detect: ".config/opencode",
    native: { repo: true, global: true },
    legacy: { repo: [".opencode/skill"], global: [".config/opencode/skill"] },
  },
  hermes: { repo: ".hermes/skills", global: ".hermes/skills", detect: ".hermes", native: { repo: false, global: false } },
  gemini: { repo: ".gemini/skills", global: ".gemini/skills", detect: ".gemini", native: { repo: true, global: false } },
  agents: { repo: ".agents/skills", global: ".agents/skills", detect: ".agents", native: { repo: true, global: true } },
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

/** @param {string} dir @returns {string|null} the realpath of `dir` if it's a symlink, else null (incl. dangling) */
function linkRealpath(dir) {
  let lst;
  try {
    lst = fs.lstatSync(dir);
  } catch {
    return null;
  }
  if (!lst.isSymbolicLink()) return null;
  try {
    return fs.realpathSync(dir);
  } catch {
    return null; // dangling — caller treats as "no real target"
  }
}

/** The canonical install dir for the given scope/base: `<base>/.agents/skills/agenthook`. @param {string} base @param {'repo'|'global'} scope */
function canonicalDir(base, scope) {
  return path.join(base, AGENT_DIRS.agents[scope], SKILL_NAME);
}

/**
 * Plan what installing `agents` would do: always one canonical copy; a `link` for each requested
 * agent that doesn't read `.agents/skills` natively at this scope; a `remove` for each requested
 * native agent whose own (or legacy) dir still holds a stamped copy left over from before this; a
 * `foreign` row (never touched, reported only) for a native agent's own (or legacy) dir that holds
 * an unstamped `agenthook` skill someone else put there — left alone, but flagged since the agent
 * would otherwise load it alongside the canonical one.
 * @param {string[]} agents @param {{home?: string, repoPath?: string|null}} [o]
 * @returns {{agent: string, scope: 'global'|'repo', kind: 'copy'|'link'|'remove'|'foreign', dir: string, target?: string}[]}
 */
export function planSkillInstall(agents, { home = os.homedir(), repoPath = null } = {}) {
  const scope = repoPath ? "repo" : "global";
  const base = repoPath ?? home;
  const canonical = canonicalDir(base, scope);
  /** @type {ReturnType<typeof planSkillInstall>} */
  const out = [{ agent: "agents", scope, kind: "copy", dir: canonical }];
  for (const a of agents) {
    if (a === "agents") continue;
    const d = AGENT_DIRS[a];
    if (!d) throw new Error(`unknown agent "${a}"; known: ${Object.keys(AGENT_DIRS).join(", ")}`);
    if (!d.native[scope]) {
      out.push({ agent: a, scope, kind: "link", dir: path.join(base, d[scope], SKILL_NAME), target: canonical });
    } else {
      for (const rel of [d[scope], ...(d.legacy?.[scope] ?? [])]) {
        const dir = path.join(base, rel, SKILL_NAME);
        if (installedVersion(dir) !== null) out.push({ agent: a, scope, kind: "remove", dir });
        else if (fs.existsSync(path.join(dir, "SKILL.md"))) out.push({ agent: a, scope, kind: "foreign", dir });
      }
    }
  }
  return out;
}

/**
 * Copy the skill into `dir`, stamping `version`. If `dir` is a symlink, never replaces the link —
 * it operates on the link's real target instead (so re-running install on a linked layout updates
 * the canonical copy through the link rather than turning the link back into a copy), and refuses
 * ("foreign") when that target isn't ours. Refuses to overwrite any other foreign dir of the same
 * name. Returns what happened.
 * @param {string} dir @param {string} version @param {{src?: string, dryRun?: boolean}} [o]
 * @returns {'installed'|'updated'|'current'|'foreign'}
 */
export function installSkillInto(dir, version, { src = SKILL_SRC, dryRun = false } = {}) {
  let target = dir;
  const real = linkRealpath(dir);
  if (real !== null) {
    if (installedVersion(real) === null) return "foreign";
    target = real;
  }
  const have = installedVersion(target);
  if (have === null && fs.existsSync(path.join(target, "SKILL.md"))) return "foreign";
  if (have === version) return "current";
  if (!dryRun) {
    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(src, target, { recursive: true });
    const f = path.join(target, "SKILL.md");
    fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace(STAMP_RE, `<!-- agenthook-skill ${version} -->`));
  }
  return have === null ? "installed" : "updated";
}

/**
 * Point `linkPath` at the canonical copy `canonical` with a relative symlink (an absolute
 * junction on win32, since junctions need no privilege there and don't support relative targets).
 * Never touches a foreign dir/link; replaces our own stale copy or link with the new link.
 * @param {string} linkPath @param {string} canonical
 * @param {{dryRun?: boolean, symlink?: typeof fs.symlinkSync}} [o]
 * @returns {{result: 'linked'|'current'|'relinked'|'copied'|'foreign', note?: string}}
 */
export function linkSkillInto(linkPath, canonical, { dryRun = false, symlink = fs.symlinkSync } = {}) {
  let canonicalReal;
  try {
    canonicalReal = fs.realpathSync(canonical);
  } catch {
    canonicalReal = path.resolve(canonical);
  }
  let lst;
  try {
    lst = fs.lstatSync(linkPath);
  } catch {
    lst = null; // absent
  }
  let relink = false;
  if (lst?.isSymbolicLink()) {
    // already a symlink: current if it resolves to the canonical copy, else relink iff it's
    // pointing at a stamped agenthook skill (ours, just elsewhere) or dangling (ours, deleted
    // out from under it) — a link to anything else is left alone.
    const real = linkRealpath(linkPath);
    if (real === canonicalReal) return { result: "current" };
    if (real !== null && installedVersion(real) === null) return { result: "foreign" };
    relink = true;
  } else if (lst) {
    if (installedVersion(linkPath) === null) return { result: "foreign" };
    relink = true;
  }
  if (dryRun) return { result: relink ? "relinked" : "linked" };
  fs.rmSync(linkPath, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  try {
    if (process.platform === "win32") symlink(path.resolve(canonical), linkPath, "junction");
    else symlink(path.relative(path.dirname(linkPath), canonical), linkPath, "dir");
    return { result: relink ? "relinked" : "linked" };
  } catch (e) {
    const version = installedVersion(canonicalReal) ?? packageVersion();
    installSkillInto(linkPath, version, { dryRun: false });
    return { result: "copied", note: `symlink failed (${e.code ?? e.message}), copied instead` };
  }
}

/**
 * Stamp the source skill (skills/agenthook/SKILL.md) with the package version. npm's `version`
 * lifecycle script runs it on every bump, so the copy at a release tag already carries that
 * version and an install straight from git (`npx skills add Jesuso/agenthook@vX.Y.Z`) is
 * versioned like one from `agenthook skill install`. Returns the version written.
 * @param {{src?: string, version?: string}} [o]
 */
export function stampSourceSkill({ src = SKILL_SRC, version = packageVersion() } = {}) {
  const f = path.join(src, "SKILL.md");
  const text = fs.readFileSync(f, "utf8");
  if (!STAMP_RE.test(text)) throw new Error(`${f} has no <!-- agenthook-skill … --> stamp`);
  fs.writeFileSync(f, text.replace(STAMP_RE, `<!-- agenthook-skill ${version} -->`));
  return version;
}

/** Package version (the stamp a fresh install carries). */
export function packageVersion() {
  return JSON.parse(fs.readFileSync(path.join(installDir, "package.json"), "utf8")).version;
}

/**
 * Every place our skill is installed (stamped, or a link resolving to a stamped copy) among the
 * known agent dirs (incl. legacy ones), with its version. A link row carries `linkTo`: the
 * canonical copy's realpath (its version is read through the link).
 * @param {{home?: string, repoPath?: string|null}} [o]
 * @returns {{agent: string, scope: 'global'|'repo', dir: string, version: string, linkTo?: string}[]}
 */
export function installedSkills({ home = os.homedir(), repoPath = null } = {}) {
  /** @type {['global', string][] | ['global'|'repo', string][]} */
  const scopes = repoPath ? [["global", home], ["repo", repoPath]] : [["global", home]];
  /** @type {ReturnType<typeof installedSkills>} */
  const out = [];
  for (const [scope, base] of scopes) {
    for (const [agent, d] of Object.entries(AGENT_DIRS)) {
      for (const rel of [d[scope], ...(d.legacy?.[scope] ?? [])]) {
        const dir = path.join(base, rel, SKILL_NAME);
        const real = linkRealpath(dir);
        if (real !== null) {
          const version = installedVersion(real);
          if (version !== null) out.push({ agent, scope, dir, version, linkTo: real });
        } else {
          const version = installedVersion(dir);
          if (version !== null) out.push({ agent, scope, dir, version });
        }
      }
    }
  }
  return out;
}
