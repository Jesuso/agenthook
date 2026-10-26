import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// `agenthook digest` — pickProfile wiring, config-load/state-dir-mismatch refusals, output
// shape, and the down-vs-up events.jsonl emit. No real `claude` process (injected `run`).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registryDir } from "../src/config.js";
import { digest } from "../src/commands/digest.js";

// Like test/rename.test.js: a profile's config file lives anywhere, but its state dir must be
// under the real registry (AGENTHOOK_HOME, set once by _setup.js) so `cfg.stateDir` matches the
// entry's recorded `dir`.
const registry = registryDir;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "ah-digest-cmd-"));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const json = (v) => JSON.stringify(v, null, 2) + "\n";

/** @param {{name: string, stateId?: string, running?: boolean, badConfig?: boolean}} o */
function profile({ name, stateId, running = false, badConfig = false }) {
  const stateKey = stateId ?? name;
  const stateDir = path.join(registry, stateKey);
  fs.mkdirSync(stateDir, { recursive: true });
  const configPath = path.join(root, "cfg", name, "agenthook.config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const raw = badConfig ? "{ not json" : json({ name, repoPath: "/repo", tracker: { type: "github", pipeline: [{ id: "code" }] }, ...(stateId ? { stateId } : {}) });
  fs.writeFileSync(configPath, raw);
  fs.writeFileSync(path.join(stateDir, "profile.json"), json({ configPath, stateKey, name, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));
  if (running) fs.writeFileSync(path.join(stateDir, "server.pid"), String(process.pid));
  return { name, stateKey, configPath, stateDir };
}

function capture() {
  const out = [];
  const err = [];
  const log = console.log;
  const error = console.error;
  console.log = (...a) => out.push(a.join(" "));
  console.error = (...a) => err.push(a.join(" "));
  return { out, err, restore: () => ((console.log = log), (console.error = error)) };
}

test("unknown profile: error, non-zero exit", async () => {
  const c = capture();
  try {
    process.exitCode = 0;
    await digest({ _: ["nope"] });
    assert.equal(process.exitCode, 1);
    assert.match(c.err[0], /unknown profile/);
  } finally {
    c.restore();
    process.exitCode = 0;
  }
});

test("receiver down: writes digest.json, prints text + footer, appends digest_start/end", async () => {
  const p = profile({ name: "down-one" });
  const run = async () => JSON.stringify({ result: "All quiet.", total_cost_usd: 0.02 });
  const c = capture();
  try {
    process.exitCode = 0;
    await digest({ _: [p.name] }, { run });
    assert.equal(process.exitCode, 0);
    assert.equal(c.out[0], "All quiet.");
    assert.match(c.out[1], /^generated .*\$0\.02$/);
    const rec = JSON.parse(fs.readFileSync(path.join(p.stateDir, "digest.json"), "utf8"));
    assert.equal(rec.byLang.en.text, "All quiet.", "no language configured: the en entry");
    const lines = fs.readFileSync(path.join(p.stateDir, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((l) => l.event), ["digest_start", "digest_end"]);
  } finally {
    c.restore();
    process.exitCode = 0;
  }
});

test("receiver up: no events.jsonl write", async () => {
  const p = profile({ name: "up-one", running: true });
  const run = async () => JSON.stringify({ result: "Busy.", total_cost_usd: 0.01 });
  const c = capture();
  try {
    await digest({ _: [p.name] }, { run });
  } finally {
    c.restore();
  }
  assert.ok(!fs.existsSync(path.join(p.stateDir, "events.jsonl")));
});

test("--json prints the DigestView", async () => {
  const p = profile({ name: "json-one" });
  const run = async () => JSON.stringify({ result: "Hi.", total_cost_usd: 0.03 });
  const c = capture();
  try {
    await digest({ _: [p.name], json: true }, { run });
  } finally {
    c.restore();
  }
  const rec = JSON.parse(c.out[0]);
  assert.equal(rec.text, "Hi.");
  assert.equal(rec.costUsd, 0.03);
});

test("missing config file: error, non-zero exit", async () => {
  const p = profile({ name: "ghost-cfg" });
  fs.rmSync(p.configPath);
  const c = capture();
  try {
    process.exitCode = 0;
    await digest({ _: [p.name] });
    assert.equal(process.exitCode, 1);
    assert.match(c.err[0], /no usable config/);
  } finally {
    c.restore();
    process.exitCode = 0;
  }
});

test("unloadable config: error, non-zero exit", async () => {
  const p = profile({ name: "bad-cfg", badConfig: true });
  const c = capture();
  try {
    process.exitCode = 0;
    await digest({ _: [p.name] });
    assert.equal(process.exitCode, 1);
    assert.match(c.err[0], /cannot load config/);
  } finally {
    c.restore();
    process.exitCode = 0;
  }
});

test("state-dir mismatch (stateId changed after the profile dir was created): refuses", async () => {
  const p = profile({ name: "moved" });
  // Rewrite the config with a different stateId so it now resolves elsewhere; the profile
  // marker (and so the picked entry's `dir`) still points at the original dir.
  const raw = JSON.parse(fs.readFileSync(p.configPath, "utf8"));
  raw.stateId = "moved-elsewhere";
  fs.writeFileSync(p.configPath, json(raw));
  const c = capture();
  try {
    process.exitCode = 0;
    await digest({ _: [p.name] });
    assert.equal(process.exitCode, 1);
    assert.match(c.err[0], /different state dir/);
  } finally {
    c.restore();
    process.exitCode = 0;
  }
});

test("digest agent failure: error, non-zero exit", async () => {
  const p = profile({ name: "fails" });
  const run = async () => JSON.stringify({ is_error: true, result: "boom" });
  const c = capture();
  try {
    process.exitCode = 0;
    await digest({ _: [p.name] }, { run });
    assert.equal(process.exitCode, 1);
    assert.match(c.err[0], /boom/);
  } finally {
    c.restore();
    process.exitCode = 0;
  }
});
