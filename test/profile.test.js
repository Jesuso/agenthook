// stateId state key + profile.json marker + the boot-time rename refusal (src/profile.js).
// Config cases load real files under the test AGENTHOOK_HOME; rename cases run on a per-test
// temp registry so they never see each other's dirs.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, peekConfig, validateRawConfig, registryDir } from "../src/config.js";
import { controlSockPath } from "../src/paths.js";
import { createHeartbeat } from "../src/heartbeat.js";
import { createEngine } from "../src/engine.js";
import { writeProfileMarker, findRenameConflict, claimStateDir, isFreshStateDir } from "../src/profile.js";

const made = new Set();
test.after(() => {
  for (const k of made) fs.rmSync(path.join(registryDir, k), { recursive: true, force: true });
});

/** Write a config file; returns its path. @param {any} over */
function writeConfig(over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-profile-"));
  const file = path.join(dir, "agenthook.config.json");
  fs.writeFileSync(file, JSON.stringify({ name: "ah-prof-new", repoPath: dir, tracker: { type: "asana", pipeline: [{ id: "code" }] }, ...over }));
  return file;
}

// --- stateId / stateKey derivation ---

test("no stateId: state paths are keyed by name, exactly as before", () => {
  const cfg = loadConfig({ configPath: writeConfig({ name: "ah-prof-plain" }) });
  made.add("ah-prof-plain");
  const dir = path.join(registryDir, "ah-prof-plain");
  assert.equal(cfg.stateKey, "ah-prof-plain");
  assert.equal(cfg.stateDir, dir);
  assert.equal(cfg.logDir, path.join(dir, "logs"));
  assert.equal(cfg.pidFile, path.join(dir, "server.pid"));
  assert.equal(cfg.heartbeatFile, path.join(dir, "heartbeat.json"));
  assert.equal(cfg.controlSock, controlSockPath(dir, "ah-prof-plain"));
  assert.equal(controlSockPath(cfg.stateDir, cfg.stateKey, "win32"), "\\\\.\\pipe\\agenthook-ah-prof-plain");
});

test("stateId keys the state dir (and win32 pipe) while name stays the label; peekConfig agrees", () => {
  const file = writeConfig({ name: "ah-prof-new", stateId: "ah-prof-old" });
  const cfg = loadConfig({ configPath: file });
  made.add("ah-prof-old");
  const dir = path.join(registryDir, "ah-prof-old");
  assert.equal(cfg.name, "ah-prof-new");
  assert.equal(cfg.stateKey, "ah-prof-old");
  assert.equal(cfg.stateDir, dir);
  assert.equal(cfg.pidFile, path.join(dir, "server.pid"));
  assert.equal(controlSockPath(cfg.stateDir, cfg.stateKey, "win32"), "\\\\.\\pipe\\agenthook-ah-prof-old");
  assert.ok(!fs.existsSync(path.join(registryDir, "ah-prof-new")));
  const peeked = peekConfig({ configPath: file });
  assert.equal(peeked.stateKey, "ah-prof-old");
  assert.equal(peeked.stateDir, dir);
  assert.equal(peeked.name, "ah-prof-new");
});

test("validateRawConfig: stateId must be a valid name when present", () => {
  const base = { name: "x", repoPath: "/tmp/r", tracker: { type: "asana", pipeline: [{ id: "code" }] } };
  for (const bad of ["a/b", "", 42, null]) {
    const v = validateRawConfig({ ...base, stateId: bad });
    assert.equal(v.ok, false, `stateId ${JSON.stringify(bad)} should be rejected`);
    assert.ok(!v.ok && v.errors.some((e) => /"stateId"/.test(e)));
  }
  assert.deepEqual(validateRawConfig({ ...base, stateId: "old.key_1-x" }), { ok: true });
  assert.deepEqual(validateRawConfig(base), { ok: true });
  assert.throws(() => peekConfig({ configPath: writeConfig({ stateId: "a/b" }) }), /"stateId" must match/);
});

test("heartbeat records the stateKey", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-profile-hb-"));
  const heartbeatFile = path.join(dir, "heartbeat.json");
  /** @type {any} */
  const cfg = { name: "label", stateKey: "key", heartbeatFile, pipeline: [], repoPath: dir };
  createHeartbeat(cfg);
  const hb = JSON.parse(fs.readFileSync(heartbeatFile, "utf8"));
  assert.equal(hb.name, "label");
  assert.equal(hb.stateKey, "key");
});

// --- profile.json marker + rename refusal (temp registry) ---

/** @returns {string} */
const tmpRegistry = () => fs.mkdtempSync(path.join(os.tmpdir(), "ah-registry-"));

/** A cfg stub keyed into `registry`. @param {string} registry @param {string} key @param {string} configPath */
function stub(registry, key, configPath) {
  /** @type {any} */
  const cfg = { name: key, stateKey: key, configPath, stateDir: path.join(registry, key) };
  return cfg;
}

/** Create a state dir as loadConfig would (dir + empty logs/). @param {string} dir */
const mkState = (dir) => fs.mkdirSync(path.join(dir, "logs"), { recursive: true });

/** A booted state dir `key` owned by `configPath`. @param {string} registry @param {string} key @param {string} configPath */
function own(registry, key, configPath) {
  const cfg = stub(registry, key, configPath);
  mkState(cfg.stateDir);
  writeProfileMarker(cfg);
}

test("writeProfileMarker writes the marker 0600 and keeps createdAt on rewrite", async () => {
  const reg = tmpRegistry();
  const cfg = stub(reg, "A", "/x/agenthook.config.json");
  mkState(cfg.stateDir);
  writeProfileMarker(cfg);
  const file = path.join(cfg.stateDir, "profile.json");
  const first = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(Object.keys(first).sort(), ["configPath", "createdAt", "name", "stateKey", "updatedAt"]);
  assert.equal(first.configPath, "/x/agenthook.config.json");
  assert.equal(first.stateKey, "A");
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  await new Promise((r) => setTimeout(r, 5));
  writeProfileMarker(cfg);
  const second = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(second.createdAt, first.createdAt);
  assert.ok(second.updatedAt > first.updatedAt);

  fs.writeFileSync(file, "{not json");
  writeProfileMarker(cfg);
  assert.ok(JSON.parse(fs.readFileSync(file, "utf8")).createdAt > first.createdAt);
});

test("isFreshStateDir: absent or only an empty logs/ is fresh; anything else is not", () => {
  const reg = tmpRegistry();
  const dir = path.join(reg, "B");
  assert.equal(isFreshStateDir(dir), true);
  fs.mkdirSync(dir);
  assert.equal(isFreshStateDir(dir), true);
  mkState(dir);
  assert.equal(isFreshStateDir(dir), true);
  fs.writeFileSync(path.join(dir, "logs", "run.log"), "x");
  assert.equal(isFreshStateDir(dir), false);
  fs.rmSync(path.join(dir, "logs", "run.log"));
  fs.writeFileSync(path.join(dir, "seen.json"), "[]");
  assert.equal(isFreshStateDir(dir), false);
});

test("rename: a fresh dir whose config already owns a sibling is refused and removed", () => {
  const reg = tmpRegistry();
  const configPath = writeConfig();
  own(reg, "A", configPath);
  const b = stub(reg, "B", configPath);
  assert.equal(findRenameConflict(b, reg), "A"); // B absent
  mkState(b.stateDir);
  assert.equal(findRenameConflict(b, reg), "A"); // B = only an empty logs/
  assert.throws(
    () => claimStateDir(b, reg),
    (/** @type {Error} */ e) =>
      e.message ===
      `profile state for this config already lives in ${path.join(reg, "A")}/ — looks like a rename. ` +
        `Add "stateId": "A" to ${configPath} (or move the dir). Refusing to start on an empty state dir.`,
  );
  assert.ok(!fs.existsSync(b.stateDir), "the empty state dir is removed");
  assert.ok(fs.existsSync(path.join(reg, "A", "profile.json")), "the real state dir is untouched");
});

test("rename: configPath is compared by realpath", () => {
  const reg = tmpRegistry();
  const configPath = writeConfig();
  const link = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ah-link-")), "cfg.json");
  fs.symlinkSync(configPath, link);
  own(reg, "A", link);
  assert.equal(findRenameConflict(stub(reg, "B", configPath), reg), "A");
});

test("rename: no refusal for a marked, legacy, unrelated, or unmarked case", () => {
  const configPath = writeConfig();

  // B already has its own profile.json
  let reg = tmpRegistry();
  own(reg, "A", configPath);
  let b = stub(reg, "B", configPath);
  mkState(b.stateDir);
  writeProfileMarker(b);
  assert.equal(findRenameConflict(b, reg), null);

  // B is a legacy pre-marker dir holding real state
  reg = tmpRegistry();
  own(reg, "A", configPath);
  b = stub(reg, "B", configPath);
  mkState(b.stateDir);
  fs.writeFileSync(path.join(b.stateDir, "seen.json"), "[]");
  assert.equal(findRenameConflict(b, reg), null);

  // A's marker names a different config
  reg = tmpRegistry();
  own(reg, "A", writeConfig());
  assert.equal(findRenameConflict(stub(reg, "B", configPath), reg), null);

  // sibling has no profile.json
  reg = tmpRegistry();
  mkState(path.join(reg, "A"));
  fs.writeFileSync(path.join(reg, "A", "seen.json"), "[]");
  b = stub(reg, "B", configPath);
  assert.equal(findRenameConflict(b, reg), null);
  mkState(b.stateDir);
  claimStateDir(b, reg);
  assert.ok(fs.existsSync(path.join(b.stateDir, "profile.json")), "no conflict → marker written");
});

test("createEngine refuses a renamed profile before writing anything (no heartbeat, no pidfile)", () => {
  const configPath = writeConfig({ name: "ah-prof-renamed" });
  own(registryDir, "ah-prof-original", configPath);
  made.add("ah-prof-original");
  made.add("ah-prof-renamed");
  const cfg = loadConfig({ configPath }); // creates the empty state dir, as every command does
  assert.ok(fs.existsSync(cfg.stateDir));
  assert.throws(() => createEngine(cfg), /already lives in .*ah-prof-original\/ — looks like a rename\. Add "stateId": "ah-prof-original"/);
  assert.ok(!fs.existsSync(cfg.stateDir), "fresh state dir removed");
  assert.ok(!fs.existsSync(cfg.pidFile));
});

test("no-arg status reads the state dir keyed by stateId, not by name", async () => {
  const { status } = await import("../src/commands/status.js");
  const configPath = writeConfig({ name: "ah-prof-label", stateId: "ah-prof-key" });
  made.add("ah-prof-key");
  const dir = path.join(registryDir, "ah-prof-key");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "heartbeat.json"), JSON.stringify({ name: "ah-prof-label", stateKey: "ah-prof-key", tracker: "asana" }));
  /** @type {string[]} */
  const out = [];
  const log = console.log;
  console.log = (/** @type {any[]} */ ...a) => void out.push(a.join(" "));
  try {
    await status({ _: [], config: configPath });
  } finally {
    console.log = log;
  }
  assert.ok(!out.some((l) => /no such profile/.test(l)), out.join("\n"));
  assert.ok(out.some((l) => /tracker : asana/.test(l)), out.join("\n"));
});
