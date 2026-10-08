import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// instructionTargets — pure unit coverage: which standing-instructions files the
// pipeline actually reads, grouped by role (step/default/repo), with dedupe-by-path
// and step > default > repo precedence when one file serves several roles.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { instructionTargets, listProfiles, resolveProfile } from "../src/heartbeat.js";

/** @param {object} overrides */
function baseCfg(overrides = {}) {
  return {
    instructionsFile: "/cfg/INSTRUCTIONS.md",
    pipeline: [],
    repos: undefined,
    ...overrides,
  };
}

test("two steps sharing one file -> one scope:'step' entry with both ids", () => {
  const cfg = baseCfg({
    pipeline: [
      { id: "code", instructionsFile: "/cfg/code.md" },
      { id: "review", instructionsFile: "/cfg/code.md" },
    ],
  });
  const targets = instructionTargets(cfg);
  assert.deepEqual(targets, [{ path: path.resolve("/cfg/code.md"), scope: "step", ids: ["code", "review"] }]);
});

test("non-manual step without its own file -> default entry for that step's id", () => {
  const cfg = baseCfg({
    pipeline: [{ id: "code" }],
  });
  const targets = instructionTargets(cfg);
  assert.deepEqual(targets, [{ path: path.resolve("/cfg/INSTRUCTIONS.md"), scope: "default", ids: ["code"] }]);
});

test("every non-manual step has its own file -> no default entry", () => {
  const cfg = baseCfg({
    pipeline: [
      { id: "code", instructionsFile: "/cfg/code.md" },
      { id: "review", instructionsFile: "/cfg/review.md" },
    ],
  });
  const targets = instructionTargets(cfg);
  assert.ok(!targets.some((t) => t.scope === "default"));
});

test("manual steps never appear in any ids, with or without their own file", () => {
  const cfg = baseCfg({
    pipeline: [
      { id: "gate", manual: true },
      { id: "gate2", manual: true, instructionsFile: "/cfg/gate2.md" },
      { id: "code" },
    ],
  });
  const targets = instructionTargets(cfg);
  for (const t of targets) {
    assert.ok(!t.ids.includes("gate"));
    assert.ok(!t.ids.includes("gate2"));
  }
  // manual-only lack of a file does not spuriously trigger a default entry for them
  const def = targets.find((t) => t.scope === "default");
  assert.deepEqual(def.ids, ["code"]);
  assert.ok(!targets.some((t) => t.path === path.resolve("/cfg/gate2.md")));
});

test("repos[].instructionsFile -> scope:'repo', ids:[repo.id]; synthesized default repo contributes nothing", () => {
  const cfg = baseCfg({
    repos: [
      { id: "svc-a", path: "/repos/a", instructionsFile: "/cfg/a.md" },
      { id: "svc-b", path: "/repos/b" },
    ],
  });
  const targets = instructionTargets(cfg);
  assert.deepEqual(targets, [{ path: path.resolve("/cfg/a.md"), scope: "repo", ids: ["svc-a"] }]);

  const noRepos = baseCfg({ repoPath: "/repos/default" });
  assert.deepEqual(instructionTargets(noRepos), []);
});

test("same path in several roles -> single entry, highest-precedence scope, union of ids in step/default/repo order", () => {
  const cfg = baseCfg({
    instructionsFile: "/cfg/shared.md",
    pipeline: [
      { id: "code", instructionsFile: "/cfg/shared.md" },
      { id: "triage" }, // falls back to cfg.instructionsFile === shared.md
    ],
    repos: [{ id: "svc-a", path: "/repos/a", instructionsFile: "/cfg/shared.md" }],
  });
  const targets = instructionTargets(cfg);
  assert.deepEqual(targets, [{ path: path.resolve("/cfg/shared.md"), scope: "step", ids: ["code", "triage", "svc-a"] }]);
});

test("all paths come out absolute even from relative fixtures", () => {
  const cfg = baseCfg({
    instructionsFile: "cfg/INSTRUCTIONS.md",
    pipeline: [{ id: "code", instructionsFile: "cfg/code.md" }],
    repos: [{ id: "svc-a", path: "repos/a", instructionsFile: "cfg/a.md" }],
  });
  for (const t of instructionTargets(cfg)) {
    assert.equal(t.path, path.resolve(t.path));
  }
});

// --- listProfiles / resolveProfile: state key (dir) vs label (heartbeat → profile.json → dir) ---

/** A temp registry with one dir per entry: { hb?: heartbeat name, marker?: profile.json name }.
 * @param {Record<string, { hb?: string, marker?: string }>} dirs */
function registry(dirs) {
  const reg = fs.mkdtempSync(path.join(os.tmpdir(), "ah-resolve-"));
  for (const [key, { hb, marker }] of Object.entries(dirs)) {
    const dir = path.join(reg, key);
    fs.mkdirSync(dir);
    if (hb) fs.writeFileSync(path.join(dir, "heartbeat.json"), JSON.stringify({ name: hb, stateKey: key }));
    if (marker) fs.writeFileSync(path.join(dir, "profile.json"), JSON.stringify({ name: marker, stateKey: key }));
  }
  return reg;
}

test("listProfiles: stateKey = dir, name = heartbeat name → profile.json name → dir name", () => {
  const reg = registry({ a: { hb: "Alpha", marker: "stale" }, b: { marker: "Beta" }, c: {} });
  assert.deepEqual(
    listProfiles(reg).map((p) => [p.stateKey, p.name, p.dir]),
    [["a", "Alpha", path.join(reg, "a")], ["b", "Beta", path.join(reg, "b")], ["c", "c", path.join(reg, "c")]],
  );
});

test("resolveProfile: by state key, by heartbeat label, by profile.json label; unknown → null", () => {
  const reg = registry({ Old: { hb: "New" }, parked: { marker: "Parked" } });
  assert.equal(resolveProfile("Old", reg)?.stateKey, "Old");
  assert.equal(resolveProfile("New", reg)?.stateKey, "Old");
  assert.equal(resolveProfile("Parked", reg)?.stateKey, "parked");
  assert.equal(resolveProfile("nope", reg), null);
});

test("resolveProfile: a state key wins over another profile's equal label", () => {
  const reg = registry({ x: { hb: "y" }, y: { hb: "Why" } });
  assert.equal(resolveProfile("y", reg)?.stateKey, "y");
});

test("resolveProfile: a label shared by two profiles throws, listing both state keys", () => {
  const reg = registry({ k1: { hb: "Same" }, k2: { marker: "Same" } });
  assert.throws(() => resolveProfile("Same", reg), /profile label "Same" is ambiguous — matches state keys k1, k2; pass the state key instead/);
  assert.equal(resolveProfile("k2", reg)?.stateKey, "k2");
});

// --- provenance: configPath / createdAt / lastSeenAt / ghost / configMissing (profileMeta) ---

/** @param {string} reg @param {string} key @param {Record<string, any>} files */
function writeDir(reg, key, files) {
  const dir = path.join(reg, key);
  fs.mkdirSync(dir, { recursive: true });
  for (const [f, v] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), typeof v === "string" ? v : JSON.stringify(v));
  return dir;
}

test("listProfiles: a ghost (empty dir / only an empty logs/) → ghost, no configPath, createdAt from the dir", () => {
  const reg = fs.mkdtempSync(path.join(os.tmpdir(), "ah-meta-"));
  fs.mkdirSync(path.join(reg, "bare"));
  fs.mkdirSync(path.join(reg, "logsonly", "logs"), { recursive: true });
  for (const p of listProfiles(reg)) {
    assert.equal(p.ghost, true, p.stateKey);
    assert.equal(p.configPath, null);
    assert.equal(p.configMissing, false);
    assert.equal(p.lastSeenAt, null);
    assert.ok(p.createdAt && Math.abs(Date.parse(p.createdAt) - Date.now()) < 60_000, `${p.stateKey} createdAt ${p.createdAt}`);
  }
});

test("listProfiles: a stopped profile (marker only, config exists) → configPath from the marker, lastSeenAt = later of marker / events", () => {
  const reg = fs.mkdtempSync(path.join(os.tmpdir(), "ah-meta-"));
  const cfgFile = path.join(reg, "agenthook.config.json");
  fs.writeFileSync(cfgFile, "{}");
  const marker = { name: "S", stateKey: "s", configPath: cfgFile, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-02-01T00:00:00.000Z" };
  const dir = writeDir(reg, "s", { "profile.json": marker });
  let [p] = listProfiles(reg).filter((x) => x.stateKey === "s");
  assert.deepEqual(
    [p.ghost, p.configMissing, p.configPath, p.createdAt, p.lastSeenAt],
    [false, false, cfgFile, "2026-01-01T00:00:00.000Z", "2026-02-01T00:00:00.000Z"],
  );
  // events.jsonl written after the last boot → its mtime is the later sighting.
  fs.writeFileSync(path.join(dir, "events.jsonl"), "{}\n");
  const t = new Date("2026-05-05T00:00:00.000Z");
  fs.utimesSync(path.join(dir, "events.jsonl"), t, t);
  [p] = listProfiles(reg).filter((x) => x.stateKey === "s");
  assert.equal(p.lastSeenAt, t.toISOString());
});

test("listProfiles: a marker pointing at a deleted config → configMissing", () => {
  const reg = fs.mkdtempSync(path.join(os.tmpdir(), "ah-meta-"));
  writeDir(reg, "m", { "profile.json": { name: "m", configPath: path.join(reg, "gone.json") } });
  const [p] = listProfiles(reg);
  assert.equal(p.configMissing, true);
  assert.equal(p.configPath, path.join(reg, "gone.json"));
  assert.equal(p.ghost, false);
});

test("listProfiles: a legacy pre-marker dir holding state is not a ghost", () => {
  const reg = fs.mkdtempSync(path.join(os.tmpdir(), "ah-meta-"));
  writeDir(reg, "legacy", { "seen.json": ["a"] });
  const [p] = listProfiles(reg);
  assert.equal(p.ghost, false);
  assert.equal(p.configPath, null);
  assert.equal(p.configMissing, false);
});

test("listProfiles: with a heartbeat, lastSeenAt is its updatedAt and configPath falls back to it", () => {
  const reg = fs.mkdtempSync(path.join(os.tmpdir(), "ah-meta-"));
  const updatedAt = "2026-07-07T07:07:07.000Z";
  writeDir(reg, "h", {
    "heartbeat.json": { name: "h", configPath: path.join(reg, "nope.json"), updatedAt },
    "profile.json": { name: "h", updatedAt: "2026-01-01T00:00:00.000Z" },
  });
  const [p] = listProfiles(reg);
  assert.equal(p.lastSeenAt, updatedAt);
  assert.equal(p.configPath, path.join(reg, "nope.json"));
  assert.equal(p.configMissing, true);
  assert.equal(p.ghost, false);
});
