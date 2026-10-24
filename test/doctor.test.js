import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// doctor — pure-unit coverage (no network): the pipeline-binding scan that flags
// `init` TODO_* placeholders and empty bindings before they silently no-op a run,
// plus the multi-repo routing lints, and `--fix` (#446) against tmp state dirs / git repos.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { execFileSync, spawnSync } from "node:child_process";
import { unfilledBindings, repoLints, legacyOrphans, forgeLints, agentBinChecks, agentLints, policyLints, portCheck, claimedPortLint, runChecks, applyFixes, fixableCount, report, instructionLints, ingressChecks, ingressLivenessLints, githubAppChecks, sandboxChecks, sandboxRuntimeChecks, agentEnvLints, ghAuthLints, egressLints, runTokenLints, isolationReport, parseForceSshRewrites } from "../src/commands/doctor.js";
import crypto from "node:crypto";
import { resetGithubAuthCache } from "../src/github-auth.js";
import { worktreeDir } from "../src/paths.js";
import { loadConfig } from "../src/config.js";
import { instructionTargets } from "../src/heartbeat.js";
import { uiBundleState } from "../src/ui-bundle.js";
import { SANDBOX_CREDENTIAL_VARS } from "../src/agents/claude.js";
import { DEFAULT_IMAGE } from "../src/sandbox/image.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ah-doctor-"));

test("unfilledBindings: clean pipeline has no offenders", () => {
  const pipeline = [
    { id: "code", sourceLabel: "agent:code", successLabel: "agent:review", failureLabel: "agent:blocked" },
    { id: "review", sourceLabel: "agent:review", successLabel: "agent:qc", failureLabel: "agent:blocked" },
  ];
  assert.deepEqual(unfilledBindings(pipeline), []);
});

test("unfilledBindings: flags TODO_* placeholders from init scaffold", () => {
  const pipeline = [
    { id: "code", sourceLabel: "TODO_SOURCE_LABEL", successLabel: "TODO_REVIEW_LABEL", failureLabel: "TODO_BLOCKED_LABEL" },
  ];
  assert.deepEqual(unfilledBindings(pipeline), [
    "code.sourceLabel",
    "code.successLabel",
    "code.failureLabel",
  ]);
});

test("unfilledBindings: flags empty/whitespace bindings", () => {
  const pipeline = [
    { id: "code", sourceSectionGid: "12", successSectionGid: "", failureSectionGid: "   " },
  ];
  assert.deepEqual(unfilledBindings(pipeline), ["code.successSectionGid", "code.failureSectionGid"]);
});

test("unfilledBindings: covers asana/jira/github binding names", () => {
  const pipeline = [
    { id: "a", sourceSectionGid: "TODO_X", successStatus: "TODO_Y", failureLabel: "TODO_Z", holdSectionGid: "TODO_W" },
  ];
  assert.deepEqual(unfilledBindings(pipeline), [
    "a.sourceSectionGid",
    "a.successStatus",
    "a.failureLabel",
    "a.holdSectionGid",
  ]);
});

test("unfilledBindings: ignores non-binding keys and absent optional bindings", () => {
  const pipeline = [
    { id: "code", kind: "implement", instructionsFile: "TODO_not_a_binding.md", createsWorktree: true, sourceLabel: "agent:code", successLabel: "agent:review" },
  ];
  // instructionsFile starts with TODO_ but is not a source*/success*/failure*/hold* binding; absent failureLabel is fine.
  assert.deepEqual(unfilledBindings(pipeline), []);
});

test("unfilledBindings: tolerates null/empty pipeline", () => {
  assert.deepEqual(unfilledBindings(null), []);
  assert.deepEqual(unfilledBindings([]), []);
});

// --- multi-repo lints (#82) ---

const mono = { id: "mono", path: "/w/acme", match: [], default: true };
const ios = { id: "ios", path: "/w/acme-ios", match: ["ios"] };
const held = [{ id: "code", sourceLabel: "a", holdLabel: "agent:hold" }, { id: "done", manual: true }];
/** @param {any} over */
const multi = (over = {}) =>
  /** @type {any} */ ({ repoPath: mono.path, multiRepo: true, repos: [mono, ios], providerConfig: { routeField: "Platform" }, pipeline: held, ...over });
/** @param {any[]} lints */
const labels = (lints) => lints.map((l) => `${l.level}:${l.label}`);

test("repoLints: a well-formed multi-repo cfg is clean", () => {
  assert.deepEqual(repoLints(multi()), []);
});

test("repoLints: 2 repos with no routeField → fail", () => {
  assert.deepEqual(labels(repoLints(multi({ providerConfig: {} }))), ["fail:tracker.routeField set"]);
});

test("repoLints: no default repo → warn", () => {
  const lints = repoLints(multi({ repos: [{ ...mono, default: undefined }, ios] }));
  assert.deepEqual(labels(lints), ["warn:a default repo is set"]);
  assert.match(lints[0].note, /every unrouted ticket will HOLD/);
});

test("repoLints: a non-manual step with no hold binding → warn naming it", () => {
  const lints = repoLints(multi({ pipeline: [...held, { id: "review", sourceLabel: "r", holdLabel: " " }] }));
  assert.deepEqual(labels(lints), ["warn:steps have a hold binding"]);
  assert.match(lints[0].note, /^review /);
});

test("repoLints: a single-repo cfg produces no repo lints", () => {
  const cfg = /** @type {any} */ ({ repoPath: "/a/repo", multiRepo: false, repos: [{ id: "default", path: "/a/repo", match: [], default: true }], providerConfig: {}, pipeline: [{ id: "code" }] });
  assert.deepEqual(repoLints(cfg), []);
});

test("forgeLints: github tracker with no forge block → one warning", () => {
  const lints = forgeLints(/** @type {any} */ ({ provider: "github", forge: undefined }));
  assert.deepEqual(labels(lints), ["warn:forge configured"]);
});

test("forgeLints: github tracker with a forge block → none", () => {
  assert.deepEqual(forgeLints(/** @type {any} */ ({ provider: "github", forge: { type: "github" } })), []);
});

test("forgeLints: non-github tracker with no forge → none", () => {
  assert.deepEqual(forgeLints(/** @type {any} */ ({ provider: "asana", forge: undefined })), []);
  assert.deepEqual(forgeLints(/** @type {any} */ ({ provider: "jira", forge: undefined })), []);
});

test("forgeLints: gitlab forge with project + token → none; missing/bad project, token or baseUrl → warnings", () => {
  const gl = (/** @type {any} */ f) => forgeLints(/** @type {any} */ ({ provider: "jira", forge: { type: "gitlab", project: "g/p", token: "glpat", ...f } }));
  assert.deepEqual(gl({}), []);
  assert.deepEqual(gl({ baseUrl: "https://git.acme.io" }), []);
  assert.deepEqual(labels(gl({ project: undefined })), ["warn:forge.project set"]);
  assert.deepEqual(labels(gl({ project: "proj" })), ["warn:forge.project set"]);
  assert.deepEqual(labels(gl({ token: "" })), ["warn:forge.token set"]);
  assert.deepEqual(labels(gl({ token: "${GITLAB_TOKEN}" })), ["warn:forge.token set"]);
  assert.deepEqual(labels(gl({ baseUrl: "gitlab.acme.io" })), ["warn:forge.baseUrl is an http(s) URL"]);
  assert.deepEqual(labels(forgeLints(/** @type {any} */ ({ provider: "github", forge: { type: "gitlab" } }))), ["warn:forge.project set", "warn:forge.token set"]);
});

test("legacyOrphans: flags <base>/42, not <base>/ios/42", () => {
  const cfg = multi();
  const base = worktreeDir(cfg, ios);
  const paths = [ios.path, path.join(base, "42"), path.join(base, "ios", "42")];
  assert.deepEqual(legacyOrphans(cfg, ios, paths), [path.join(base, "42")]);
  assert.deepEqual(legacyOrphans({ ...cfg, multiRepo: false }, ios, paths), []);
});

test("agentBinChecks: each non-manual step's binary resolved like dispatch, grouped with its agent + steps", () => {
  const cfg = /** @type {any} */ ({
    claudeBin: "claude",
    pipeline: [
      { id: "triage", agent: "hermes" },
      { id: "code" },
      { id: "local", bin: "claude-local" },
      { id: "review", agent: "cursor" }, // no bin → cursor's default "agent"
      { id: "fix" },
      { id: "done", manual: true, bin: "ignored" },
    ],
  });
  assert.deepEqual(agentBinChecks(cfg), [
    { bin: "hermes", agent: "hermes", steps: ["triage"] },
    { bin: "claude", agent: "claude", steps: ["code", "fix"] },
    { bin: "claude-local", agent: "claude", steps: ["local"] },
    { bin: "agent", agent: "cursor", steps: ["review"] },
  ]);
  // the profile agent applies to steps naming none; an explicit step bin still wins
  assert.deepEqual(agentBinChecks(/** @type {any} */ ({ claudeBin: "claude", agent: "cursor", pipeline: [{ id: "a" }, { id: "b", bin: "/opt/agent2" }] })), [
    { bin: "agent", agent: "cursor", steps: ["a"] },
    { bin: "/opt/agent2", agent: "cursor", steps: ["b"] },
  ]);
  // no claude step → claudeBin is not among the checks (doctor only warns on it)
  assert.ok(!agentBinChecks(/** @type {any} */ ({ claudeBin: "claude", agent: "hermes", pipeline: [{ id: "a" }] })).some((c) => c.bin === "claude"));
});

test("agentLints: warns only for a text-only agent (hermes) with requireVerdict:false set explicitly", () => {
  const cfg = /** @type {any} */ ({
    pipeline: [
      { id: "h-off", agent: "hermes", requireVerdict: false },
      { id: "h-unset", agent: "hermes" },
      { id: "h-on", agent: "hermes", requireVerdict: true },
      { id: "c-off", agent: "cursor", requireVerdict: false },
      { id: "cl-off", requireVerdict: false },
      { id: "m", agent: "hermes", manual: true, requireVerdict: false },
    ],
  });
  const lints = agentLints(cfg);
  assert.equal(lints.length, 1);
  assert.equal(lints[0].level, "warn");
  assert.match(lints[0].label, /h-off/);
  assert.equal(agentLints(/** @type {any} */ ({ agent: "hermes", pipeline: [{ id: "x", requireVerdict: false }] })).length, 1, "profile agent counts");
});

test("policyLints: ✗ an unenforceable policy, ⚠ code runners / no sandbox / missing git, ℹ the claude rules", () => {
  /** @param {any} cfg */
  const lints = (cfg) => policyLints(cfg);
  /** @param {any[]} ls @param {string} level @param {RegExp} re */
  const has = (ls, level, re) => ls.some((l) => l.level === level && re.test(`${l.label} ${l.note}`));

  const h = lints({ pipeline: [{ id: "rev", kind: "review", agent: "hermes", allow: { commands: ["git"] } }] });
  assert.ok(has(h, "fail", /step "rev" allow policy hermes cannot enforce it — runs of this step are refused/));
  assert.ok(!h.some((l) => l.level === "info"), "no claude rules for a refused step");

  const node = lints({ pipeline: [{ id: "rev", kind: "review", allow: { commands: ["node"] } }] });
  assert.ok(has(node, "warn", /"node" lets the agent run arbitrary code/));
  assert.ok(has(lints({ pipeline: [{ id: "rev", kind: "review", allow: { commands: ["npm run build"] } }] }), "warn", /"npm run build" lets the agent run arbitrary code/));
  assert.ok(!has(lints({ pipeline: [{ id: "rev", kind: "review", allow: { commands: ["gh pr"] } }] }), "warn", /arbitrary code/));

  const sandbox = /without a sandbox the allow policy is advisory/;
  assert.ok(has(node, "warn", sandbox));
  assert.ok(!has(lints({ sandbox: { type: "docker" }, pipeline: [{ id: "rev", kind: "review", allow: { commands: ["git"] } }] }), "warn", sandbox));
  assert.ok(has(lints({ sandbox: { type: "docker" }, pipeline: [{ id: "rev", kind: "review", sandbox: false, allow: { commands: ["git"] } }] }), "warn", sandbox));

  const wt = lints({ forge: { type: "github" }, pipeline: [{ id: "code", createsWorktree: true, allow: { commands: ["npm test"] } }] });
  assert.ok(has(wt, "warn", /no "git" entry — the prompt asks for it/));
  assert.ok(has(wt, "warn", /no "gh" entry — the prompt asks for it/));
  const okWt = lints({ forge: { type: "github" }, pipeline: [{ id: "code", createsWorktree: true, allow: { commands: ["git", "gh pr"] } }] });
  assert.ok(!has(okWt, "warn", /the prompt asks for it/));

  const info = lints({ pipeline: [{ id: "rev", kind: "review", allow: { commands: ["git"], paths: ["src/**"] }, deny: { commands: ["curl"] } }] }).find((l) => l.level === "info");
  assert.equal(info?.label, 'step "rev" claude rules');
  assert.equal(info?.note, "--setting-sources user,project --permission-mode dontAsk --allowedTools Read(//<cwd>/**) Bash(git) Bash(git *) Edit(//<cwd>/src/**) Edit(//<verdictFile>) --disallowedTools Bash(curl) Bash(curl *) Edit(//<cwd>/.claude/settings.json) Edit(//<cwd>/.claude/settings.local.json)");
  // A deny-only step under fullAuto previews the bypass tail; without fullAuto, the pinned one.
  const deny = { pipeline: [{ id: "rev", kind: "review", deny: { commands: ["curl"] } }] };
  assert.equal(lints({ ...deny, fullAuto: true }).find((l) => l.level === "info")?.note, "--dangerously-skip-permissions --disallowedTools Bash(curl) Bash(curl *)");
  assert.match(String(lints(deny).find((l) => l.level === "info")?.note), /^--setting-sources user,project --permission-mode dontAsk --allowedTools Edit\(\/\/<verdictFile>\) --disallowedTools Bash\(curl\) Bash\(curl \*\) Edit/);

  assert.deepEqual(lints({ pipeline: [{ id: "code", createsWorktree: true }, { id: "m", manual: true }] }), []);
});

test("portCheck: busy + this profile up → info, names the pid", () => {
  const r = portCheck({ port: 4180, busy: true, profile: { up: true, pid: 123, heartbeatPort: 4180 } });
  assert.equal(r.level, "info");
  assert.match(r.label, /123/);
});

test("portCheck: busy + profile down → fail", () => {
  const r = portCheck({ port: 4180, busy: true, profile: { up: false, pid: 0, heartbeatPort: null } });
  assert.equal(r.level, "fail");
  assert.equal(r.note, "something is already listening");
});

test("portCheck: free + down → ok", () => {
  assert.equal(portCheck({ port: 4180, busy: false, profile: { up: false, pid: 0, heartbeatPort: null } }).level, "ok");
});

test("portCheck: free + up → ok", () => {
  assert.equal(portCheck({ port: 4180, busy: false, profile: { up: true, pid: 123, heartbeatPort: 4180 } }).level, "ok");
});

test("portCheck: busy + up but heartbeat on a different port → fail", () => {
  const r = portCheck({ port: 4180, busy: true, profile: { up: true, pid: 123, heartbeatPort: 9999 } });
  assert.equal(r.level, "fail");
});

test("claimedPortLint: another registered profile's port → warn naming it", () => {
  const findings = claimedPortLint(4180, [{ port: 4180, stateKey: "other", name: "other" }]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].level, "warn");
  assert.match(findings[0].label, /other/);
});

test("claimedPortLint: no collision → no findings", () => {
  assert.deepEqual(claimedPortLint(4180, [{ port: 9999, stateKey: "other", name: "other" }]), []);
  assert.deepEqual(claimedPortLint(4180, []), []);
});

test("runChecks: warns when cfg.port is also claimed by another registered profile, excluding the current one", () => {
  const { cfg } = cleanProfile();
  const claimedPorts = ({ exclude } = {}) => [
    { port: cfg.port, stateKey: "other", name: "other-profile" },
    { port: cfg.port, stateKey: cfg.stateKey, name: cfg.name }, // the current profile — excluded by caller
  ].filter((c) => c.stateKey !== exclude?.stateKey);
  const checks = runChecks(cfg, io({ claimedPorts }));
  return checks.then((checks) => {
    const found = checks.find((c) => c.warn && /other-profile/.test(c.label));
    assert.ok(found, "expected a warning naming other-profile");
  });
});

test("runChecks: no claimed-port warning when nothing collides", async () => {
  const { cfg } = cleanProfile();
  const checks = await runChecks(cfg, io({ claimedPorts: () => [] }));
  assert.ok(!checks.some((c) => c.warn && /is also configured by profile/.test(c.label)));
});

test("uiBundleState: no ui/src → no-src, quiet even with no dist", () => {
  const srcDir = path.join(tmp(), "absent-src");
  const distDir = tmp();
  assert.deepEqual(uiBundleState({ srcDir, distDir }), { state: "no-src" });
});

test("uiBundleState: ui/src present, no dist/index.html → missing", () => {
  const srcDir = tmp();
  fs.writeFileSync(path.join(srcDir, "App.tsx"), "x");
  const distDir = tmp();
  assert.deepEqual(uiBundleState({ srcDir, distDir }), { state: "missing" });
});

test("uiBundleState: a src file newer than dist/index.html → stale, names it", () => {
  const srcDir = tmp();
  const distDir = tmp();
  const indexPath = path.join(distDir, "index.html");
  fs.writeFileSync(indexPath, "<!doctype html>");
  const old = new Date(Date.now() - 10000);
  fs.utimesSync(indexPath, old, old);
  const appPath = path.join(srcDir, "App.tsx");
  fs.writeFileSync(appPath, "x");
  const r = uiBundleState({ srcDir, distDir });
  assert.equal(r.state, "stale");
  assert.equal(r.newest, "App.tsx");
});

test("uiBundleState: only a newer *.test.tsx → fresh (test files aren't bundled)", () => {
  const srcDir = tmp();
  const distDir = tmp();
  const indexPath = path.join(distDir, "index.html");
  fs.writeFileSync(indexPath, "<!doctype html>");
  const old = new Date(Date.now() - 10000);
  fs.utimesSync(indexPath, old, old);
  fs.writeFileSync(path.join(srcDir, "App.test.tsx"), "x");
  assert.equal(uiBundleState({ srcDir, distDir }).state, "fresh");
});

test("uiBundleState: everything older than dist → fresh", () => {
  const srcDir = tmp();
  const distDir = tmp();
  const appPath = path.join(srcDir, "App.tsx");
  fs.writeFileSync(appPath, "x");
  const old = new Date(Date.now() - 10000);
  fs.utimesSync(appPath, old, old);
  const indexPath = path.join(distDir, "index.html");
  fs.writeFileSync(indexPath, "<!doctype html>");
  assert.equal(uiBundleState({ srcDir, distDir }).state, "fresh");
});

// --- doctor --fix (#446) ---

const POSIX = process.platform !== "win32";
const DEAD_PID = 2 ** 30; // above any pid_max: process.kill(…, 0) → ESRCH
/** @param {string} cwd @param {string[]} a */
const git = (cwd, a) => execFileSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...a], { encoding: "utf8" });
let seq = 0;

/** A clean, loaded local profile: tmp root holding a git repo (`root/repo`, one commit), the
 * config + instruction files beside it (one under `prompts/`), a 0700 state dir and the default
 * worktree base (`root/repo-worktrees`). Each test then breaks exactly what it fixes.
 * @param {Record<string, any>} [over] extra top-level config keys */
function cleanProfile(over = {}) {
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
function recorder(run = false) {
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
const io = (over = {}) => ({ userClaudeSettings: null, onPath: () => true, portInUse: async () => false, uiBundle: () => ({ state: "fresh" }), spawn: recorder().spawn, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" }, ...over });

/** @param {import('../src/commands/doctor.js').Check} c */
const problem = (c) => !c.info && (!c.ok || !!c.warn);
const silent = { log: () => {} };

/** name → mtime + mode for everything under each dir (missing dirs → nothing). @param {string[]} dirs */
function snapshot(dirs) {
  /** @type {Record<string, string>} */
  const out = {};
  /** @param {string} p */
  const walk = (p) => {
    let st;
    try {
      st = fs.lstatSync(p);
    } catch {
      return;
    }
    out[p] = `${st.mtimeMs}:${st.mode}`;
    if (st.isDirectory()) for (const e of fs.readdirSync(p)) walk(path.join(p, e));
  };
  dirs.forEach(walk);
  return out;
}

/** The shared fixer contract: exactly one fixable problem (matching `label`) before → `fixed:` →
 * none after → a second `--fix` finds nothing and changes nothing.
 * @param {any} cfg @param {RegExp} label @param {any} opts @param {string[]} watch dirs to snapshot */
async function fixCycle(cfg, label, opts, watch) {
  const before = await runChecks(cfg, opts);
  assert.deepEqual(before.filter(problem).map((c) => c.label).filter((l) => label.test(l)).length, 1, "detected");
  assert.equal(before.filter(problem).length, 1, `only the planted problem: ${before.filter(problem).map((c) => c.label)}`);
  assert.equal(fixableCount(before), 1);
  const lines = await applyFixes(before, silent);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^fixed: /);
  const after = await runChecks(cfg, opts);
  assert.deepEqual(after.filter(problem), [], "clean after the fix");
  const snap = snapshot(watch);
  assert.deepEqual(await applyFixes(after, silent), [], "second run detects nothing");
  assert.deepEqual(snapshot(watch), snap, "second run changes nothing");
}

/** Leave a unix socket file with no listener (a SIGKILLed child can't unlink it). @param {string} sock */
function deadSocket(sock) {
  spawnSync(process.execPath, ["-e", `require("net").createServer().listen(${JSON.stringify(sock)}, () => process.kill(process.pid, "SIGKILL"))`]);
  assert.ok(fs.existsSync(sock), "socket file left behind");
}

test("doctor --fix: a clean profile has no problems and nothing to fix", async () => {
  const { cfg } = cleanProfile();
  const checks = await runChecks(cfg, io());
  assert.deepEqual(checks.filter(problem), []);
  assert.deepEqual(await applyFixes(checks, silent), []);
});

test("doctor --fix: state dir with group/other bits → chmod 0700", { skip: !POSIX }, async () => {
  const { cfg } = cleanProfile();
  fs.chmodSync(cfg.stateDir, 0o755);
  await fixCycle(cfg, /^state dir is private/, io(), [cfg.stateDir]);
  assert.equal(fs.statSync(cfg.stateDir).mode & 0o777, 0o700);
});

test("doctor --fix: a missing state dir is ℹ, not a problem", async () => {
  const { cfg } = cleanProfile();
  fs.rmSync(cfg.stateDir, { recursive: true });
  const checks = await runChecks(cfg, io());
  assert.deepEqual(checks.filter(problem), []);
  assert.ok(checks.some((c) => c.info && /state dir not created yet/.test(c.label)));
});

test("doctor --fix: pidfile naming a dead pid → removed", async () => {
  const { cfg } = cleanProfile();
  fs.writeFileSync(cfg.pidFile, `${DEAD_PID}\n`);
  await fixCycle(cfg, /^stale pidfile$/, io(), [cfg.stateDir]);
  assert.ok(!fs.existsSync(cfg.pidFile));
});

test("doctor --fix: a live pid's pidfile is left alone", async () => {
  const { cfg } = cleanProfile();
  fs.writeFileSync(cfg.pidFile, `${process.pid}\n`);
  const checks = await runChecks(cfg, io({ portInUse: async () => false }));
  assert.ok(!checks.some((c) => /pidfile/.test(c.label)));
});

test("doctor --fix: control.sock with no listener and no live pid → removed", { skip: !POSIX }, async () => {
  const { cfg } = cleanProfile();
  deadSocket(cfg.controlSock);
  await fixCycle(cfg, /^stale control socket$/, io(), [cfg.stateDir]);
  assert.ok(!fs.existsSync(cfg.controlSock));
});

test("doctor --fix: a listening control.sock (receiver booting, no pid yet) is not stale", { skip: !POSIX }, async () => {
  const { cfg } = cleanProfile();
  const server = net.createServer((s) => s.destroy());
  await new Promise((r) => server.listen(cfg.controlSock, () => r(undefined)));
  try {
    const checks = await runChecks(cfg, io());
    assert.ok(!checks.some((c) => /control socket/.test(c.label)), "not flagged");
    assert.deepEqual(await applyFixes(checks, silent), []);
    assert.ok(fs.existsSync(cfg.controlSock), "not removed");
  } finally {
    await new Promise((r) => server.close(() => r(undefined)));
  }
});

test("doctor --fix: a missing instruction file (and its dir) → created from INSTRUCTIONS.example.md", async () => {
  const { cfg, root } = cleanProfile();
  fs.rmSync(path.join(root, "prompts"), { recursive: true });
  const target = path.join(root, "prompts", "CODE.md");
  await fixCycle(cfg, /^instructions file exists: .*CODE\.md$/, io(), [root]);
  assert.equal(fs.readFileSync(target, "utf8"), fs.readFileSync(path.join(cfg.installDir, "INSTRUCTIONS.example.md"), "utf8"));
});

test("doctor --fix: a missing instruction file is ⚠ (runs get empty instructions); the SOUL file is never checked", async () => {
  const { cfg, root } = cleanProfile();
  fs.rmSync(path.join(root, "INSTRUCTIONS.md"));
  const lints = instructionLints(cfg);
  assert.deepEqual(lints.map((l) => [l.level, l.label]), [["warn", `instructions file exists: ${path.join(root, "INSTRUCTIONS.md")}`]]);
  assert.ok(!fs.existsSync(cfg.digest.soul), "no SOUL.md, yet no lint for it");
});

test("doctor --fix: never overwrites an instruction file (incl. one created after detection)", async () => {
  const { cfg, root } = cleanProfile();
  const code = path.join(root, "prompts", "CODE.md");
  const dflt = path.join(root, "INSTRUCTIONS.md");
  fs.rmSync(code);
  const keep = fs.readFileSync(dflt);
  const [lint] = instructionLints(cfg);
  fs.writeFileSync(code, "written in between\n"); // a race: the file appears before apply runs
  await /** @type {any} */ (lint.fix).apply(); // EEXIST counts as fixed — no throw, no overwrite
  assert.equal(fs.readFileSync(code, "utf8"), "written in between\n");
  fs.rmSync(code);
  await applyFixes(await runChecks(cfg, io()), silent);
  assert.deepEqual(fs.readFileSync(dflt), keep, "existing file byte-identical");
});

test("doctor --fix: a missing worktree base → created", async () => {
  const { cfg } = cleanProfile();
  const base = worktreeDir(cfg);
  fs.rmSync(base, { recursive: true });
  await fixCycle(cfg, /^worktree base exists: /, io(), [path.dirname(base)]);
  assert.ok(fs.statSync(base).isDirectory());
});

test("doctor --fix: a prunable worktree under the base → `git -C <repo> worktree prune`, branch kept", async () => {
  const { cfg, repo } = cleanProfile();
  const wt = path.join(worktreeDir(cfg), "42");
  git(repo, ["worktree", "add", "-q", "-b", "agent/42", wt]);
  fs.rmSync(wt, { recursive: true });
  const rec = recorder(true);
  await fixCycle(cfg, /^prunable worktrees$/, io({ spawn: rec.spawn }), [worktreeDir(cfg)]);
  assert.deepEqual(rec.calls, [{ cmd: "git", args: ["-C", repo, "worktree", "prune"], cwd: undefined }]);
  assert.ok(!git(repo, ["worktree", "list", "--porcelain"]).includes(wt), "admin entry gone");
  assert.equal(git(repo, ["branch", "--list", "agent/42"]).trim(), "agent/42", "branch kept");
});

test("doctor --fix: a UI bundle the build can't fix → can't fix with the manual command", async () => {
  const { cfg } = cleanProfile();
  const checks = await runChecks(cfg, io({ uiBundle: () => ({ state: "missing" }), spawn: () => ({ status: 1 }) }));
  assert.deepEqual(await applyFixes(checks, silent), [`can't fix: UI bundle built — run \`npm run build:ui\` in ${cfg.installDir}`]);
});

/** A profile with every auto-fixable problem planted at once. */
function brokenProfile() {
  const p = cleanProfile();
  const { cfg, root, repo } = p;
  if (POSIX) fs.chmodSync(cfg.stateDir, 0o755);
  fs.writeFileSync(cfg.pidFile, `${DEAD_PID}\n`);
  if (POSIX) deadSocket(cfg.controlSock);
  fs.rmSync(path.join(root, "prompts"), { recursive: true });
  const wt = path.join(worktreeDir(cfg), "7");
  git(repo, ["worktree", "add", "-q", "-b", "agent/7", wt]);
  fs.rmSync(worktreeDir(cfg), { recursive: true }); // base missing + its worktree prunable
  return p;
}

test("doctor --fix --dry-run: one `would fix:` line per fixable problem, zero side effects", async () => {
  const { cfg, root, repo } = brokenProfile();
  const rec = recorder();
  const opts = io({ uiBundle: () => ({ state: "stale", newest: "App.tsx" }), spawn: rec.spawn });
  const checks = await runChecks(cfg, opts);
  const watch = [cfg.stateDir, root, ...instructionTargets(cfg).map((t) => t.path)];
  const snap = snapshot(watch);
  const lines = await applyFixes(checks, { dryRun: true, log: () => {} });
  assert.equal(lines.length, POSIX ? 7 : 5);
  assert.ok(lines.every((l) => l.startsWith("would fix: ")), lines.join("\n"));
  assert.ok(lines.includes(`would fix: prunable worktrees — git -C ${repo} worktree prune`));
  assert.deepEqual(snapshot(watch), snap);
  assert.deepEqual(rec.calls, [], "no child process spawned");
});

test("doctor --fix: every apply writes only inside the state dir, a worktree base, or a missing instruction path", async () => {
  const { cfg, repo } = brokenProfile();
  const rec = recorder();
  const checks = await runChecks(cfg, io({ uiBundle: () => ({ state: "missing" }), spawn: rec.spawn }));
  const missing = instructionTargets(cfg).filter((t) => t.scope !== "soul" && !fs.existsSync(t.path)).map((t) => t.path);
  assert.ok(missing.length);
  const allowed = new Set([...missing, ...missing.map((m) => path.dirname(m))]);
  const roots = [cfg.stateDir, worktreeDir(cfg)];
  /** @param {string} p */
  const ok = (p) => allowed.has(path.resolve(p)) || roots.some((r) => path.resolve(p) === r || path.resolve(p).startsWith(r + path.sep));

  /** @type {string[]} */
  const touched = [];
  const f = /** @type {any} */ (fs);
  const names = ["writeFileSync", "copyFileSync", "mkdirSync", "rmSync", "chmodSync", "renameSync", "openSync", "appendFileSync", "unlinkSync", "rmdirSync"];
  const orig = Object.fromEntries(names.map((n) => [n, f[n]]));
  for (const n of names) {
    f[n] = (/** @type {any[]} */ ...a) => {
      const writeFlag = n !== "openSync" || /[wa+]/.test(String(a[1] ?? "r"));
      if (writeFlag) touched.push(String(n === "copyFileSync" || n === "renameSync" ? a[1] : a[0]));
      return orig[n].apply(fs, a);
    };
  }
  /** @type {string[]} */
  let lines;
  try {
    lines = await applyFixes(checks, silent);
  } finally {
    Object.assign(f, orig);
  }
  assert.ok(lines.every((l) => l.startsWith("fixed: ")), lines.join("\n"));
  assert.ok(touched.length);
  assert.deepEqual(touched.filter((p) => !ok(p)), [], "every write is confined");
  assert.deepEqual(rec.calls, [
    { cmd: "npm", args: ["run", "build:ui"], cwd: cfg.installDir },
    { cmd: "git", args: ["-C", repo, "worktree", "prune"], cwd: undefined },
  ]);
});

test("doctor --fix: token, binaries, port, bindings are never auto-fixed — `can't fix:` + the command, nothing written", async () => {
  const root = tmp();
  const file = path.join(root, "agenthook.config.json");
  const pipeline = [{ id: "code", sourceSectionGid: "TODO_SOURCE", successSectionGid: "2" }];
  fs.writeFileSync(file, JSON.stringify({ name: `ah-doctor-manual-${process.pid}`, repoPath: root, ingress: { type: "manual", url: "http://x" }, tracker: { type: "asana", token: "", pipeline } }));
  fs.writeFileSync(path.join(root, ".env"), "OTHER=1\n");
  fs.writeFileSync(path.join(root, "INSTRUCTIONS.md"), "rules\n");
  const cfg = loadConfig({ configPath: file });
  const checks = await runChecks(cfg, io({ onPath: () => false, portInUse: async () => true, isAlive: () => false }));
  const snap = snapshot([root]);
  const lines = await applyFixes(checks, silent);
  assert.deepEqual(snapshot([root]), snap, "no file under the config dir (incl. .env) written");
  assert.ok(lines.every((l) => l.startsWith("can't fix: ")), lines.join("\n"));
  for (const want of [
    /^can't fix: tracker token resolved \(asana\) — set tracker\.token to a \$\{VAR\} ref, .*re-run doctor$/,
    /^can't fix: repoPath is a git repo: .* — point repoPath at a git checkout/,
    /^can't fix: claude binary on PATH: claude \(steps: code\) — install claude or put it on PATH$/,
    new RegExp(`^can't fix: port ${cfg.port} is free — stop whatever listens on port ${cfg.port}`),
    /^can't fix: pipeline bindings filled — fill code\.sourceSectionGid in the config/,
  ]) assert.ok(lines.some((l) => want.test(l)), `${want} in\n${lines.join("\n")}`);
  assert.equal(fixableCount(checks), 0);
});

test("doctor: the summary names how many problems --fix can handle, only when > 0", async () => {
  const { cfg } = cleanProfile();
  /** @param {any[]} checks */
  const out = (checks) => {
    /** @type {string[]} */
    const lines = [];
    report(checks, { log: (l) => lines.push(l) });
    return lines;
  };
  assert.ok(!out(await runChecks(cfg, io())).some((l) => /doctor --fix/.test(l)));
  fs.writeFileSync(cfg.pidFile, `${DEAD_PID}\n`);
  fs.rmSync(worktreeDir(cfg), { recursive: true });
  const lines = out(await runChecks(cfg, io()));
  assert.equal(lines.at(-1), "2 can be fixed with `agenthook doctor --fix`");
  assert.equal(lines.at(-2), "\nno problems; 2 warning(s).");
  assert.ok(!out(await runChecks(cfg, io())).slice(0, -1).some((l) => /doctor --fix/.test(l)));
  const quiet = [];
  report(await runChecks(cfg, io()), { hint: false, log: (l) => quiet.push(l) });
  assert.ok(!quiet.some((l) => /doctor --fix/.test(l)), "no hint in the post-fix report");
});

test("ingressChecks: tailscale needs only its binary, not ingress.url", () => {
  const seen = [];
  const checks = ingressChecks({ type: "tailscale" }, (bin) => (seen.push(bin), true));
  assert.deepEqual(checks, [{ ok: true, label: "tailscale binary on PATH", manual: "install tailscale or put it on PATH (or set $TAILSCALE)" }]);
  assert.deepEqual(seen, ["tailscale"]);
  assert.equal(ingressChecks({ type: "tailscale" }, () => false)[0].ok, false);
});

test("ingressLivenessLints: warns with a manual restart fix when up and ingressDown; [] otherwise", () => {
  const down = ingressLivenessLints({ up: true, heartbeat: { ingress: "cloudflared", ingressDown: { at: "2026-01-02T00:00:00.000Z", reason: "exited (1)" } } });
  assert.equal(down.length, 1);
  assert.equal(down[0].level, "warn");
  assert.match(down[0].label, /ingress tunnel is down/);
  assert.match(down[0].note, /cloudflared.*exited \(1\).*2026-01-02T00:00:00\.000Z/);
  assert.deepEqual(down[0].fix, { manual: "run `agenthook restart`" });

  assert.deepEqual(ingressLivenessLints({ up: false, heartbeat: { ingress: "cloudflared", ingressDown: { at: "x", reason: "y" } } }), []);
  assert.deepEqual(ingressLivenessLints({ up: true, heartbeat: { ingress: "cloudflared" } }), []);
  assert.deepEqual(ingressLivenessLints({ up: true, heartbeat: null }), []);
});

// --- GitHub App auth: key parses, installation token fetchable, assigneeLogin set ---

const APP_PEM = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" }).toString();
/** @param {any} [over] */
const appAuth = (over = {}) => ({ type: /** @type {const} */ ("app"), appId: "101", installationId: "202", privateKey: APP_PEM, ...over });
/** A mocked access_tokens endpoint answering `status`. @param {number} status */
const tokenFetch = (status) => {
  const calls = /** @type {string[]} */ ([]);
  /** @type {any} */
  const f = async (/** @type {string} */ url) => {
    calls.push(url);
    return status < 300
      ? { ok: true, status, json: async () => ({ token: "inst", expires_at: new Date(Date.now() + 3600e3).toISOString() }) }
      : { ok: false, status, json: async () => ({ message: "Integration not found" }) };
  };
  return { f, calls };
};

test("githubAppChecks: a parsing key, a fetchable installation token and assigneeLogin → three ✓", async () => {
  resetGithubAuthCache();
  const { f, calls } = tokenFetch(201);
  const checks = await githubAppChecks({ auth: appAuth({ privateKey: APP_PEM.replace(/\n/g, "\\n") }), assigneeLogin: "alice" }, "tracker", { fetch: f });
  assert.deepEqual(checks.map((c) => [c.ok, c.label]), [
    [true, "tracker GitHub App private key parses (app 101)"],
    [true, "tracker GitHub App installation token fetchable (installation 202)"],
    [true, "tracker.assigneeLogin set (the human the App acts for)"],
  ]);
  assert.deepEqual(calls, ["https://api.github.com/app/installations/202/access_tokens"]);
});

test("githubAppChecks: a bad key fails (and skips the live call); a missing assigneeLogin fails", async () => {
  resetGithubAuthCache();
  const { f, calls } = tokenFetch(201);
  const checks = await githubAppChecks({ auth: appAuth({ privateKey: "not a pem" }) }, "tracker", { fetch: f });
  assert.deepEqual(checks.map((c) => [c.ok, c.label.split(" (")[0]]), [
    [false, "tracker GitHub App private key parses"],
    [false, "tracker.assigneeLogin set"],
  ]);
  assert.equal(calls.length, 0);
  assert.ok(checks.every((c) => c.fix && "manual" in c.fix));
});

test("githubAppChecks: an installation token the API refuses fails with its status; the forge has no login check", async () => {
  resetGithubAuthCache();
  const checks = await githubAppChecks({ auth: appAuth() }, "forge", { fetch: tokenFetch(404).f });
  assert.deepEqual(checks.map((c) => c.ok), [true, false]);
  assert.match(String(checks[1].note), /installation token 404: Integration not found/);
});

test("runChecks under App auth: the App checks replace the token check, for the tracker and a github forge", async () => {
  resetGithubAuthCache();
  const { cfg } = cleanProfile();
  cfg.provider = "github";
  cfg.providerConfig = /** @type {any} */ ({ type: "github", repository: "o/r", auth: appAuth(), assigneeLogin: "alice", pipeline: cfg.pipeline });
  cfg.forge = /** @type {any} */ ({ type: "github", repository: "o/r", auth: appAuth() });
  const checks = await runChecks(cfg, io({ fetch: tokenFetch(201).f }));
  const labels = checks.map((c) => c.label);
  assert.ok(!labels.some((l) => l.startsWith("tracker token resolved")), labels.join("\n"));
  for (const l of ["tracker GitHub App private key parses", "tracker GitHub App installation token fetchable", "tracker.assigneeLogin set", "forge GitHub App private key parses", "forge GitHub App installation token fetchable"]) {
    const c = checks.find((x) => x.label.startsWith(l));
    assert.ok(c?.ok, `${l}: ${JSON.stringify(c)}`);
  }
});

// --- per-run GitHub App tokens (#474) ---

/** A mocked GitHub for the run-token check: the receiver mint answers 201; a scoped mint (a
 * body) answers `scoped`; DELETE /installation/token answers 204. @param {number} scoped */
const runTokenFetch = (scoped) => {
  const calls = /** @type {{url: string, method: string, body?: any}[]} */ ([]);
  /** @type {any} */
  const f = async (/** @type {string} */ url, /** @type {any} */ init = {}) => {
    calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : undefined });
    if (init.method === "DELETE") return { ok: true, status: 204, json: async () => ({}) };
    if (init.body && scoped >= 300) return { ok: false, status: scoped, json: async () => ({ message: "The permissions requested are not granted to this installation." }) };
    return { ok: true, status: 201, json: async () => ({ token: init.body ? "run" : "inst", expires_at: new Date(Date.now() + 3600e3).toISOString() }) };
  };
  return { f, calls };
};

test("githubAppChecks with runTokenRepo: mints an implement-scoped run token and revokes it at once → ✓", async () => {
  resetGithubAuthCache();
  const { f, calls } = runTokenFetch(201);
  const checks = await githubAppChecks({ auth: appAuth() }, "forge", { fetch: f, runTokenRepo: "o/r" });
  assert.deepEqual(checks.map((c) => [c.ok, c.label]), [
    [true, "forge GitHub App private key parses (app 101)"],
    [true, "forge GitHub App installation token fetchable (installation 202)"],
    [true, "forge GitHub App can mint agent run tokens (contents:write, pull_requests:write, issues:write)"],
  ]);
  assert.deepEqual(calls[1].body.repositories, ["r"]);
  assert.equal(calls[1].body.permissions.contents, "write");
  assert.deepEqual(calls[2], { url: "https://api.github.com/installation/token", method: "DELETE", body: undefined });
});

test("githubAppChecks with runTokenRepo: a 422 is ✗ with GitHub's message and the grant-permissions fix", async () => {
  resetGithubAuthCache();
  const { f } = runTokenFetch(422);
  const checks = await githubAppChecks({ auth: appAuth() }, "forge", { fetch: f, runTokenRepo: "o/r" });
  const c = checks[2];
  assert.equal(c.ok, false);
  assert.match(String(c.note), /422: The permissions requested are not granted/);
  assert.match(String(c.fix && "manual" in c.fix ? c.fix.manual : ""), /Contents: Read & write and Pull requests: Read & write \(docs\/github-app\.md#agent-run-tokens\)/);
});

test("runTokenLints: a PAT is an ℹ; App + githubRunToken:false and a step env GH_TOKEN are ⚠; a non-github origin is issues-only", () => {
  const base = /** @type {any} */ ({ provider: "github", providerConfig: { type: "github", token: "t" }, pipeline: [{ id: "code" }], repoPath: "/r" });
  const github = () => "o/r";
  assert.deepEqual(runTokenLints(base, { originRepo: github }), [{ level: "info", label: "agents use your personal GitHub token (no GitHub App)", note: "an App gives each run a 1h token scoped to one repo: docs/github-app.md#agent-run-tokens" }]);
  assert.deepEqual(runTokenLints({ ...base, provider: "asana", providerConfig: {} }, { originRepo: github }), [], "no GitHub anywhere");
  const app = { ...base, providerConfig: { type: "github", auth: appAuth(), assigneeLogin: "a" } };
  assert.deepEqual(runTokenLints(app, { originRepo: github }), []);
  assert.deepEqual(runTokenLints({ ...app, githubRunToken: false }, { originRepo: github }).map((l) => [l.level, l.label]), [["warn", "agents use your own GitHub credentials, not a scoped run token"]]);
  assert.deepEqual(runTokenLints({ ...app, pipeline: [{ id: "code", env: { GH_TOKEN: "${X}" } }] }, { originRepo: github }).map((l) => [l.level, l.label]), [["warn", `step "code" env GH_TOKEN overrides the per-run App token`]]);
  assert.deepEqual(runTokenLints(app, { originRepo: () => null }).map((l) => [l.level, l.label]), [["warn", `run tokens for "default" cover issues only; pushes use your own git credentials`]]);
  const forgeApp = { ...base, forge: { type: "github", repository: "o/r", auth: appAuth() } };
  assert.deepEqual(runTokenLints(forgeApp, { originRepo: () => null }), [], "an App forge falls back to its repository");
});

// --- sandboxChecks (a profile `sandbox` block) ---

/** @param {any} [over] */
const sbCfg = (over = {}) =>
  /** @type {any} */ ({
    claudeBin: "claude",
    sandbox: { type: "docker" },
    pipeline: [{ id: "code", env: { CLAUDE_CODE_OAUTH_TOKEN: "t" } }, { id: "done", manual: true }],
    ...over,
  });
/** @param {Record<string, number>} codes  "arg0" or "arg0 arg1" → exit code */
const sbRun = (codes = {}) => /** @type {import('../src/types.js').IngressRun} */ (async (_bin, args) => ({ code: codes[args.slice(0, 2).join(" ")] ?? codes[args[0]] ?? 0, stdout: "", stderr: "boom" }));

test("sandboxChecks: no sandbox block → no checks", async () => {
  assert.deepEqual(await sandboxChecks(sbCfg({ sandbox: undefined }), { run: sbRun(), has: () => true }), []);
});

test("sandboxChecks: a missing default image is ✗ with an apply fix that builds it from stdin", async () => {
  /** @type {any[]} */
  const builds = [];
  const checks = await sandboxChecks(sbCfg(), { run: sbRun({ "image inspect": 1 }), has: () => true, build: (bin, args, df) => (builds.push([bin, args, df]), { status: 0 }) });
  const img = checks.find((c) => c.label.startsWith("sandbox image present"));
  assert.equal(img?.ok, false);
  assert.ok(img?.fix && "apply" in img.fix);
  await /** @type {any} */ (img.fix).apply();
  assert.equal(builds[0][0], "docker");
  assert.deepEqual(builds[0][1].slice(0, 2), ["build", "-t"]);
  assert.match(builds[0][2], /^FROM node:22/);
  assert.match(checks.find((c) => c.label.includes("info"))?.note ?? "", /root-equivalent; prefer rootless podman/);
  const lines = await applyFixes(checks, { log: () => {} });
  assert.ok(lines.some((l) => l.startsWith("fixed: sandbox image present")));
});

test("sandboxChecks: each service image is checked (fix: pull it, never applied) and each sandboxed step's services listed as info", async () => {
  const cfg = sbCfg({
    sandbox: { type: "podman", egress: { mode: "open" }, services: { db: { image: "postgres:16.4" }, cache: { image: "redis:7.2" } } },
    pipeline: [{ id: "code", services: ["db", "cache"], env: { CLAUDE_CODE_OAUTH_TOKEN: "t" } }, { id: "review", env: { CLAUDE_CODE_OAUTH_TOKEN: "t" } }, { id: "done", manual: true }],
  });
  /** @type {string[][]} */
  const calls = [];
  const run = /** @type {import('../src/types.js').IngressRun} */ (async (_bin, args) => (calls.push(args), { code: args[2] === "redis:7.2" ? 1 : 0, stdout: "", stderr: "" }));
  const checks = await sandboxChecks(cfg, { run, has: () => true });
  const svc = checks.filter((c) => c.label.startsWith("sandbox service image present"));
  assert.deepEqual(svc.map((c) => [c.ok, c.label]), [[true, "sandbox service image present: postgres:16.4"], [false, "sandbox service image present: redis:7.2"]]);
  assert.deepEqual(svc[1].fix, { manual: "podman pull redis:7.2" });
  assert.deepEqual(checks.filter((c) => c.info).map((c) => c.label), ['step "code" services: db, cache']);
  assert.equal(fixableCount(checks), fixableCount(checks.filter((c) => !c.label.startsWith("sandbox service image"))), "a pull is never auto-applied");
});

test("sandboxChecks: runtime missing or down stops there", async () => {
  const off = await sandboxChecks(sbCfg(), { run: sbRun(), has: () => false });
  assert.equal(off.length, 1);
  assert.equal(off[0].ok, false);
  const down = await sandboxChecks(sbCfg(), { run: sbRun({ info: 1 }), has: () => true });
  assert.deepEqual(down.map((c) => c.ok), [true, false]);
});

test("sandboxRuntimeChecks: binary, info, then each image — a custom image's fix is manual, a missing default's builds", async () => {
  /** @type {string[][]} */
  const calls = [];
  const run = /** @type {import('../src/types.js').IngressRun} */ (async (_bin, args) => (calls.push(args), { code: args[2] === "mine:1" ? 1 : 0, stdout: "", stderr: "" }));
  const checks = await sandboxRuntimeChecks({ type: "podman", image: "mine:1" }, { run, has: () => true, images: ["mine:1", DEFAULT_IMAGE] });
  assert.deepEqual(checks.map((c) => [c.ok, c.label]), [
    [true, "sandbox: podman binary on PATH"],
    [true, "sandbox: `podman info` succeeds"],
    [false, "sandbox image present: mine:1"],
    [true, `sandbox image present: ${DEFAULT_IMAGE} (egress proxy)`],
  ]);
  assert.match(/** @type {any} */ (checks[2].fix).manual, /^build mine:1 \(FROM /);
  assert.ok(checks[3].fix && "apply" in checks[3].fix);
  assert.deepEqual(calls, [["info"], ["image", "inspect", "mine:1"], ["image", "inspect", DEFAULT_IMAGE]]);
  // images defaults to [image]; a down runtime stops before any inspect.
  assert.equal((await sandboxRuntimeChecks({ type: "docker", image: DEFAULT_IMAGE }, { run: sbRun(), has: () => true })).length, 3);
  assert.deepEqual((await sandboxRuntimeChecks({ type: "docker", image: DEFAULT_IMAGE }, { run: sbRun({ info: 1 }), has: () => true })).map((c) => c.ok), [true, false]);
});

test("sandboxChecks: a sandboxed hermes step ✗, a credential-less claude step ✗, an absolute claudeBin ⚠, sandbox:false skipped", async () => {
  // agentSpawnEnv reads the real process.env (#507) — clear every credential var sandboxCredentialProblem
  // checks, not just CLAUDE_CODE_OAUTH_TOKEN, so a host/sandbox shell with e.g. CLAUDE_CODE_USE_BEDROCK=1 set
  // doesn't make this "credential-less" step look credentialed.
  const saved = Object.fromEntries(SANDBOX_CREDENTIAL_VARS.map((k) => [k, process.env[k]]));
  SANDBOX_CREDENTIAL_VARS.forEach((k) => delete process.env[k]);
  try {
    const checks = await sandboxChecks(
      sbCfg({
        claudeBin: "/usr/local/bin/claude",
        pipeline: [{ id: "triage", agent: "hermes" }, { id: "code" }, { id: "host", agent: "cursor", sandbox: false }, { id: "done", manual: true }],
      }),
      { run: sbRun(), has: () => true },
    );
    const by = (/** @type {string} */ s) => checks.filter((c) => c.label.includes(s));
    assert.equal(by('step "triage"')[0].ok, false);
    assert.match(by('step "triage"')[0].note ?? "", /hermes does not support the sandbox yet/);
    const cred = by('step "code" has a claude credential')[0];
    assert.equal(cred.ok, false);
    assert.match(/** @type {any} */ (cred.fix).manual, /claude setup-token/);
    const abs = by('step "code" agent binary is a host path')[0];
    assert.equal(abs.warn, true);
    assert.equal(by('step "host"').length, 0, "an opted-out step is not sandbox-checked");
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v !== undefined) process.env[k] = v;
      else delete process.env[k];
    }
  }
});

test("sandboxChecks: allowlist with a custom image also checks the built-in image (the egress proxy), with the build fix", async () => {
  /** @type {string[]} */
  const inspected = [];
  /** @type {import('../src/types.js').IngressRun} */
  const run = async (_bin, args) => {
    if (args[0] === "image") inspected.push(args[2]);
    return { code: args[0] === "image" && args[2] !== "mine:1" ? 1 : 0, stdout: "", stderr: "" };
  };
  const checks = await sandboxChecks(sbCfg({ sandbox: { type: "docker", image: "mine:1" } }), { run, has: () => true });
  assert.deepEqual(inspected.length, 2);
  const proxy = checks.find((c) => c.label.endsWith("(egress proxy)"));
  assert.equal(proxy?.ok, false);
  assert.ok(proxy?.fix && "apply" in proxy.fix, "doctor --fix builds it");
  inspected.length = 0;
  await sandboxChecks(sbCfg({ sandbox: { type: "docker", image: "mine:1", egress: { mode: "open" } } }), { run, has: () => true });
  assert.deepEqual(inspected, ["mine:1"], "open: no proxy, so no built-in image needed");
});

test("egressLints: ⚠ open (profile or step), ⚠ loopback ANTHROPIC_BASE_URL, ℹ @npm for a package-lock.json, ℹ the effective allowlist", () => {
  const base = { provider: "github", providerConfig: {}, forge: { type: "github" } };
  const open = egressLints(sbCfg({ ...base, sandbox: { type: "docker", egress: { mode: "open" } } }), { env: {} });
  assert.ok(open.some((l) => l.level === "warn" && l.label === `sandbox egress mode is "open"` && /exfiltrate the worktree and its env/.test(l.note ?? "")));
  const stepOpen = egressLints(sbCfg({ ...base, pipeline: [{ id: "code", egress: { mode: "open" } }] }), { env: {} });
  assert.ok(stepOpen.some((l) => l.level === "warn" && l.label === `step "code" egress mode is "open"`));

  const loop = egressLints(sbCfg(base), { env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:11434" } });
  const lw = loop.find((l) => l.label.startsWith("ANTHROPIC_BASE_URL is loopback"));
  assert.equal(lw?.level, "warn");
  assert.match(lw?.note ?? "", /the sandbox cannot reach http:\/\/127\.0\.0\.1:11434; use a host-reachable address \(host\.docker\.internal \/ host\.containers\.internal\) and allow it/);
  const stepLoop = egressLints(sbCfg({ ...base, pipeline: [{ id: "code", env: { ANTHROPIC_BASE_URL: "http://localhost:8080" } }] }), { env: {} });
  assert.ok(stepLoop.some((l) => l.label === "ANTHROPIC_BASE_URL is loopback (steps: code)"));

  const npm = egressLints(sbCfg(base), { files: ["package-lock.json", "README.md"], env: {} });
  const hint = npm.find((l) => l.label.includes("package-lock.json"));
  assert.equal(hint?.level, "info");
  assert.match(hint?.note ?? "", /add "@npm" to sandbox\.egress\.allow/);
  assert.equal(egressLints(sbCfg({ ...base, sandbox: { type: "docker", egress: { allow: ["@npm"] } } }), { files: ["package-lock.json"], env: {} }).some((l) => l.label.includes("package-lock")), false, "already allowed");

  const rules = npm.find((l) => l.label === `step "code" egress allowlist`);
  assert.equal(rules?.level, "info");
  assert.match(rules?.note ?? "", /^api\.anthropic\.com, api\.github\.com, github\.com, uploads\.github\.com, \*\.githubusercontent\.com \+ the repo's origin host$/);
  assert.deepEqual(egressLints(sbCfg({ sandbox: undefined }), { env: {} }), []);

  // No forge block: the forge hosts come from the origin, as dispatch infers them.
  const noForge = { provider: "asana", providerConfig: {} };
  const inferred = egressLints(sbCfg(noForge), { env: {}, origins: ["git@github.com:o/r.git"] }).find((l) => l.label === `step "code" egress allowlist`);
  assert.match(inferred?.note ?? "", /^api\.anthropic\.com, app\.asana\.com, github\.com, api\.github\.com, uploads\.github\.com, \*\.githubusercontent\.com \+ the repo's origin host$/);
  const unknown = egressLints(sbCfg(noForge), { env: {}, origins: ["https://git.acme.io/o/r"] }).find((l) => l.label === `step "code" egress allowlist`);
  assert.match(unknown?.note ?? "", /^api\.anthropic\.com, app\.asana\.com \+ the repo's origin host$/);
});

test("agentBinChecks: a sandboxed step's binary resolves in the image, not on the host PATH", () => {
  const groups = agentBinChecks(/** @type {any} */ ({ claudeBin: "claude", sandbox: { type: "docker" }, pipeline: [{ id: "code" }, { id: "host", sandbox: false, bin: "claude-local" }] }));
  assert.deepEqual(groups, [{ bin: "claude-local", agent: "claude", steps: ["host"] }]);
});

// --- agent env lints (#470): names only, never values ---

/** A config file whose tracker token is `token` (tokenVar reads the raw file). @param {string} token */
function rawConfigFile(token) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-doctor-env-"));
  const file = path.join(dir, "agenthook.config.json");
  fs.writeFileSync(file, JSON.stringify({ tracker: { type: "github", token } }));
  return file;
}

/** @param {any} [over] @returns {any} */
const envCfg = (over = {}) => ({ provider: "local", pipeline: [{ id: "code" }, { id: "done", manual: true }], configPath: "/nonexistent.json", ...over });
const base = { PATH: "/usr/bin", HOME: "/home/u", LANG: "C.UTF-8" };
/** @param {any[]} ls */
const byLabel = (ls) => Object.fromEntries(ls.map((l) => [l.label, l]));

test("agentEnvLints: a plain claude profile gets nothing extra", () => {
  assert.deepEqual(agentEnvLints(envCfg(), { env: base, platform: "linux" }), []);
});

test("agentEnvLints: the migration view names the stripped credentials, never their values", () => {
  const ls = agentEnvLints(envCfg(), { env: { ...base, NGROK_AUTHTOKEN: "s3cr3t", ANTHROPIC_API_KEY: "sk" }, platform: "linux" });
  const got = byLabel(ls);
  assert.equal(got["agent env: not passed to agents"].level, "info");
  assert.equal(got["agent env: not passed to agents"].note, "NGROK_AUTHTOKEN");
  assert.equal(got["agent env: credentials agents still get"].note, "ANTHROPIC_API_KEY (claude)");
  assert.ok(!JSON.stringify(ls).includes("s3cr3t"), "no value is ever printed");
});

test("agentEnvLints: tags each passed credential with its source", () => {
  const ls = agentEnvLints(envCfg({ provider: "github", forge: { type: "github" }, agentEnvPassthrough: ["OPENAI_API_KEY"] }), {
    env: { ...base, GITHUB_TOKEN: "t", GH_TOKEN: "t", OPENAI_API_KEY: "k" },
    platform: "linux",
  });
  assert.equal(byLabel(ls)["agent env: credentials agents still get"].note, "GH_TOKEN (forge (gh)), GITHUB_TOKEN (tracker prompt, forge (gh)), OPENAI_API_KEY (agentEnvPassthrough)");
});

test("agentEnvLints: \"*\" warns that agents inherit everything", () => {
  const ls = agentEnvLints(envCfg({ agentEnvPassthrough: ["*"] }), { env: { ...base, NGROK_AUTHTOKEN: "x" }, platform: "linux" });
  assert.deepEqual(ls.map((l) => [l.level, l.label]), [["warn", `agent env: agentEnvPassthrough is "*"`]]);
  assert.match(ls[0].note ?? "", /whole environment, including NGROK_AUTHTOKEN/);
});

test("agentEnvLints: claude on Bedrock warns about the stripped AWS_* names", () => {
  const ls = agentEnvLints(envCfg(), { env: { ...base, CLAUDE_CODE_USE_BEDROCK: "1", AWS_ACCESS_KEY_ID: "a", AWS_REGION: "us-east-1" }, platform: "linux" });
  const w = byLabel(ls)["agent env: claude on Bedrock loses AWS credentials"];
  assert.equal(w.level, "warn");
  assert.match(w.note, /AWS_ACCESS_KEY_ID/);
  assert.match(w.fix.manual, /AWS_\* to agentEnvPassthrough/);
  // passed through → silent
  const ok = agentEnvLints(envCfg({ agentEnvPassthrough: ["AWS_*"] }), { env: { ...base, CLAUDE_CODE_USE_BEDROCK: "1", AWS_ACCESS_KEY_ID: "a" }, platform: "linux" });
  assert.equal(ok.some((l) => /Bedrock/.test(l.label)), false);
});

test("agentEnvLints: an opencode step warns about stripped provider keys", () => {
  const ls = agentEnvLints(envCfg({ agent: "opencode" }), { env: { ...base, OPENAI_API_KEY: "k" }, platform: "linux" });
  const w = byLabel(ls)["agent env: opencode provider keys stripped"];
  assert.equal(w.level, "warn");
  assert.match(w.note, /opencode may read provider keys from env: OPENAI_API_KEY/);
  // claude doesn't read OPENAI_API_KEY: only the info line
  assert.equal(agentEnvLints(envCfg(), { env: { ...base, OPENAI_API_KEY: "k" }, platform: "linux" }).some((l) => l.level === "warn"), false);
});

test("agentEnvLints: a ${GH_PAT} tracker token while the prompt names an unset $GITHUB_TOKEN", () => {
  const configPath = rawConfigFile("${GH_PAT}");
  const ls = agentEnvLints(envCfg({ provider: "github", configPath }), { env: { ...base, GH_PAT: "p" }, platform: "linux" });
  const w = ls.find((l) => /tracker token/.test(l.label));
  assert.equal(w?.level, "warn");
  assert.equal(w?.label, "agent env: tracker token is ${GH_PAT} but the prompt tells agents to use $GITHUB_TOKEN, which is unset");
  // GITHUB_TOKEN set, or the token is ${GITHUB_TOKEN} itself → silent
  assert.equal(agentEnvLints(envCfg({ provider: "github", configPath }), { env: { ...base, GH_PAT: "p", GITHUB_TOKEN: "t" }, platform: "linux" }).some((l) => /tracker token/.test(l.label)), false);
  assert.equal(agentEnvLints(envCfg({ provider: "github", configPath: rawConfigFile("${GITHUB_TOKEN}") }), { env: base, platform: "linux" }).some((l) => /tracker token/.test(l.label)), false);
});

test("agentEnvLints: git settings the agent loses", () => {
  const ls = agentEnvLints(envCfg(), { env: { ...base, GIT_SSH_COMMAND: "ssh -i k", GIT_CONFIG_COUNT: "1" }, platform: "linux" });
  assert.match(byLabel(ls)["agent env: git in the agent loses its settings"].note, /GIT_CONFIG_COUNT, GIT_SSH_COMMAND/);
});

test("ghAuthLints: runs gh auth status with the filtered agent env; a failure warns", () => {
  /** @type {any[]} */
  const calls = [];
  const spawn = (/** @type {string} */ cmd, /** @type {string[]} */ args, /** @type {any} */ opts) => (calls.push({ cmd, args, env: opts.env }), { status: 1 });
  const env = { ...base, SOME_SECRET: "x", GH_TOKEN: "g" };
  const ls = ghAuthLints(envCfg({ provider: "asana", forge: { type: "github" } }), { spawn, onPath: () => true, env, platform: "linux" });
  assert.deepEqual(calls.map((c) => [c.cmd, c.args]), [["gh", ["auth", "status"]]]);
  assert.equal("SOME_SECRET" in calls[0].env, false, "the receiver's secrets never reach the probe");
  assert.equal(calls[0].env.GH_TOKEN, "g", "the forge's GH_TOKEN does");
  assert.equal(calls[0].env.PATH, "/usr/bin");
  assert.deepEqual(ls.map((l) => [l.level, l.label]), [["warn", "gh is not authenticated for agents (they open and review PRs with gh)"]]);
  // authenticated → silent; local tracker → never probed; gh missing → one warn, no probe
  assert.deepEqual(ghAuthLints(envCfg({ provider: "asana" }), { spawn: () => ({ status: 0 }), onPath: () => true, env, platform: "linux" }), []);
  calls.length = 0;
  assert.deepEqual(ghAuthLints(envCfg(), { spawn, onPath: () => true, env, platform: "linux" }), []);
  assert.deepEqual(ghAuthLints(envCfg({ provider: "asana" }), { spawn, onPath: () => false, env, platform: "linux" }).map((l) => l.label), ["gh not on PATH"]);
  assert.equal(calls.length, 0);
});

// --- isolation report (#476) ---

/** isolationReport over a minimal config. @param {any} cfg @param {any} [o] */
const iso = (cfg, o = {}) => isolationReport(/** @type {any} */ ({ provider: "local", providerConfig: {}, pipeline: [{ id: "code" }, { id: "done", manual: true }], ...cfg }), { user: "ana", ...o });
/** The rows matching `re` (on label + note). @param {any[]} rows @param {RegExp} re */
const rowsOf = (rows, re) => rows.filter((r) => re.test(`${r.label} ${r.note}`));
const APP = { auth: { type: "app", appId: "1", installationId: "2", privateKey: "k" } };

test("isolationReport: every row is labeled isolation · and is info or warn, never fail", () => {
  for (const cfg of [{}, { fullAuto: true }, { fullAuto: true, sandbox: { type: "podman" } }]) {
    const rows = iso(cfg);
    assert.ok(rows.length >= 6);
    assert.ok(rows.every((r) => r.label.startsWith("isolation · ") && (r.level === "info" || r.level === "warn")), JSON.stringify(rows));
    assert.deepEqual([...new Set(rows.map((r) => r.label))], ["isolation · sandbox", "isolation · env", "isolation · egress", "isolation · credentials", "isolation · permissions", "isolation · untrusted input"]);
  }
});

test("isolationReport: sandbox row — none, ⚠ fullAuto without one, type + image, ⚠ a sandbox:false step under fullAuto", () => {
  assert.equal(rowsOf(iso({}), /sandbox none \(agents run on this host\)/).length, 1);
  assert.equal(rowsOf(iso({}), /fullAuto without a sandbox/).length, 0);
  const fa = rowsOf(iso({ fullAuto: true }), /fullAuto without a sandbox/);
  assert.equal(fa.length, 1);
  assert.equal(fa[0].level, "warn");
  assert.equal(fa[0].note, "fullAuto without a sandbox — a verified webhook runs code on this host as ana; see docs/sandbox.md");
  assert.match(iso({ sandbox: { type: "podman", image: "my:img" } })[0].note, /^podman, image my:img$/);
  assert.match(iso({ sandbox: { type: "docker" } })[0].note, /^docker, image agenthook-agent:/);
  const off = iso({ fullAuto: true, sandbox: { type: "podman" }, pipeline: [{ id: "triage", sandbox: false }, { id: "code" }, { id: "done", manual: true, sandbox: false }] });
  assert.deepEqual(rowsOf(off, /runs on the host under fullAuto/).map((r) => [r.level, r.note]), [["warn", 'step "triage" runs on the host under fullAuto']]);
});

test("isolationReport: env row — stripped (default / named passthrough), \"*\" not stripped (⚠ only under fullAuto)", () => {
  assert.equal(rowsOf(iso({}), /isolation · env/)[0].note, "stripped; passes through nothing extra");
  assert.equal(rowsOf(iso({ agentEnvPassthrough: ["FOO", "BAR_*"] }), /isolation · env/)[0].note, "stripped; passes through FOO, BAR_*");
  const star = rowsOf(iso({ agentEnvPassthrough: ["*"] }), /isolation · env/)[0];
  assert.deepEqual([star.level, star.note], ["info", `not stripped — agents inherit the receiver's full env ("*")`]);
  assert.equal(rowsOf(iso({ fullAuto: true, agentEnvPassthrough: ["*"] }), /isolation · env/)[0].level, "warn");
});

test("isolationReport: egress row — n/a without a sandbox, allowlist (defaults + N extra), none/open, step overrides; always info", () => {
  assert.equal(rowsOf(iso({}), /isolation · egress/)[0].note, "n/a (no sandbox — the host's network)");
  assert.equal(rowsOf(iso({ sandbox: { type: "podman" } }), /isolation · egress/)[0].note, "allowlist (defaults + 0 extra)");
  assert.equal(rowsOf(iso({ sandbox: { type: "podman", egress: { allow: ["npm"] } } }), /isolation · egress/)[0].note, "allowlist (defaults + 1 extra)");
  const open = rowsOf(iso({ sandbox: { type: "podman", egress: { mode: "open" } }, pipeline: [{ id: "a", egress: { mode: "none" } }, { id: "b" }] }), /isolation · egress/)[0];
  assert.deepEqual([open.level, open.note], ["info", "open; step overrides: a=none"]);
});

test("isolationReport: credentials row — own token (⚠ under fullAuto), App + all sandboxed ℹ, App + host step ⚠, force-SSH ⚠", () => {
  const own = rowsOf(iso({ provider: "asana" }), /isolation · credentials/);
  assert.deepEqual(own.map((r) => [r.level, r.note]), [["info", "your own token (tracker/forge token or gh login) — usable until you revoke it"]]);
  assert.equal(rowsOf(iso({ provider: "asana", fullAuto: true }), /isolation · credentials/)[0].level, "warn");
  const gh = { provider: "github", providerConfig: APP };
  assert.deepEqual(rowsOf(iso({ ...gh, sandbox: { type: "podman" } }), /isolation · credentials/).map((r) => [r.level, r.note]), [["info", "per-run GitHub App token (1h, repo-scoped)"]]);
  // A forge App counts too; githubRunToken:false turns it off.
  assert.match(rowsOf(iso({ forge: { type: "github", ...APP }, sandbox: { type: "podman" } }), /isolation · credentials/)[0].note, /^per-run GitHub App token/);
  assert.match(rowsOf(iso({ ...gh, githubRunToken: false, sandbox: { type: "podman" } }), /isolation · credentials/)[0].note, /^your own token/);
  const host = rowsOf(iso({ ...gh, sandbox: { type: "podman" }, pipeline: [{ id: "code", sandbox: false }, { id: "review" }] }), /isolation · credentials/);
  assert.deepEqual(host.map((r) => [r.level, r.note]), [["warn", "step(s) code: scoped run token given, but the host gh login and ~/.ssh stay readable"]]);

  const rule = "url.git@github.com:.insteadof https://github.com/\n";
  const ssh = rowsOf(iso({ ...gh }, { gitInsteadOf: rule }), /rewrites https:\/\/github.com\/ to SSH/);
  assert.equal(ssh.length, 1);
  assert.equal(ssh[0].level, "warn");
  assert.match(ssh[0].note, /\(url\.git@github\.com:\.insteadof\) — run pushes use your SSH key; remove the rule or enable the sandbox$/);
  assert.equal(rowsOf(iso({ ...gh, sandbox: { type: "podman" } }, { gitInsteadOf: rule }), /to SSH/).length, 0, "every step sandboxed: the host rule can't apply");
  assert.equal(rowsOf(iso({}, { gitInsteadOf: rule }), /to SSH/).length, 0, "no run tokens: the operator's own key is used anyway");
});

test("isolationReport: credentials row — none for a local/no-forge profile with nothing passed to agents (#491)", () => {
  assert.deepEqual(rowsOf(iso({}), /isolation · credentials/).map((r) => [r.level, r.note]), [["info", "none (local tracker, no forge)"]]);
  assert.deepEqual(rowsOf(iso({ fullAuto: true }), /isolation · credentials/).map((r) => [r.level, r.note]), [["info", "none (local tracker, no forge)"]]);
  // a GH token passthrough or a step env gives agents something, so it's "your own token" again
  assert.match(rowsOf(iso({ agentEnvPassthrough: ["GH_TOKEN"] }), /isolation · credentials/)[0].note, /^your own token/);
  assert.match(rowsOf(iso({ agentEnvPassthrough: ["*"] }), /isolation · credentials/)[0].note, /^your own token/);
  assert.match(rowsOf(iso({ pipeline: [{ id: "code", env: { GITHUB_TOKEN: "x" } }, { id: "done", manual: true }] }), /isolation · credentials/)[0].note, /^your own token/);
  // a forge on top of the local tracker also means credentials exist
  assert.match(rowsOf(iso({ forge: { type: "github" } }), /isolation · credentials/)[0].note, /^your own token/);
});

test("parseForceSshRewrites: git@github.com: and ssh:// bases rewriting https://github.com match; reverse and other hosts don't", () => {
  assert.deepEqual(parseForceSshRewrites("url.git@github.com:.insteadof https://github.com/"), ["url.git@github.com:.insteadof"]);
  assert.deepEqual(parseForceSshRewrites("url.ssh://git@github.com/.insteadOf https://github.com/\n"), ["url.ssh://git@github.com/.insteadof"], "keys come out as git prints them (insteadof lowercased)");
  assert.deepEqual(parseForceSshRewrites("url.git@github.com:.insteadof https://github.com"), ["url.git@github.com:.insteadof"]);
  assert.deepEqual(parseForceSshRewrites("url.https://github.com/.insteadof git@github.com:"), [], "the reverse (SSH → HTTPS) is harmless");
  assert.deepEqual(parseForceSshRewrites("url.git@gitlab.com:.insteadof https://gitlab.com/"), []);
  assert.deepEqual(parseForceSshRewrites("url.git@github.com:.insteadof https://github.company.com/"), []);
  assert.deepEqual(parseForceSshRewrites(""), []);
});

test("isolationReport: permissions — one row per non-manual step with its mode", () => {
  const pipeline = [
    { id: "plain" },
    { id: "allow", allow: { commands: ["git"] } },
    { id: "deny", deny: { commands: ["curl"], paths: [".env"] } },
    { id: "herm", agent: "hermes" },
    { id: "done", manual: true },
  ];
  const modes = (/** @type {any} */ cfg) => rowsOf(iso({ pipeline, ...cfg }), /isolation · permissions/).map((r) => r.note);
  assert.deepEqual(modes({}), [
    'step "plain" (claude): dontAsk (pinned; repo/user allow rules apply)',
    'step "allow" (claude): allow policy (dontAsk, 3 rules)',
    'step "deny" (claude): dontAsk (pinned; repo/user allow rules apply), deny policy (4 rules)',
    'step "herm" (hermes): agent CLI default',
  ]);
  assert.deepEqual(modes({ fullAuto: true }), [
    'step "plain" (claude): skip-permissions (fullAuto)',
    'step "allow" (claude): allow policy (dontAsk, 3 rules)',
    'step "deny" (claude): skip-permissions (fullAuto), deny policy (4 rules)',
    'step "herm" (hermes): skip-permissions (fullAuto)',
  ]);
});

test("isolationReport: ~/.claude/settings.json defaultMode is reported ignored (⚠ + migration for acceptEdits); broad allow rules ⚠ on pinned steps", () => {
  const dm = (/** @type {string} */ m) => rowsOf(iso({}, { userClaudeSettings: { permissions: { defaultMode: m } } }), /defaultMode/);
  assert.deepEqual(dm("bypassPermissions").map((r) => [r.level, r.note]), [["info", '~/.claude/settings.json defaultMode "bypassPermissions" is ignored — agenthook pins the mode']]);
  const ae = dm("acceptEdits");
  assert.equal(ae[0].level, "warn");
  assert.match(ae[0].note, /to let a non-fullAuto step edit files, allow it explicitly: "permissions": \{"allow": \["Edit", "Bash\(npm test\)"\]\} in the repo's \.claude\/settings\.json, or a step allow policy/);

  const allow = { permissions: { allow: ["Bash(*)", "Bash(npm test)", "Edit", "Read", "Write(//**)"] } };
  const broad = rowsOf(iso({}, { userClaudeSettings: allow }), /widens every pinned claude step/);
  assert.deepEqual(broad.map((r) => r.level), ["warn", "warn", "warn"]);
  assert.match(broad[0].note, /^~\/\.claude\/settings\.json allows "Bash\(\*\)" — it widens every pinned claude step \(allow policies included\)$/);
  assert.equal(rowsOf(iso({ fullAuto: true }, { userClaudeSettings: allow }), /widens/).length, 0, "bypass steps ignore allow rules");
  assert.equal(rowsOf(iso({ pipeline: [{ id: "h", agent: "hermes" }] }, { userClaudeSettings: allow }), /widens/).length, 0, "no claude step");
});

test("runChecks: the isolation block is emitted (no ✗), and a default profile's isolation rows are not problems", async () => {
  const { cfg } = cleanProfile();
  const checks = await runChecks(cfg, io());
  const rows = checks.filter((c) => c.label.startsWith("isolation · "));
  assert.ok(rows.length >= 6);
  assert.ok(rows.every((c) => c.ok), "no isolation ✗ rows");
  assert.deepEqual(rows.filter(problem), []);
  const fa = await runChecks({ ...cfg, fullAuto: true }, io());
  assert.ok(fa.some((c) => c.warn && /fullAuto without a sandbox/.test(String(c.note))));
  assert.ok(fa.filter((c) => c.label.startsWith("isolation · ")).every((c) => c.ok));
});

test("runChecks: the global insteadof rules are read through spawn only when a run token is used on the host", async () => {
  const { cfg } = cleanProfile();
  const rec = recorder();
  await runChecks(cfg, io({ spawn: rec.spawn }));
  assert.ok(!rec.calls.some((c) => c.args.includes("--get-regexp")));
  /** @type {string[][]} */
  const seen = [];
  const spawn = /** @type {any} */ ((/** @type {string} */ cmd, /** @type {string[]} */ args) => (seen.push([cmd, ...args]), args.includes("--get-regexp") ? { status: 0, stdout: "url.git@github.com:.insteadof https://github.com/\n" } : { status: 0 }));
  const checks = await runChecks(/** @type {any} */ ({ ...cfg, forge: { type: "github", repository: "o/r", ...APP } }), io({ spawn, fetch: async () => new Response("{}", { status: 500 }) }));
  assert.ok(seen.some((a) => a[0] === "git" && a.includes("--get-regexp")));
  assert.ok(checks.some((c) => c.warn && /to SSH \(url\.git@github\.com:\.insteadof\)/.test(String(c.note))));
});
