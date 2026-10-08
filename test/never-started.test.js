import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// Ghost profiles (#216): loadConfig creates no state dir, read-only commands tolerate a
// never-started profile without creating one, and the state writers that must not create it
// (catchup, reconcile, register, unregister) refuse with one exact message.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, registryDir } from "../src/config.js";
import { requireStarted, tildify } from "../src/profile.js";
import { doctor } from "../src/commands/doctor.js";
import { events } from "../src/commands/events.js";
import { usage } from "../src/commands/usage.js";
import { resume } from "../src/commands/resume.js";
import { status } from "../src/commands/status.js";
import { stop } from "../src/commands/stop.js";
import { catchup } from "../src/commands/catchup.js";
import { reconcile } from "../src/commands/reconcile.js";
import { register, unregister } from "../src/commands/webhook.js";

const NAME = "ah-never-started";

/** A config for a profile that has never been started; returns its path. */
function writeConfig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-never-"));
  const file = path.join(dir, "agenthook.config.json");
  fs.writeFileSync(
    file,
    JSON.stringify({ name: NAME, repoPath: dir, ingress: { type: "manual", url: "https://example.test" }, tracker: { type: "asana", token: "t", pipeline: [{ id: "code" }] } }),
  );
  return file;
}

const listing = () => (fs.existsSync(registryDir) ? fs.readdirSync(registryDir).sort() : []);

/** Run `fn` with console.log/console.error/stderr captured. @param {() => Promise<any>} fn */
async function capture(fn) {
  /** @type {string[]} */
  const out = [];
  const { log, error, warn } = console;
  const write = process.stderr.write;
  console.log = console.error = console.warn = (/** @type {any[]} */ ...a) => void out.push(a.join(" "));
  process.stderr.write = /** @type {any} */ ((/** @type {any} */ s) => (out.push(String(s)), true));
  try {
    await fn();
  } finally {
    Object.assign(console, { log, error, warn });
    process.stderr.write = write;
  }
  return out.join("\n");
}

test("loadConfig creates no directories", () => {
  const before = listing();
  const cfg = loadConfig({ configPath: writeConfig() });
  assert.ok(!fs.existsSync(cfg.stateDir));
  assert.deepEqual(listing(), before);
});

test("read-only commands run against a never-started profile and create nothing", async () => {
  const config = writeConfig();
  const before = listing();

  const doc = await capture(() => doctor({ _: [], config }));
  process.exitCode = 0; // claude/port checks may legitimately fail here; only the state line matters
  assert.match(doc, new RegExp(`^ℹ profile "${NAME}" — state dir not created yet \\(profile never started\\)`, "m"));

  const never = `profile "${NAME}" has never been started`;
  assert.match(await capture(() => events({ _: [], config })), new RegExp(never));
  assert.equal(await capture(() => events({ _: [], config, json: true })), "");
  assert.match(await capture(() => events({ _: [], config, follow: true })), new RegExp(never)); // returns, no watch

  await capture(() => usage({ _: [], config }));
  await capture(() => resume({ _: [], config }));
  await capture(() => status({ _: [], config }));
  assert.match(await capture(() => stop({ _: [], config, "keep-hooks": true })), /not running \(never started\)/);
  assert.match(await capture(() => stop({ _: [], config })), /not running \(never started\)/); // no hook unregister attempted

  assert.deepEqual(listing(), before);
});

test("catchup / reconcile / register / unregister refuse a never-started profile and create nothing", async () => {
  const config = writeConfig();
  const cfg = loadConfig({ configPath: config });
  const msg = `profile "${NAME}" has never been started (no state at ${tildify(cfg.stateDir)}/) — run \`agenthook start\` first`;
  assert.throws(() => requireStarted(cfg), (e) => /** @type {Error} */ (e).message === msg);

  const before = listing();
  for (const run of [
    () => catchup({ _: ["123"], config }),
    () => reconcile({ _: [], config }),
    () => register({ _: ["https://example.test"], config }),
    () => unregister({ _: [], config }),
  ]) {
    await assert.rejects(run, (e) => /** @type {Error} */ (e).message === msg);
  }
  assert.deepEqual(listing(), before);

  fs.mkdirSync(cfg.stateDir, { recursive: true });
  try {
    assert.doesNotThrow(() => requireStarted(cfg));
  } finally {
    fs.rmSync(cfg.stateDir, { recursive: true, force: true });
  }
});
