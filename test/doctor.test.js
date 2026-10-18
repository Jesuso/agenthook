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
import { unfilledBindings, repoLints, legacyOrphans, forgeLints, agentBinChecks, agentLints, portCheck, runChecks, applyFixes, fixableCount, report, instructionLints } from "../src/commands/doctor.js";
import { worktreeDir } from "../src/paths.js";
import { loadConfig } from "../src/config.js";
import { instructionTargets } from "../src/heartbeat.js";
import { uiBundleState } from "../src/ui-bundle.js";

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

const mono = { id: "mono", path: "/w/alephbeta", match: [], default: true };
const ios = { id: "ios", path: "/w/alephbeta-ios", match: ["ios"] };
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
 * worktree base (`root/agenthook-worktrees`). Each test then breaks exactly what it fixes.
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

/** Probes stubbed so only the filesystem/git state under test decides the outcome. @param {any} [over] */
const io = (over = {}) => ({ onPath: () => true, portInUse: async () => false, uiBundle: () => ({ state: "fresh" }), spawn: recorder().spawn, ...over });

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

test("doctor --fix: a missing instruction file is ✗ (runs get empty instructions); the SOUL file is never checked", async () => {
  const { cfg, root } = cleanProfile();
  fs.rmSync(path.join(root, "INSTRUCTIONS.md"));
  const lints = instructionLints(cfg);
  assert.deepEqual(lints.map((l) => [l.level, l.label]), [["fail", `instructions file exists: ${path.join(root, "INSTRUCTIONS.md")}`]]);
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
