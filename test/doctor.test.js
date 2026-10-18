import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// doctor — pure-unit coverage (no network): the pipeline-binding scan that flags
// `init` TODO_* placeholders and empty bindings before they silently no-op a run,
// plus the multi-repo routing lints.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { unfilledBindings, repoLints, legacyOrphans, forgeLints, agentBinChecks, agentLints, portCheck } from "../src/commands/doctor.js";
import { worktreeDir } from "../src/paths.js";
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
