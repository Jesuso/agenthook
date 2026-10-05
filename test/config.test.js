// Config load — pure-unit coverage of the completeOnMerge / forge validation. Each case
// writes a throwaway config to a temp dir and expects loadConfig to REJECT it; rejection
// happens before any state dir is created, so nothing lands in ~/.agenthook.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, peekConfig, registryDir } from "../src/config.js";

/** Write a config and load it. @param {any} over @param {any[]} pipeline */
function load(pipeline, over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-cfg-"));
  const file = path.join(dir, "agenthook.config.json");
  fs.writeFileSync(file, JSON.stringify({ name: "ah-cfg-test", repoPath: dir, tracker: { type: "asana", pipeline }, ...over }));
  return () => loadConfig({ configPath: file });
}

test("completeOnMerge on a non-manual step is rejected", () => {
  assert.throws(load([{ id: "code", completeOnMerge: true }]), /completeOnMerge requires manual/);
});

test("more than one completeOnMerge step is rejected", () => {
  const pl = [
    { id: "done", manual: true, completeOnMerge: true },
    { id: "done2", manual: true, completeOnMerge: true },
  ];
  assert.throws(load(pl), /only one pipeline step may set completeOnMerge/);
});

test("a forge block without a type is rejected", () => {
  assert.throws(load([{ id: "code" }], { forge: { repository: "o/r" } }), /forge\.type/);
});

test("forge.ciTarget naming an unknown step is rejected", () => {
  assert.throws(load([{ id: "code" }], { forge: { type: "github", ciTarget: "nope" } }), /ciTarget "nope" is not a pipeline step/);
});

test("forge.ciTarget naming a manual step is rejected", () => {
  const pl = [{ id: "code" }, { id: "done", manual: true }];
  assert.throws(load(pl, { forge: { type: "github", ciTarget: "done" } }), /ciTarget "done" is a manual step/);
});

test("a queue key equal to the step's own source is rejected (self-loop)", () => {
  assert.throws(load([{ id: "code", sourceSectionGid: "S1", queueSectionGid: "S1" }]), /queueSectionGid must differ from its own sourceSectionGid/);
  assert.throws(load([{ id: "code", sourceStatus: "In Progress", queueStatus: "in progress " }]), /queueStatus must differ/);
  assert.throws(load([{ id: "code", sourceLabel: "agent:code", queueLabel: "Agent:Code" }]), /queueLabel must differ/);
});

test("a queue key on a manual step is rejected", () => {
  assert.throws(load([{ id: "done", manual: true, queueLabel: "queue:done" }]), /queueLabel is not allowed on a manual step/);
});

// --- multi-repo `repos` block: synthesis, repoPath reconciliation, validation ---
// Successful loads create ~/.agenthook/<name>; these use their own name and remove it.

const REPOS_NAME = "ah-cfg-test-repos";
test.after(() => fs.rmSync(path.join(os.homedir(), ".agenthook", REPOS_NAME), { recursive: true, force: true }));

/** A config dir with sibling checkouts `mono/` + `ios/`; `over` replaces top-level keys.
 * @param {any} over */
function loadRepos(over) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-cfg-repos-"));
  const file = path.join(dir, "agenthook.config.json");
  const base = { name: REPOS_NAME, tracker: { type: "asana", pipeline: [{ id: "code" }] } };
  const raw = { ...base, ...over };
  for (const k of Object.keys(raw)) if (raw[k] === undefined) delete raw[k];
  fs.writeFileSync(file, JSON.stringify(raw));
  return { dir, load: () => loadConfig({ configPath: file }) };
}

test("no repos block → one synthesized default repo at repoPath, multiRepo false", () => {
  const { dir, load } = loadRepos({ repoPath: "./app" });
  const cfg = load();
  assert.equal(cfg.repoPath, path.join(dir, "app"));
  assert.deepEqual(cfg.repos, [{ id: "default", path: path.join(dir, "app"), match: [], default: true }]);
  assert.equal(cfg.multiRepo, false);
});

test("neither repoPath nor repos → rejected", () => {
  assert.throws(loadRepos({}).load, /"repoPath" is required/);
});

test("repos resolve paths/instructionsFile against the config dir and normalize match", () => {
  const { dir, load } = loadRepos({
    repos: [
      { id: "mono", path: "./mono", match: [" Backend ", "frontend", "BACKEND"], default: true },
      { id: "ios", path: "./ios", match: ["iOS"], instructionsFile: "./INSTRUCTIONS_IOS.md", worktreePrefix: "../ios-agents" },
    ],
  });
  const cfg = load();
  assert.equal(cfg.multiRepo, true);
  assert.equal(cfg.repoPath, path.join(dir, "mono"), "repoPath = the default repo's path");
  assert.deepEqual(cfg.repos[0], { id: "mono", path: path.join(dir, "mono"), match: ["backend", "frontend"], default: true });
  assert.deepEqual(cfg.repos[1], {
    id: "ios",
    path: path.join(dir, "ios"),
    match: ["ios"],
    instructionsFile: path.join(dir, "INSTRUCTIONS_IOS.md"),
    worktreePrefix: "../ios-agents",
  });
});

test("repos + repoPath with no default: the repo at repoPath becomes the default", () => {
  const { dir, load } = loadRepos({ repoPath: "./ios/", repos: [{ id: "mono", path: "./mono" }, { id: "ios", path: "./ios" }] });
  const cfg = load();
  assert.equal(cfg.repos.find((r) => r.default)?.id, "ios");
  assert.equal(cfg.repoPath, path.join(dir, "ios"));
});

test("repos + repoPath matching no declared repo (and no default) → rejected", () => {
  assert.throws(loadRepos({ repoPath: "./elsewhere", repos: [{ id: "mono", path: "./mono" }] }).load, /not one of the declared repos/);
});

test("repos without any default: repoPath falls back to the first repo", () => {
  const { dir, load } = loadRepos({ repos: [{ id: "mono", path: "./mono", match: ["a"] }, { id: "ios", path: "./ios", match: ["b"] }] });
  const cfg = load();
  assert.equal(cfg.repoPath, path.join(dir, "mono"));
  assert.ok(!cfg.repos.some((r) => r.default));
});

test("invalid repos blocks are rejected at load", () => {
  const bad = (/** @type {any} */ repos) => loadRepos({ repos }).load;
  assert.throws(bad([]), /"repos" must be a non-empty array/);
  assert.throws(bad({ id: "x" }), /"repos" must be a non-empty array/);
  assert.throws(bad([{ path: "./a" }]), /repos\[0\]\.id is required/);
  assert.throws(bad([{ id: "bad id!", path: "./a" }]), /must match \[A-Za-z0-9\._-\]\+/);
  assert.throws(bad([{ id: "a" }]), /repos "a" requires a "path"/);
  assert.throws(bad([{ id: "a", path: "./a" }, { id: "a", path: "./b" }]), /duplicate repos id "a"/);
  assert.throws(bad([{ id: "a", path: "./x" }, { id: "b", path: "x/" }]), /"b" and "a" share the path/);
  assert.throws(bad([{ id: "a", path: "./a", match: ["iOS"] }, { id: "b", path: "./b", match: [" ios"] }]), /route key "ios" is claimed by both repos "a" and "b"/);
  assert.throws(bad([{ id: "a", path: "./a", default: true }, { id: "b", path: "./b", default: true }]), /at most one repo may set default:true \(found a, b\)/);
  assert.throws(bad([{ id: "a", path: "./a", match: [7] }]), /match entries must be non-empty strings/);
  assert.throws(bad([{ id: "a", path: "./a", match: "ios" }]), /match must be an array/);
});

test("a non-boolean overlapGuard is rejected", () => {
  assert.throws(load([{ id: "code" }], { overlapGuard: "yes" }), /"overlapGuard" must be true or false/);
});

// --- peekConfig: identity without secrets (read-only commands: `agents`, bare `status`) ---

/** A config whose tokens reference a var that is certainly unset in the test shell. */
function writeSecretConfig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-cfg-peek-"));
  const file = path.join(dir, "agenthook.config.json");
  delete process.env.AH_TEST_UNSET_TOKEN;
  fs.writeFileSync(file, JSON.stringify({
    name: "ah-peek-test",
    repoPath: dir,
    forge: { type: "github", repository: "o/r", token: "${AH_TEST_UNSET_TOKEN}" },
    tracker: { type: "asana", token: "${AH_TEST_UNSET_TOKEN}", pipeline: [{ id: "code" }] },
  }));
  return file;
}

test("peekConfig returns name + state paths where loadConfig throws on unset ${VAR}s", () => {
  const file = writeSecretConfig();
  assert.throws(() => loadConfig({ configPath: file }), /unset environment variable\(s\)[\s\S]*AH_TEST_UNSET_TOKEN/);
  const peeked = peekConfig({ configPath: file });
  assert.equal(peeked.name, "ah-peek-test");
  assert.equal(peeked.configPath, file);
  assert.equal(peeked.configDir, path.dirname(file));
  assert.equal(peeked.stateDir, path.join(registryDir, "ah-peek-test"));
  assert.equal(peeked.logDir, path.join(registryDir, "ah-peek-test", "logs"));
  // peeking must not create the state dir — it is a read, not a boot
  assert.equal(fs.existsSync(peeked.stateDir), false);
});

test("peekConfig still rejects a missing file, unparsable JSON, and a config without a name", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-cfg-peek-bad-"));
  assert.throws(() => peekConfig({ configPath: path.join(dir, "nope.json") }), /no agenthook\.config\.json found/);
  const garbage = path.join(dir, "garbage.json");
  fs.writeFileSync(garbage, "{ not json");
  assert.throws(() => peekConfig({ configPath: garbage }), /could not parse/);
  const nameless = path.join(dir, "nameless.json");
  fs.writeFileSync(nameless, JSON.stringify({ repoPath: dir, tracker: { type: "asana" } }));
  assert.throws(() => peekConfig({ configPath: nameless }), /"name" is required/);
});

test("loadConfig resolves a ${VAR} that only the .env beside the config provides", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-cfg-dotenv-"));
  const file = path.join(dir, "agenthook.config.json");
  delete process.env.AH_TEST_DOTENV_TOKEN;
  fs.writeFileSync(path.join(dir, ".env"), "AH_TEST_DOTENV_TOKEN=from-dotenv\n");
  fs.writeFileSync(file, JSON.stringify({ name: "ah-dotenv-test", repoPath: dir, tracker: { type: "asana", token: "${AH_TEST_DOTENV_TOKEN}", pipeline: [{ id: "code" }] } }));
  const cfg = loadConfig({ configPath: file });
  assert.equal(cfg.tracker.token, "from-dotenv");
});
