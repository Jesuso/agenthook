import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// #689: shutdown (createExits' killChildren, via forceExit) must reap every remote harness's
// leftover runs, not just the profile's sandbox. process.exit is stubbed for the duration (and
// restored only after teardown()'s own unref'd 1.5s fallback timer would have fired) so this
// test never actually ends the test process.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createExits } from "../src/engine/teardown.js";

test("shutdown: forceExit reaps every remote (ssh) harness's leftover runs, not just the sandbox's", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-teardown-ssh-"));
  const origExit = process.exit;
  /** @type {number[]} */
  const exitCalls = [];
  process.exit = /** @type {any} */ ((code) => {
    exitCalls.push(code);
  });
  try {
    let reaped = false;
    const sshExecutor = { name: "ssh", reap: async () => { reaped = true; return { containers: [], networks: [], runs: ["7/code"] }; } };
    const exits = createExits(/** @type {any} */ ({
      cfg: { pidFile: path.join(dir, "server.pid"), stateDir: dir, stateKey: "p", name: "p", configPath: path.join(dir, "agenthook.config.json"), installDir: dir },
      state: { server: { close: (cb) => cb && cb() }, control: null, finished: false, respawnOnExit: false, archiveOnExit: false },
      queue: { close: () => {}, state: () => ({ active: 0, queued: 0 }), onIdle: async () => {}, onActiveIdle: async () => {} },
      ingress: { down: async () => {} },
      heartbeat: { update: () => {}, clear: () => {} },
      children: new Set(),
      store: { listRunning: () => ({}) },
      quotaPacer: { stop: () => {} },
      sandbox: null,
      executors: { host: { name: "host", paths: () => ({}), launch: async () => ({}) }, ssh: { worker: sshExecutor } },
      isRestartPending: () => false,
      isDecommissionPending: () => false,
    }));
    await exits.forceExit("test shutdown");
    assert.ok(reaped, "the ssh executor's reap() must run on a forced shutdown");
    assert.ok(exitCalls.includes(0), "teardown must still exit cleanly");
  } finally {
    // teardown()'s own fallback is `setTimeout(() => process.exit(exitCode), 1500).unref()` —
    // outlive it before restoring the real process.exit.
    await new Promise((r) => setTimeout(r, 1600));
    process.exit = origExit;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
