import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// Doctor — unfilledBindings, multi-repo/forge/legacy/agent/policy lints, port/claimed-port/
// shared-repo, runChecks, and uiBundleState.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { unfilledBindings, repoLints, legacyOrphans, forgeLints, agentBinChecks, agentLints, policyLints, portCheck, claimedPortLint, sharedRepoLint, runChecks } from "../src/commands/doctor.js";
import { worktreeDir } from "../src/paths.js";
import { uiBundleState } from "../src/ui-bundle.js";
import { tmp, cleanProfile, io } from "./_doctor-helpers.js";


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

test("sharedRepoLint (#674): same repo + same branchPrefix warns naming the other profile; different prefix warns only about the worktree", () => {
  const { cfg } = cleanProfile();
  const repoPath = cfg.repos[0].path;
  const sameBoth = [{ name: "other", repoPaths: [repoPath], branchPrefix: "agent/", worktreeDirs: [worktreeDir(cfg)] }];
  const branchFindings = sharedRepoLint(cfg, sameBoth);
  assert.equal(branchFindings.length, 2, "branch + worktree both collide");
  assert.ok(branchFindings.some((f) => f.level === "warn" && /other/.test(f.label) && /branch prefix/.test(f.label)));
  assert.ok(branchFindings.some((f) => f.level === "warn" && /worktree directory/.test(f.label)));

  const diffPrefix = [{ name: "other", repoPaths: [repoPath], branchPrefix: "local/", worktreeDirs: [worktreeDir(cfg)] }];
  const prefixFindings = sharedRepoLint(cfg, diffPrefix);
  assert.equal(prefixFindings.length, 1, "only the worktree collision remains");
  assert.ok(prefixFindings[0].label.includes("worktree directory"));
});

test("sharedRepoLint (#674): a different repo path → no findings", () => {
  const { cfg } = cleanProfile();
  const other = [{ name: "other", repoPaths: ["/not/the/same/repo"], branchPrefix: "agent/", worktreeDirs: ["/not/the/same/repo-worktrees"] }];
  assert.deepEqual(sharedRepoLint(cfg, other), []);
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

test("runChecks: does not warn about the current profile's own port", async () => {
  const { cfg } = cleanProfile();
  const claimedPorts = ({ exclude } = {}) =>
    [{ port: cfg.port, stateKey: cfg.stateKey, name: cfg.name }].filter((c) => c.stateKey !== exclude?.stateKey);
  const checks = await runChecks(cfg, io({ claimedPorts }));
  assert.ok(!checks.some((c) => c.warn && /is also configured by profile/.test(c.label)));
});

test("runChecks: passes exclude.stateKey matching cfg.stateKey to claimedPorts", async () => {
  const { cfg } = cleanProfile();
  let received;
  const claimedPorts = (opts) => {
    received = opts;
    return [];
  };
  await runChecks(cfg, io({ claimedPorts }));
  assert.equal(received?.exclude?.stateKey, cfg.stateKey);
});

test("runChecks: warns about a sharing profile via the injected registeredProfiles, excluding the current one (#674)", async () => {
  const { cfg } = cleanProfile();
  let received;
  const registeredProfiles = (opts) => {
    received = opts;
    return [{ name: "other-profile", repoPaths: [cfg.repos[0].path], branchPrefix: cfg.branchPrefix || "agent/", worktreeDirs: [worktreeDir(cfg)] }];
  };
  const checks = await runChecks(cfg, io({ registeredProfiles }));
  assert.equal(received?.exclude?.stateKey, cfg.stateKey);
  assert.ok(checks.some((c) => c.warn && /other-profile/.test(c.label)));
});

test("runChecks: no shared-repo warning when registeredProfiles reports nothing", async () => {
  const { cfg } = cleanProfile();
  const checks = await runChecks(cfg, io({ registeredProfiles: () => [] }));
  assert.ok(!checks.some((c) => c.warn && /shares a repo/.test(c.label)));
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

