import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// The agent guide's dynamic `authoring` topic (src/guide.js), the portable skill in skills/agenthook
// (open SKILL.md format: frontmatter, stamp, every referenced topic/file exists), its installer
// (stamp, update, foreign refusal, dry-run) and doctor's stale-skill lint.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { AUTHORING, PROVIDERS, guideTopics, loadGuide, renderAuthoring } from "../src/guide.js";
import { AGENT_DIRS, SKILL_SRC, detectAgents, installSkillInto, installedSkills, installedVersion, linkSkillInto, packageVersion, planSkillInstall, stampSourceSkill } from "../src/skill-install.js";
import { skillLints } from "../src/commands/doctor.js";
import { installSkill } from "../src/commands/skill.js";
import { createTools } from "../src/mcp/tools.js";

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]));

/** @param {Partial<import('../src/types.js').Config>} o */
const cfg = (o) => /** @type {any} */ ({ name: "p", trigger: "@agent", repoPath: "/r", repos: [], ...o });

test("guideTopics: the static sections plus authoring; the MCP tool lists the same", async () => {
  const topics = guideTopics();
  assert.ok(topics.includes("model") && topics.includes("recipes"));
  assert.equal(topics.at(-1), AUTHORING);
  const r = await createTools({}).call("guide", {}, { signal: new AbortController().signal });
  assert.deepEqual(r.topics, topics);
});

test("renderAuthoring: github — identity, first step, epic rule, native blockers", () => {
  const out = renderAuthoring(
    cfg({
      provider: "github",
      tracker: { repository: "o/r", assigneeLogin: "bot" },
      pipeline: [
        { id: "triage", sourceLabel: "agent:triage", successLabel: "agent:code", holdLabel: "agent:needs-info", failureLabel: "agent:blocked" },
        { id: "done", manual: true, sourceLabel: "agent:done", closeIssue: true },
      ],
    }),
  );
  assert.match(out, /^## authoring/);
  assert.match(out, /assignee @bot/);
  assert.match(out, /First step for new work: \*\*triage\*\* \(source label: agent:triage\)/);
  assert.match(out, /\| done \(manual\) \| agent:done \| — \| — \| — \| — \|/);
  assert.match(out, /Terminal\/closing steps: done\./);
  assert.match(out, /labelled "epic"/);
  assert.match(out, /must \*\*NOT\*\* sit in a step's source label/);
  assert.match(out, /native issue dependencies/);
  assert.match(out, /a merge alone does not close it/);
});

test("renderAuthoring: linear has no epics or blockers; asana warns on an unset userGid", () => {
  const lin = renderAuthoring(cfg({ provider: "linear", tracker: { team: "ENG" }, pipeline: [{ id: "code", sourceStatus: "Todo" }] }));
  assert.match(lin, /no epic support/);
  assert.match(lin, /Dependency links are ignored/);
  assert.match(lin, /team ENG/);
  const as = renderAuthoring(cfg({ provider: "asana", tracker: { projectGid: "1" }, pipeline: [{ id: "code", sourceSectionGid: "9" }] }));
  assert.match(as, /UNSET/);
  assert.match(as, /custom type is "Epic"/);
  assert.match(as, /completeTask:true/);
});

test("renderAuthoring: unknown provider degrades, never throws", () => {
  assert.match(renderAuthoring(cfg({ provider: "nope", pipeline: [] })), /Unknown tracker "nope"/);
});

test("skill: SKILL.md frontmatter + stamp; every guide topic and local link it names exists; one tracker file per provider", () => {
  const skill = fs.readFileSync(path.join(SKILL_SRC, "SKILL.md"), "utf8");
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(skill);
  assert.ok(fm, "frontmatter");
  assert.match(fm[1], /^name: agenthook$/m);
  assert.match(fm[1], /^description: .{40,}/m);
  // Stamped with the package version (npm's `version` script runs stampSourceSkill), so a copy
  // installed by `npx skills add Jesuso/agenthook@vX.Y.Z` carries the release it came from.
  assert.match(skill, new RegExp(`<!-- agenthook-skill ${packageVersion().replaceAll(".", "\\.")} -->`));
  const files = walk(SKILL_SRC).filter((f) => f.endsWith(".md"));
  const topics = new Set([...guideTopics(), "all"]);
  for (const f of files) {
    const text = fs.readFileSync(f, "utf8");
    for (const m of text.matchAll(/agenthook guide (\w+)/g)) assert.ok(topics.has(m[1]), `${path.relative(SKILL_SRC, f)} names unknown guide topic "${m[1]}"`);
    for (const m of text.matchAll(/\]\(((?:references|trackers)\/[^)#]+)\)/g)) assert.ok(fs.existsSync(path.join(path.dirname(f), m[1])), `${path.relative(SKILL_SRC, f)} links missing ${m[1]}`);
    assert.ok(!/mcp__|AskUserQuestion|\/caveman/.test(text), `${path.relative(SKILL_SRC, f)} is agent-neutral`);
  }
  for (const kind of Object.keys(PROVIDERS)) assert.ok(fs.existsSync(path.join(SKILL_SRC, "references", "trackers", `${kind}.md`)), `trackers/${kind}.md`);
});

test("skill: stampSourceSkill writes the given version into the source stamp and refuses an unstamped file", () => {
  const src = tmp("ah-stamp-");
  fs.writeFileSync(path.join(src, "SKILL.md"), "---\nname: agenthook\n---\n<!-- agenthook-skill dev -->\n# x\n");
  assert.equal(stampSourceSkill({ src, version: "9.8.7" }), "9.8.7");
  assert.equal(installedVersion(src), "9.8.7");
  fs.writeFileSync(path.join(src, "SKILL.md"), "---\nname: agenthook\n---\n# no stamp\n");
  assert.throws(() => stampSourceSkill({ src, version: "1.0.0" }), /no <!-- agenthook-skill/);
});

test("skill: the static guide topics the skill relies on still exist in docs/agent-guide.md", () => {
  const { topics } = loadGuide();
  for (const t of ["shapes", "errors", "gotchas"]) assert.ok(topics.has(t), t);
});

test("installSkillInto: install, current, update (stamp), foreign refusal, dry-run writes nothing", () => {
  const home = tmp("ah-skill-");
  const dir = path.join(home, ".agents", "skills", "agenthook");
  assert.equal(installSkillInto(dir, "1.0.0", { dryRun: true }), "installed");
  assert.ok(!fs.existsSync(dir), "dry-run");
  assert.equal(installSkillInto(dir, "1.0.0"), "installed");
  assert.equal(installedVersion(dir), "1.0.0");
  assert.ok(fs.existsSync(path.join(dir, "references", "trackers", "github.md")));
  assert.equal(installSkillInto(dir, "1.0.0"), "current");
  assert.equal(installSkillInto(dir, "1.1.0"), "updated");
  assert.equal(installedVersion(dir), "1.1.0");
  const foreign = path.join(home, ".cursor", "skills", "agenthook");
  fs.mkdirSync(foreign, { recursive: true });
  fs.writeFileSync(path.join(foreign, "SKILL.md"), "---\nname: agenthook\n---\nsomeone else's\n");
  assert.equal(installSkillInto(foreign, "1.1.0"), "foreign");
  assert.match(fs.readFileSync(path.join(foreign, "SKILL.md"), "utf8"), /someone else's/);
  // installSkillInto never replaces a symlink — it updates through it
  const link = path.join(home, ".claude", "skills", "agenthook");
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(path.relative(path.dirname(link), dir), link, "dir");
  assert.equal(installSkillInto(link, "1.2.0"), "updated");
  assert.ok(fs.lstatSync(link).isSymbolicLink(), "still a link");
  assert.equal(installedVersion(dir), "1.2.0");
  assert.ok(Object.keys(AGENT_DIRS).includes("agents"));
});

test("detectAgents: agents with a global config dir present under home", () => {
  const home = tmp("ah-skill-detect-");
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(home, ".cursor"), { recursive: true });
  assert.deepEqual(detectAgents(home).sort(), ["claude", "cursor"]);
});

test("planSkillInstall: one canonical copy; links for non-native agents; removes for native agents' stamped leftovers", () => {
  const home = tmp("ah-skill-plan-");
  const canonical = path.join(home, ".agents", "skills", "agenthook");
  // a leftover stamped copy in codex's own (native) dir and opencode's legacy singular dir
  const codexOld = path.join(home, ".codex", "skills", "agenthook");
  const opencodeLegacy = path.join(home, ".config", "opencode", "skill", "agenthook");
  installSkillInto(codexOld, "1.0.0");
  installSkillInto(opencodeLegacy, "1.0.0");
  const plan = planSkillInstall(["agents", "claude", "cursor", "codex", "opencode", "hermes", "gemini"], { home });
  assert.deepEqual(plan.filter((a) => a.kind === "copy"), [{ agent: "agents", scope: "global", kind: "copy", dir: canonical }]);
  const links = plan.filter((a) => a.kind === "link").map((a) => a.agent).sort();
  assert.deepEqual(links, ["claude", "hermes"]);
  assert.equal(plan.find((a) => a.agent === "claude").target, canonical);
  const removes = plan.filter((a) => a.kind === "remove").map((a) => a.dir).sort();
  assert.deepEqual(removes, [codexOld, opencodeLegacy].sort());
  // cursor/gemini are native but have no leftover copy — no action for them
  assert.ok(!plan.some((a) => a.agent === "cursor" || a.agent === "gemini"));
  assert.throws(() => planSkillInstall(["nope"], { home }), /unknown agent "nope"/);
});

test("planSkillInstall: unrequested/undetected agents get no dir at all", () => {
  const home = tmp("ah-skill-plan-scope-");
  const plan = planSkillInstall(["agents", "claude"], { home });
  assert.deepEqual(plan.map((a) => a.agent).sort(), ["agents", "claude"]);
});

test("planSkillInstall: a foreign (unstamped) dir in a native agent's own or legacy dir is reported, never removed", () => {
  const home = tmp("ah-skill-plan-foreign-");
  const foreignGemini = path.join(home, ".gemini", "skills", "agenthook");
  fs.mkdirSync(foreignGemini, { recursive: true });
  fs.writeFileSync(path.join(foreignGemini, "SKILL.md"), "---\nname: agenthook\n---\nsomeone else's\n");
  const foreignLegacy = path.join(home, ".config", "opencode", "skill", "agenthook");
  fs.mkdirSync(foreignLegacy, { recursive: true });
  fs.writeFileSync(path.join(foreignLegacy, "SKILL.md"), "---\nname: agenthook\n---\nsomeone else's too\n");
  const plan = planSkillInstall(["agents", "gemini", "opencode"], { home });
  const foreignRows = plan.filter((a) => a.kind === "foreign");
  assert.deepEqual(foreignRows.map((a) => [a.agent, a.dir]).sort(), [
    ["gemini", foreignGemini],
    ["opencode", foreignLegacy],
  ]);
  for (const dir of [foreignGemini, foreignLegacy]) {
    assert.match(fs.readFileSync(path.join(dir, "SKILL.md"), "utf8"), /someone else's/);
  }
});

test("linkSkillInto: link, current, relink over a stale stamped copy, foreign untouched, dry-run writes nothing", () => {
  const home = tmp("ah-skill-link-");
  const canonical = path.join(home, ".agents", "skills", "agenthook");
  installSkillInto(canonical, "1.0.0");
  const link = path.join(home, ".claude", "skills", "agenthook");
  assert.deepEqual(linkSkillInto(link, canonical, { dryRun: true }), { result: "linked" });
  assert.ok(!fs.existsSync(link), "dry-run");
  assert.deepEqual(linkSkillInto(link, canonical), { result: "linked" });
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.equal(fs.realpathSync(link), fs.realpathSync(canonical));
  assert.deepEqual(linkSkillInto(link, canonical), { result: "current" });
  // a stale real (stamped) copy at the link path gets migrated to a link
  const stale = path.join(home, ".hermes", "skills", "agenthook");
  installSkillInto(stale, "0.9.0");
  assert.deepEqual(linkSkillInto(stale, canonical), { result: "relinked" });
  assert.ok(fs.lstatSync(stale).isSymbolicLink());
  // a foreign (unstamped) dir is never touched
  const foreign = path.join(home, ".gemini", "skills", "agenthook");
  fs.mkdirSync(foreign, { recursive: true });
  fs.writeFileSync(path.join(foreign, "SKILL.md"), "---\nname: agenthook\n---\nsomeone else's\n");
  assert.deepEqual(linkSkillInto(foreign, canonical), { result: "foreign" });
  assert.match(fs.readFileSync(path.join(foreign, "SKILL.md"), "utf8"), /someone else's/);
  assert.ok(!fs.lstatSync(foreign).isSymbolicLink());
});

test("linkSkillInto: a symlink that throws falls back to a real stamped copy and reports the error code", () => {
  const home = tmp("ah-skill-link-fallback-");
  const canonical = path.join(home, ".agents", "skills", "agenthook");
  installSkillInto(canonical, "1.0.0");
  const link = path.join(home, ".claude", "skills", "agenthook");
  const boom = () => {
    const e = new Error("not permitted");
    e.code = "EPERM";
    throw e;
  };
  const r = linkSkillInto(link, canonical, { symlink: boom });
  assert.equal(r.result, "copied");
  assert.match(r.note, /EPERM/);
  assert.ok(!fs.lstatSync(link).isSymbolicLink());
  assert.equal(installedVersion(link), "1.0.0");
});

test("installedSkills: canonical copy + links (version read through the link) + legacy copies", () => {
  const home = tmp("ah-skill-listed-");
  const repo = tmp("ah-skill-listed-repo-");
  const globalCanonical = path.join(home, ".agents", "skills", "agenthook");
  installSkillInto(globalCanonical, "1.1.0");
  linkSkillInto(path.join(home, ".claude", "skills", "agenthook"), globalCanonical);
  const repoCanonical = path.join(repo, ".agents", "skills", "agenthook");
  installSkillInto(repoCanonical, "1.1.0");
  const rows = installedSkills({ home, repoPath: repo });
  const sorted = rows.map((r) => [r.agent, r.scope, r.version, !!r.linkTo]).sort();
  assert.deepEqual(sorted, [
    ["agents", "global", "1.1.0", false],
    ["agents", "repo", "1.1.0", false],
    ["claude", "global", "1.1.0", true],
  ]);
});

test("doctor skillLints: a stale canonical copy and a stale non-native fallback copy warn with a reinstall fix; a native agent's leftover warns with a remove fix; link rows and current copies are silent", () => {
  const rows = [
    { agent: "agents", scope: "repo", dir: "/r/.agents/skills/agenthook", version: "0.9.0" },
    { agent: "codex", scope: "global", dir: "/h/.codex/skills/agenthook", version: "0.9.0" },
    { agent: "claude", scope: "global", dir: "/h/.claude/skills/agenthook", version: "0.9.0" },
  ];
  const reinstalled = [];
  const removed = [];
  const f = skillLints(rows, "0.11.0", { reinstall: (d) => reinstalled.push(d), remove: (d) => removed.push(d) });
  assert.equal(f.length, 3);
  const canonicalFinding = f.find((x) => x.note.includes("/r/.agents"));
  assert.match(canonicalFinding.note, /0\.9\.0; this agenthook is 0\.11\.0/);
  const legacyFinding = f.find((x) => x.note.includes("/h/.codex"));
  assert.match(legacyFinding.note, /stale\/duplicate copy/);
  // claude isn't native — a stale real copy there is a plain fallback copy, not a leftover: it
  // must warn with the reinstall fix, never the remove fix (claude has no .agents alternative).
  const fallbackFinding = f.find((x) => x.note.includes("/h/.claude"));
  assert.match(fallbackFinding.note, /0\.9\.0; this agenthook is 0\.11\.0/);
  canonicalFinding.fix.apply();
  legacyFinding.fix.apply();
  fallbackFinding.fix.apply();
  assert.deepEqual(reinstalled.sort(), ["/h/.claude/skills/agenthook", "/r/.agents/skills/agenthook"].sort());
  assert.deepEqual(removed, ["/h/.codex/skills/agenthook"]);
  // a link row (claude, now relinked to the canonical copy) never warns, nor does a current copy
  const linked = [
    { agent: "agents", scope: "repo", dir: "/r/.agents/skills/agenthook", version: "0.11.0" },
    { agent: "claude", scope: "global", dir: "/h/.claude/skills/agenthook", version: "0.9.0", linkTo: "/h/.agents/skills/agenthook" },
  ];
  assert.deepEqual(skillLints(linked, "0.11.0"), []);
});

// The skill's CLI bootstrap (skills/agenthook/scripts/ensure-cli.sh): what a skill-first user's
// agent runs when `agenthook` is not installed. Driven with a stub PATH so nothing is installed.
const ENSURE = path.join(SKILL_SRC, "scripts", "ensure-cli.sh");
/** @param {Record<string, string>} bins name → script body ("" = symlink the real node) @param {string[]} [argv] */
function runEnsure(bins, argv = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-ensure-"));
  for (const [name, body] of Object.entries(bins)) {
    if (body === "") fs.symlinkSync(process.execPath, path.join(dir, name));
    else fs.writeFileSync(path.join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  }
  const r = spawnSync("sh", [ENSURE, ...argv], { encoding: "utf8", env: { PATH: `${dir}:/usr/bin:/bin`, HOME: dir } });
  fs.rmSync(dir, { recursive: true, force: true });
  return r;
}

test("ensure-cli.sh: a missing CLI installs the version stamped in SKILL.md (--dry-run names the command)", { skip: process.platform === "win32" }, () => {
  const r = runEnsure({ node: "", npm: "exit 0" }, ["--dry-run"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`Would run: npm install -g @jesuso/agenthook@${packageVersion().replaceAll(".", "\\.")}\\n`));
});

test("ensure-cli.sh: an installed CLI is reported and left alone; another version is a note, not an error", { skip: process.platform === "win32" }, () => {
  const same = runEnsure({ agenthook: `echo ${packageVersion()}` });
  assert.equal(same.status, 0, same.stderr);
  assert.match(same.stdout, new RegExp(`^agenthook ${packageVersion().replaceAll(".", "\\.")} is installed: `));
  assert.doesNotMatch(same.stdout, /note:/);
  const old = runEnsure({ agenthook: "echo 0.0.1" });
  assert.equal(old.status, 0, old.stderr);
  assert.match(old.stdout, /note: this skill was written for agenthook /);
});

test("ensure-cli.sh: a Node older than 22 stops with the reason, installing nothing", { skip: process.platform === "win32" }, () => {
  const r = runEnsure({ node: 'case "$1" in -p) echo 18;; *) echo v18.0.0;; esac', npm: "echo SHOULD-NOT-RUN; exit 0" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /needs Node\.js 22 or newer; this is v18\.0\.0/);
  assert.doesNotMatch(r.stdout + r.stderr, /SHOULD-NOT-RUN/);
});

test("installSkill: fresh install — one canonical copy, symlinks only for claude/hermes, no dirs for the other native agents", () => {
  const home = tmp("ah-installskill-fresh-");
  const agents = ["agents", "claude", "cursor", "codex", "opencode", "hermes", "gemini"];
  const rows = installSkill(agents, { home });
  const canonical = path.join(home, ".agents", "skills", "agenthook");
  assert.ok(fs.existsSync(canonical) && !fs.lstatSync(canonical).isSymbolicLink());
  for (const a of ["claude", "hermes"]) {
    const link = path.join(home, `.${a}`, "skills", "agenthook");
    assert.ok(fs.lstatSync(link).isSymbolicLink(), `${a} should be a link`);
    assert.equal(fs.realpathSync(link), fs.realpathSync(canonical));
  }
  for (const a of ["cursor", "codex", "opencode", "gemini"]) assert.ok(!fs.existsSync(path.join(home, `.${a}`)), `no .${a} dir`);
  assert.deepEqual(rows.filter((r) => r.kind === "link").map((r) => r.agent).sort(), ["claude", "hermes"]);
});

test("installSkill: re-install over old per-agent copies migrates native ones to a removal and claude/hermes to links; the canonical copy updates", () => {
  const home = tmp("ah-installskill-reinstall-");
  for (const a of ["claude", "cursor", "codex", "opencode", "hermes", "gemini"]) installSkillInto(path.join(home, AGENT_DIRS[a].global, "agenthook"), "0.9.0");
  const rows = installSkill(["agents", "claude", "cursor", "codex", "opencode", "hermes", "gemini"], { home });
  const byAgentKind = Object.fromEntries(rows.map((r) => [`${r.agent}:${r.kind}`, r.result]));
  assert.equal(byAgentKind["agents:copy"], "installed");
  assert.equal(byAgentKind["claude:link"], "relinked");
  assert.equal(byAgentKind["hermes:link"], "relinked");
  assert.equal(byAgentKind["cursor:remove"], "removed");
  assert.equal(byAgentKind["codex:remove"], "removed");
  assert.equal(byAgentKind["gemini:remove"], "removed");
  assert.equal(byAgentKind["opencode:remove"], "removed");
  assert.equal(installedVersion(path.join(home, ".agents", "skills", "agenthook")), packageVersion());
  for (const a of ["cursor", "codex", "opencode", "gemini"]) assert.ok(!fs.existsSync(path.join(home, AGENT_DIRS[a].global, "agenthook")));
});

test("installSkill: --dry-run writes nothing", () => {
  const home = tmp("ah-installskill-dryrun-");
  const rows = installSkill(["agents", "claude"], { home, dryRun: true });
  assert.ok(rows.every((r) => r.result === "installed" || r.result === "linked"));
  assert.ok(!fs.existsSync(path.join(home, ".agents")), "dry-run touched nothing");
});

test("installSkill: a foreign dir in a native agent's dir is reported and left byte-for-byte untouched", () => {
  const home = tmp("ah-installskill-foreign-");
  const foreign = path.join(home, ".gemini", "skills", "agenthook");
  fs.mkdirSync(foreign, { recursive: true });
  fs.writeFileSync(path.join(foreign, "SKILL.md"), "---\nname: agenthook\n---\nsomeone else's\n");
  const before = fs.readFileSync(path.join(foreign, "SKILL.md"), "utf8");
  const rows = installSkill(["agents", "gemini"], { home });
  const foreignRow = rows.find((r) => r.agent === "gemini");
  assert.equal(foreignRow.kind, "foreign");
  assert.equal(foreignRow.result, "foreign");
  assert.equal(fs.readFileSync(path.join(foreign, "SKILL.md"), "utf8"), before);
});

test("installSkill: fresh repo-scope install — relative symlinks, no dirs for other native agents", () => {
  const repo = tmp("ah-installskill-repo-fresh-");
  const agents = ["agents", "claude", "cursor", "codex", "opencode", "hermes", "gemini"];
  installSkill(agents, { repoPath: repo });
  const canonical = path.join(repo, ".agents", "skills", "agenthook");
  assert.ok(fs.existsSync(canonical) && !fs.lstatSync(canonical).isSymbolicLink());
  for (const a of ["claude", "hermes"]) {
    const link = path.join(repo, `.${a}`, "skills", "agenthook");
    assert.ok(fs.lstatSync(link).isSymbolicLink(), `${a} should be a link`);
    assert.ok(!path.isAbsolute(fs.readlinkSync(link)), `${a}'s link target should be relative`);
    assert.equal(fs.realpathSync(link), fs.realpathSync(canonical));
  }
  for (const a of ["cursor", "codex", "opencode", "gemini"]) assert.ok(!fs.existsSync(path.join(repo, `.${a}`)), `no .${a} dir`);
});

test("installSkill: re-installing over a stale canonical copy updates it to the new stamp while links report current and stay links", () => {
  const home = tmp("ah-installskill-stale-canonical-");
  installSkillInto(path.join(home, ".agents", "skills", "agenthook"), "0.9.0");
  const first = installSkill(["agents", "claude"], { home });
  assert.equal(first.find((r) => r.kind === "copy").result, "updated");
  assert.equal(first.find((r) => r.kind === "link").result, "linked");
  assert.equal(installedVersion(path.join(home, ".agents", "skills", "agenthook")), packageVersion());
  // re-run on the now-linked layout, even with the canonical copy already current
  const second = installSkill(["agents", "claude"], { home });
  assert.equal(second.find((r) => r.kind === "copy").result, "current");
  assert.equal(second.find((r) => r.kind === "link").result, "current");
  const link = path.join(home, ".claude", "skills", "agenthook");
  assert.ok(fs.lstatSync(link).isSymbolicLink(), "still a link after two installs");
});
