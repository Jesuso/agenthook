// doctor — pure-unit coverage (no network): the pipeline-binding scan that flags
// `init` TODO_* placeholders and empty bindings before they silently no-op a run,
// plus the multi-repo routing lints.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { unfilledBindings, repoLints, legacyOrphans } from "../src/commands/doctor.js";
import { worktreeDir } from "../src/paths.js";

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

test("legacyOrphans: flags <base>/42, not <base>/ios/42", () => {
  const cfg = multi();
  const base = worktreeDir(cfg, ios);
  const paths = [ios.path, path.join(base, "42"), path.join(base, "ios", "42")];
  assert.deepEqual(legacyOrphans(cfg, ios, paths), [path.join(base, "42")]);
  assert.deepEqual(legacyOrphans({ ...cfg, multiRepo: false }, ios, paths), []);
});
