import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// Boot wires ingress.onExit (src/engine/boot.js) to the heartbeat's ingressDown field, so a
// managed tunnel that dies after boot is visible to `status`/`doctor` instead of only the log.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createServe } from "../src/engine/boot.js";
import { createStore } from "../src/store.js";

/** @param {{ onExit?: boolean }} [o] */
function harness({ onExit = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-boot-ingress-"));
  const cfg = /** @type {any} */ ({
    name: "p", stateKey: "p", provider: "local", stateDir: dir, dataDir: dir, logDir: path.join(dir, "logs"), port: 0,
    pipeline: [{ id: "code" }], publicUrlFile: path.join(dir, "public_url.txt"), pidFile: path.join(dir, "server.pid"), controlSock: path.join(dir, "c.sock"),
  });
  const store = createStore(dir);
  /** @type {((reason: string) => void) | null} */
  let exitListener = null;
  const ingress = /** @type {any} */ ({
    describe: () => ({ name: "manual", ephemeral: false }),
    up: async () => ({ url: "https://x" }),
    down: async () => {},
    ...(onExit ? { onExit: (/** @type {(reason: string) => void} */ l) => (exitListener = l) } : {}),
  });
  /** @type {Record<string, any>[]} */
  const updates = [];
  const heartbeat = { update: (/** @type {Record<string, any>} */ p) => updates.push(p) };
  const state = /** @type {any} */ ({ server: http.createServer(), control: null });
  const serve = createServe(/** @type {any} */ ({
    cfg, state, store, sandbox: null, emit: () => {}, startedAt: new Date().toISOString(), reconcileOnBoot: false,
    adapter: { registerWebhook: async () => {}, unregisterWebhooks: async () => {}, advance: async () => {} },
    forge: null,
    ingress,
    heartbeat,
    queue: { enqueue: () => true },
    puller: { pull: async () => {} },
    quotaPacer: { reading: () => {} },
    restart: async () => ({}), decommission: async () => ({}), ops: {}, shutdown: () => {},
  }));
  const before = { SIGINT: process.listeners("SIGINT"), SIGTERM: process.listeners("SIGTERM") };
  const cleanup = () => {
    for (const sig of /** @type {const} */ (["SIGINT", "SIGTERM"])) for (const l of process.listeners(sig)) if (!before[sig].includes(l)) process.removeListener(sig, l);
    state.control?.close();
    state.server.close();
  };
  return { serve, updates, cleanup, fireExit: (/** @type {string} */ reason) => exitListener?.(reason) };
}

test("boot: registers ingress.onExit after up() and records ingressDown in the heartbeat on a tunnel crash", async () => {
  const h = harness();
  try {
    await h.serve();
    assert.ok(h.updates.some((u) => "url" in u && !("ingressDown" in u)), "a fresh boot heartbeat has no ingressDown");
    h.fireExit("exited (1)");
    const down = h.updates.find((u) => "ingressDown" in u);
    assert.ok(down, "ingressDown was recorded");
    assert.equal(down.ingressDown.reason, "exited (1)");
    assert.ok(typeof down.ingressDown.at === "string" && !Number.isNaN(Date.parse(down.ingressDown.at)));
  } finally {
    h.cleanup();
  }
});

test("boot: an ingress with no onExit (tailscale/manual) boots fine and never records ingressDown", async () => {
  const h = harness({ onExit: false });
  try {
    await h.serve();
    assert.ok(!h.updates.some((u) => "ingressDown" in u));
  } finally {
    h.cleanup();
  }
});
