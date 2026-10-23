import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// The agent guide's dynamic `authoring` topic (src/guide.js), the portable skill in skills/agenthook
// (open SKILL.md format: frontmatter, stamp, every referenced topic/file exists), its installer
// (stamp, update, foreign refusal, dry-run) and doctor's stale-skill lint.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AUTHORING, PROVIDERS, guideTopics, loadGuide, renderAuthoring } from "../src/guide.js";
import { AGENT_DIRS, SKILL_SRC, detectAgents, installSkillInto, installedSkills, installedVersion, skillTargets } from "../src/skill-install.js";
import { skillLints } from "../src/commands/doctor.js";
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
  assert.match(lin, /ignores dependency links/);
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
  assert.match(skill, /<!-- agenthook-skill dev -->/);
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

test("skill: the static guide topics the skill relies on still exist in docs/agent-guide.md", () => {
  const { topics } = loadGuide();
  for (const t of ["shapes", "errors", "gotchas"]) assert.ok(topics.has(t), t);
});

test("installSkillInto: install, current, update (stamp), foreign refusal, dry-run writes nothing", () => {
  const home = tmp("ah-skill-");
  const [t] = skillTargets(["claude"], { home });
  assert.equal(t.dir, path.join(home, ".claude", "skills", "agenthook"));
  assert.equal(installSkillInto(t.dir, "1.0.0", { dryRun: true }), "installed");
  assert.ok(!fs.existsSync(t.dir), "dry-run");
  assert.equal(installSkillInto(t.dir, "1.0.0"), "installed");
  assert.equal(installedVersion(t.dir), "1.0.0");
  assert.ok(fs.existsSync(path.join(t.dir, "references", "trackers", "github.md")));
  assert.equal(installSkillInto(t.dir, "1.0.0"), "current");
  assert.equal(installSkillInto(t.dir, "1.1.0"), "updated");
  assert.equal(installedVersion(t.dir), "1.1.0");
  const foreign = path.join(home, ".cursor", "skills", "agenthook");
  fs.mkdirSync(foreign, { recursive: true });
  fs.writeFileSync(path.join(foreign, "SKILL.md"), "---\nname: agenthook\n---\nsomeone else's\n");
  assert.equal(installSkillInto(foreign, "1.1.0"), "foreign");
  assert.match(fs.readFileSync(path.join(foreign, "SKILL.md"), "utf8"), /someone else's/);
  // repo scope + detection + listing
  const repo = tmp("ah-skill-repo-");
  const [r] = skillTargets(["agents"], { home, repoPath: repo });
  assert.equal(r.dir, path.join(repo, ".agents", "skills", "agenthook"));
  installSkillInto(r.dir, "1.1.0");
  assert.deepEqual(detectAgents(home).sort(), ["claude", "cursor"]);
  const rows = installedSkills({ home, repoPath: repo });
  assert.deepEqual(rows.map((x) => [x.agent, x.scope, x.version]).sort(), [["agents", "repo", "1.1.0"], ["claude", "global", "1.1.0"]]);
  assert.throws(() => skillTargets(["nope"], { home }), /unknown agent "nope"/);
  assert.ok(Object.keys(AGENT_DIRS).includes("agents"));
});

test("doctor skillLints: stale copies warn with a reinstall fix; current ones are silent", () => {
  const rows = [
    { agent: "claude", scope: "global", dir: "/h/.claude/skills/agenthook", version: "0.9.0" },
    { agent: "agents", scope: "repo", dir: "/r/.agents/skills/agenthook", version: "0.11.0" },
  ];
  const reinstalled = [];
  const f = skillLints(rows, "0.11.0", { reinstall: (d) => reinstalled.push(d) });
  assert.equal(f.length, 1);
  assert.equal(f[0].level, "warn");
  assert.match(f[0].note, /0\.9\.0; this agenthook is 0\.11\.0/);
  f[0].fix.apply();
  assert.deepEqual(reinstalled, ["/h/.claude/skills/agenthook"]);
  assert.deepEqual(skillLints(rows.slice(1), "0.11.0"), []);
});
