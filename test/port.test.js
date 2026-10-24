import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// `claimedPorts` (the registered-profile → port map init/ls/doctor/start all read) and
// `pickPort`/`formatSkipped` (init --local's auto-pick + its reason line), offline: a tmp
// registry dir stands in for ~/.agenthook, no real sockets.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { claimedPorts, firstFreePort, formatSkipped, pickPort } from "../src/port.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ah-port-"));

/** A registered profile: a state dir with `profile.json` (+ optional `heartbeat.json`).
 * @param {string} registry @param {string} stateKey @param {{ configPath?: string, name?: string, port?: number }} [o] */
function registerProfile(registry, stateKey, { configPath, name, port } = {}) {
  const dir = path.join(registry, stateKey);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "profile.json"), JSON.stringify({ configPath: configPath ?? null, stateKey, name: name ?? stateKey }));
  if (port !== undefined) fs.writeFileSync(path.join(dir, "heartbeat.json"), JSON.stringify({ port }));
  return dir;
}

/** @param {string} dir @param {Record<string, any>} config */
function writeConfig(dir, config) {
  const file = path.join(dir, "agenthook.config.json");
  fs.writeFileSync(file, JSON.stringify(config));
  return file;
}

test("claimedPorts: a running profile's port comes from its heartbeat, not its config", () => {
  const registry = tmp();
  const cfgFile = writeConfig(registry, { port: 9999 });
  registerProfile(registry, "alpha", { configPath: cfgFile, port: 4200 });
  assert.deepEqual(claimedPorts({ registry }), [{ port: 4200, stateKey: "alpha", name: "alpha" }]);
});

test("claimedPorts: a stopped profile's port comes from its config", () => {
  const registry = tmp();
  const cfgFile = writeConfig(registry, { port: 5555 });
  registerProfile(registry, "alpha", { configPath: cfgFile });
  assert.deepEqual(claimedPorts({ registry }), [{ port: 5555, stateKey: "alpha", name: "alpha" }]);
});

test("claimedPorts: a config with no port key falls back to the 4123 default", () => {
  const registry = tmp();
  const cfgFile = writeConfig(registry, {});
  registerProfile(registry, "alpha", { configPath: cfgFile, name: "Alpha" });
  assert.deepEqual(claimedPorts({ registry }), [{ port: 4123, stateKey: "alpha", name: "Alpha" }]);
});

test("claimedPorts: a never-started profile (no profile.json marker) is not registered — skipped", () => {
  const registry = tmp();
  fs.mkdirSync(path.join(registry, "ghost"), { recursive: true });
  assert.deepEqual(claimedPorts({ registry }), []);
});

test("claimedPorts: a missing or unparsable config is skipped, never throws", () => {
  const registry = tmp();
  registerProfile(registry, "missing-config", { configPath: path.join(registry, "nope.json") });
  const badFile = path.join(registry, "bad.json");
  fs.writeFileSync(badFile, "{not json");
  registerProfile(registry, "bad-config", { configPath: badFile });
  assert.deepEqual(claimedPorts({ registry }), []);
});

test("claimedPorts: exclude by stateKey drops that profile", () => {
  const registry = tmp();
  const cfgFile = writeConfig(registry, { port: 4123 });
  registerProfile(registry, "alpha", { configPath: cfgFile });
  assert.deepEqual(claimedPorts({ registry, exclude: { stateKey: "alpha" } }), []);
});

test("claimedPorts: exclude by configPath drops that profile even under a different path spelling", () => {
  const registry = tmp();
  const cfgFile = writeConfig(registry, { port: 4123 });
  registerProfile(registry, "alpha", { configPath: cfgFile });
  const spelled = path.join(path.dirname(cfgFile), ".", path.basename(cfgFile));
  assert.deepEqual(claimedPorts({ registry, exclude: { configPath: spelled } }), []);
});

test("claimedPorts: an empty/absent registry returns [] without throwing", () => {
  assert.deepEqual(claimedPorts({ registry: path.join(tmp(), "does-not-exist") }), []);
});

test("firstFreePort: unaffected — still just skips listening ports", async () => {
  const inUse = async (/** @type {number} */ p) => p === 4123;
  assert.equal(await firstFreePort(4123, { inUse }), 4124);
});

test("pickPort: nothing claimed or listening → the first port, no skips", async () => {
  const r = await pickPort(4123, { inUse: async () => false });
  assert.deepEqual(r, { port: 4123, skipped: [] });
});

test("pickPort: a single claimed port is skipped and named", async () => {
  const r = await pickPort(4123, { inUse: async () => false, claimed: [{ port: 4123, name: "x" }] });
  assert.equal(r.port, 4124);
  assert.deepEqual(r.skipped, [{ from: 4123, to: 4123, reason: 'claimed by profile "x"' }]);
});

test("pickPort: a run of listening ports collapses into one skip entry", async () => {
  const inUse = async (/** @type {number} */ p) => p >= 4124 && p <= 4126;
  const r = await pickPort(4123, { inUse });
  assert.equal(r.port, 4123);
  assert.deepEqual(r.skipped, []);
});

test("pickPort: claimed 4123 + a listening run 4124-4126 → both reasons, formatted", async () => {
  const inUse = async (/** @type {number} */ p) => p >= 4124 && p <= 4126;
  const r = await pickPort(4123, { inUse, claimed: [{ port: 4123, name: "x" }] });
  assert.equal(r.port, 4127);
  assert.deepEqual(r.skipped, [
    { from: 4123, to: 4123, reason: 'claimed by profile "x"' },
    { from: 4124, to: 4126, reason: "in use" },
  ]);
  assert.equal(formatSkipped(r.skipped), '4123 claimed by profile "x", 4124–4126 in use');
});

test("pickPort: no free port within `tries` throws", async () => {
  await assert.rejects(() => pickPort(4123, { tries: 2, inUse: async () => true }), /no free port/);
});

test("formatSkipped: no skips → empty string", () => {
  assert.equal(formatSkipped([]), "");
});
