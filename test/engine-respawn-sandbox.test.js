import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// respawnSandboxCheck (#885): the restart requester's respawn-sandbox preflight — a stubbed
// runtime `run`, no container runtime needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { respawnSandboxCheck } from "../src/engine/index.js";
import { createSandbox } from "../src/sandbox/index.js";
import { DEFAULT_IMAGE } from "../src/sandbox/image.js";
import { stubRun, tmpCfg } from "./_sandbox-container-helpers.js";

const DISK_IMAGE = "agenthook-agent:9.9.9";

test("respawnSandboxCheck: the new tag is missing → throws a reason naming it", async () => {
  const missing = stubRun({ "image inspect": { code: 1, stderr: "Error: No such image" } });
  await assert.rejects(
    respawnSandboxCheck({
      loadNext: () => tmpCfg(),
      defaultImage: DISK_IMAGE,
      createSandbox: (cfg, opts) => createSandbox(cfg, { run: missing.run, ...opts }),
    }),
    new RegExp(`sandbox image ${DISK_IMAGE} not found`),
  );
});

test("respawnSandboxCheck: the image is present → resolves", async () => {
  const ok = stubRun({});
  await respawnSandboxCheck({
    loadNext: () => tmpCfg(),
    defaultImage: DISK_IMAGE,
    createSandbox: (cfg, opts) => createSandbox(cfg, { run: ok.run, ...opts }),
  });
  assert.deepEqual(ok.calls[1].slice(1), ["image", "inspect", DISK_IMAGE]);
});

test("respawnSandboxCheck: same version and image present → resolves", async () => {
  const ok = stubRun({});
  await respawnSandboxCheck({
    loadNext: () => tmpCfg(),
    defaultImage: DEFAULT_IMAGE, // disk version matches the running process's version
    createSandbox: (cfg, opts) => createSandbox(cfg, { run: ok.run, ...opts }),
  });
  assert.deepEqual(ok.calls[1].slice(1), ["image", "inspect", DEFAULT_IMAGE]);
});

test("respawnSandboxCheck: next.sandbox unset → resolves without calling run", async () => {
  let called = false;
  await respawnSandboxCheck({
    loadNext: () => /** @type {any} */ ({}),
    defaultImage: DISK_IMAGE,
    createSandbox: () => {
      called = true;
      return null;
    },
  });
  assert.equal(called, false);
});
