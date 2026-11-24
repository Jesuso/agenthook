import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// Restart preflight env (#821): a `restart` check must validate against the env the
// detached respawn will see — `respawnEnv()` + a fresh `.env` read — not the live
// process's in-memory values, which `process.loadEnvFile` can never un-set. A var removed
// from `.env` while the config still references it must refuse the restart (a crash loop
// for the fresh process is worse than a refusal).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileEnvKeys, loadConfig, loadEnv, registryDir, respawnEnv } from "../src/config.js";
import { createEngine, createRestartRequester } from "../src/engine.js";
import { createQueue } from "../src/queue.js";

const made = new Set();
test.after(() => {
  for (const k of made) fs.rmSync(path.join(registryDir, k), { recursive: true, force: true });
});

const job = (ref) => ({ kind: "pipeline", ref, stepId: "s", dedupKey: `${ref}:s` });
const info = (j) => ({ kind: j.kind, ref: j.ref, name: j.ref, url: "", code: 0 });

/** A config dir whose repoPath references a `${VAR}` (a real, non-`//` key). */
function makeConfig(dir, repoPath) {
  const file = path.join(dir, "agenthook.config.json");
  fs.writeFileSync(file, JSON.stringify({
    name: "ah-respawn-env-test",
    repoPath,
    tracker: { type: "asana", pipeline: [{ id: "code" }] },
  }));
  return file;
}

const envSnapshot = () => JSON.stringify(process.env);
const fileKeysSnapshot = () => [...fileEnvKeys.entries()];

test("a var loaded via .env, then removed from the file, refuses the preflight", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-cfg-re-"));
  const file = makeConfig(dir, "${AH_RE_GONE}");
  try {
    fs.writeFileSync(path.join(dir, ".env"), "AH_RE_GONE=stale\n");
    loadEnv(path.join(dir, ".env")); // the live receiver's boot: sets AND records the key
    assert.equal(process.env.AH_RE_GONE, "stale");
    assert.equal(fileEnvKeys.get("AH_RE_GONE"), "stale");
    const envBefore = envSnapshot();
    const keysBefore = fileKeysSnapshot();

    // The operator removes the var from .env while the config still references it.
    fs.writeFileSync(path.join(dir, ".env"), "");

    const preflight = () => loadConfig({ configPath: file, env: respawnEnv() });
    assert.throws(preflight, /unset environment variable\(s\)[\s\S]*AH_RE_GONE/);

    // The check is pure with respect to the live process: nothing reloaded, nothing recorded.
    assert.equal(envSnapshot(), envBefore, "preflight must not mutate process.env");
    assert.deepEqual(fileKeysSnapshot(), keysBefore, "preflight must not mutate fileEnvKeys");
  } finally {
    delete process.env.AH_RE_GONE;
    fileEnvKeys.delete("AH_RE_GONE");
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the same refusal arrives through the restart requester: refused, not pending, nothing paused", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-cfg-re-"));
  const file = makeConfig(dir, "${AH_RE_GONE2}");
  const releases = [];
  const queue = createQueue(1, (j) => new Promise((resolve) => releases.push(() => resolve(info(j)))));
  const r = createRestartRequester({
    queue,
    isDraining: () => false,
    // the preflight exactly as src/engine/index.js wires it
    validateConfig: () => void loadConfig({ configPath: file, env: respawnEnv() }),
    onPending: () => {},
    fire: () => {},
  });
  try {
    fs.writeFileSync(path.join(dir, ".env"), "AH_RE_GONE2=stale\n");
    loadEnv(path.join(dir, ".env"));
    fs.writeFileSync(path.join(dir, ".env"), ""); // removed before the restart request

    await assert.rejects(r.request({ when: "idle" }), /unset environment variable/);
    assert.equal(r.isPending(), false);
    queue.enqueue(job("A"));
    assert.equal(queue.state().active, 1, "queue still pumps");
  } finally {
    delete process.env.AH_RE_GONE2;
    fileEnvKeys.delete("AH_RE_GONE2");
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the engine's own restart preflight (createEngine wiring) refuses a removed .env var", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-cfg-re-"));
  const file = makeConfig(dir, "${AH_RE_ENGINE}");
  fs.writeFileSync(path.join(dir, ".env"), "AH_RE_ENGINE=stale\n");
  // The live receiver's boot: loadConfig loads .env into process.env and records the key.
  const cfg = loadConfig({ configPath: file });
  made.add(cfg.stateKey);
  try {
    assert.equal(process.env.AH_RE_ENGINE, "stale");
    assert.equal(fileEnvKeys.get("AH_RE_ENGINE"), "stale");

    // The operator removes the var from .env while the config still references it.
    fs.writeFileSync(path.join(dir, ".env"), "");

    const engine = createEngine(cfg);
    const hb = () => JSON.parse(fs.readFileSync(cfg.heartbeatFile, "utf8"));

    await assert.rejects(
      engine.requestRestart({ when: "idle" }),
      /unset environment variable\(s\) referenced by[\s\S]*AH_RE_ENGINE/,
    );
    assert.equal(hb().restartPending, undefined, "nothing went pending and nothing paused");

    // A second request fails the config check again, not "already pending": the refusal left no state.
    await assert.rejects(
      engine.requestRestart({ when: "idle" }),
      /unset environment variable/,
    );
    assert.equal(hb().restartPending, undefined);
  } finally {
    delete process.env.AH_RE_ENGINE;
    fileEnvKeys.delete("AH_RE_ENGINE");
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a shell-exported var (never file-recorded), absent or shadowed in .env, is accepted", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-cfg-re-"));
  const file = makeConfig(dir, "${AH_RE_SHELL}");
  try {
    process.env.AH_RE_SHELL = "shellval"; // exported before any loadEnv → never in fileEnvKeys
    fs.writeFileSync(path.join(dir, ".env"), "AH_RE_SHELL=fileval\n"); // a file value must not shadow it
    loadEnv(path.join(dir, ".env"));
    assert.equal(fileEnvKeys.has("AH_RE_SHELL"), false, "shell-exported var is never recorded");

    const cfg = loadConfig({ configPath: file, env: respawnEnv() });
    assert.equal(cfg.repoPath, path.resolve(dir, "shellval"), "shell-exported value wins over the .env file");
  } finally {
    delete process.env.AH_RE_SHELL;
    fileEnvKeys.delete("AH_RE_SHELL");
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a var still in .env with a new value resolves to the fresh file value", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-cfg-re-"));
  const file = makeConfig(dir, "${AH_RE_NEW}");
  try {
    fs.writeFileSync(path.join(dir, ".env"), "AH_RE_NEW=v1\n");
    loadEnv(path.join(dir, ".env")); // boot: stale value now in memory
    fs.writeFileSync(path.join(dir, ".env"), "AH_RE_NEW=v2\n"); // the operator edits the file

    const cfg = loadConfig({ configPath: file, env: respawnEnv() });
    assert.equal(cfg.repoPath, path.resolve(dir, "v2"), "the fresh .env value resolves");
    assert.equal(process.env.AH_RE_NEW, "v1", "the live process keeps its stale value untouched");
    assert.equal(fileEnvKeys.get("AH_RE_NEW"), "v1", "and its record is unchanged");
  } finally {
    delete process.env.AH_RE_NEW;
    fileEnvKeys.delete("AH_RE_NEW");
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig without opts.env is unchanged: it still loads .env and resolves from process.env", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-cfg-re-"));
  const file = makeConfig(dir, "${AH_RE_DEFAULT}");
  try {
    const keysBefore = fileKeysSnapshot();
    fs.writeFileSync(path.join(dir, ".env"), "AH_RE_DEFAULT=fromdotenv\n");
    const cfg = loadConfig({ configPath: file }); // default path
    assert.equal(cfg.repoPath, path.resolve(dir, "fromdotenv"));
    assert.equal(fileEnvKeys.get("AH_RE_DEFAULT"), "fromdotenv", "loadEnv recorded it, as before");
    assert.equal(fileKeysSnapshot().length, keysBefore.length + 1, "only the .env keys were added");
  } finally {
    delete process.env.AH_RE_DEFAULT;
    fileEnvKeys.delete("AH_RE_DEFAULT");
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
