import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// `agenthook rename` — the testable core (renameProfile): collisions with another profile's
// label or state key, invalid names, the same-name no-op, and the running-receiver message.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registryDir } from "../src/config.js";
import { renameProfile, assertSafeRename } from "../src/commands/rename.js";

// peekConfig (inside renameProfile) derives a profile's stateDir from config.js's module-scoped
// registryDir (AGENTHOOK_HOME, set once by _setup.js) — not a passable param — so this test's
// state dirs must live there too, not under a separate temp registry.
const registry = registryDir;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "ah-rename-"));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const json = (v) => JSON.stringify(v, null, 2) + "\n";

/** A profile: its config file (under root/cfg/<stateKey>/) and state dir (under the real
 * registry), optionally "running" (a live pidfile). @param {{name: string, stateId?: string, running?: boolean}} o */
function profile({ name, stateId, running = false }) {
  const stateKey = stateId ?? name;
  const stateDir = path.join(registry, stateKey);
  fs.mkdirSync(stateDir, { recursive: true });
  const configPath = path.join(root, "cfg", stateKey, "agenthook.config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  /** @type {any} */
  const raw = { name, repoPath: "/repo", tracker: { type: "github", pipeline: [{ id: "code" }] } };
  if (stateId) raw.stateId = stateId;
  fs.writeFileSync(configPath, json(raw));
  if (running) fs.writeFileSync(path.join(stateDir, "server.pid"), String(process.pid));
  return { name, stateKey, configPath, stateDir };
}

test("same name: no-op, nothing written", () => {
  const p = profile({ name: "solo" });
  const before = fs.readFileSync(p.configPath, "utf8");
  const res = renameProfile({ configPath: p.configPath, newName: "solo", registry });
  assert.deepEqual(res, { changed: false, running: false, from: "solo", to: "solo", stateKey: "solo" });
  assert.equal(fs.readFileSync(p.configPath, "utf8"), before);
});

test("invalid name: throws, nothing written", () => {
  const p = profile({ name: "bad-src" });
  const before = fs.readFileSync(p.configPath, "utf8");
  assert.throws(() => renameProfile({ configPath: p.configPath, newName: "has a space", registry }), /must match/);
  assert.throws(() => renameProfile({ configPath: p.configPath, newName: "", registry }), /must match/);
  assert.equal(fs.readFileSync(p.configPath, "utf8"), before);
});

test("collision with another profile's label: throws, nothing written", () => {
  profile({ name: "taken-label" });
  const p = profile({ name: "label-src" });
  const before = fs.readFileSync(p.configPath, "utf8");
  assert.throws(() => renameProfile({ configPath: p.configPath, newName: "taken-label", registry }), /collides/);
  assert.equal(fs.readFileSync(p.configPath, "utf8"), before);
});

test("collision with another profile's state key: throws, nothing written", () => {
  profile({ name: "other-label", stateId: "taken-state" });
  const p = profile({ name: "state-src" });
  const before = fs.readFileSync(p.configPath, "utf8");
  assert.throws(() => renameProfile({ configPath: p.configPath, newName: "taken-state", registry }), /collides/);
  assert.equal(fs.readFileSync(p.configPath, "utf8"), before);
});

test("renaming to one's own state key is allowed (no self-collision)", () => {
  const p = profile({ name: "self-src", stateId: "self-state" });
  const res = renameProfile({ configPath: p.configPath, newName: "self-state", registry });
  assert.equal(res.changed, true);
  assert.equal(res.stateKey, "self-state");
  assert.deepEqual(JSON.parse(fs.readFileSync(p.configPath, "utf8")), { name: "self-state", stateId: "self-state", repoPath: "/repo", tracker: { type: "github", pipeline: [{ id: "code" }] } });
});

test("successful rename inserts stateId, keeps state dir, and audits", () => {
  const p = profile({ name: "plain" });
  const res = renameProfile({ configPath: p.configPath, newName: "plainer", registry });
  assert.deepEqual(res, { changed: true, running: false, from: "plain", to: "plainer", stateKey: "plain" });
  const raw = JSON.parse(fs.readFileSync(p.configPath, "utf8"));
  assert.equal(raw.name, "plainer");
  assert.equal(raw.stateId, "plain");
  assert.ok(fs.existsSync(path.join(p.stateDir, "config-bak")));
  const audit = fs.readFileSync(path.join(p.stateDir, "ui-audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(audit[audit.length - 1].source, "cli");
  assert.deepEqual(audit[audit.length - 1].action, "rename");
  assert.deepEqual([audit[audit.length - 1].from, audit[audit.length - 1].to], ["plain", "plainer"]);
});

test("receiver running: reports running:true", () => {
  const p = profile({ name: "live", running: true });
  const res = renameProfile({ configPath: p.configPath, newName: "livelier", registry });
  assert.equal(res.running, true);
});

test("receiver down: reports running:false", () => {
  const p = profile({ name: "quiet" });
  const res = renameProfile({ configPath: p.configPath, newName: "quieter", registry });
  assert.equal(res.running, false);
});

test("assertSafeRename: rejects invalid JSON, a changed state key, and a wrong name", () => {
  const ok = JSON.stringify({ name: "new", stateId: "old", repoPath: "/r", tracker: { type: "github", pipeline: [{ id: "code" }] } });
  assert.doesNotThrow(() => assertSafeRename(ok, "new", "old"));
  assert.throws(() => assertSafeRename("{", "new", "old"), /not valid JSON/);
  assert.throws(() => assertSafeRename(ok.replace('"stateId":"old",', ""), "new", "old"), /state key/);
  assert.throws(() => assertSafeRename(ok, "other", "old"), /name is not/);
});
