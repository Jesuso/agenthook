import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// Boot with a sandbox (src/engine/boot.js): an unavailable sandbox aborts boot before the
// ingress comes up; orphaned runs are reaped (and logged) before crash recovery, which still runs.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createServe } from "../src/engine/boot.js";
import { createStore } from "../src/store.js";

/** @param {{check?: () => Promise<any>, reap?: () => Promise<string[]>}} sb */
function harness(sb) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-boot-sbx-"));
  const cfg = /** @type {any} */ ({
    name: "p", stateKey: "p", provider: "local", stateDir: dir, dataDir: dir, logDir: path.join(dir, "logs"), port: 0,
    pipeline: [{ id: "code" }], publicUrlFile: path.join(dir, "public_url.txt"), pidFile: path.join(dir, "server.pid"), controlSock: path.join(dir, "c.sock"),
  });
  const store = createStore(dir);
  /** @type {string[]} */
  const order = [];
  /** @type {any[]} */
  const advanced = [];
  const sandbox = /** @type {any} */ ({
    describe: () => ({ name: "docker", home: "/home/agent" }),
    check: sb.check ?? (async () => ({ ok: true })),
    reap: async () => {
      order.push("reap");
      return sb.reap ? sb.reap() : [];
    },
  });
  const state = /** @type {any} */ ({ server: http.createServer(), control: null });
  const serve = createServe(/** @type {any} */ ({
    cfg, state, store, sandbox, emit: () => {}, startedAt: new Date().toISOString(), reconcileOnBoot: false,
    adapter: {
      registerWebhook: async () => void order.push("register"),
      unregisterWebhooks: async () => {},
      advance: async (/** @type {string} */ ref, /** @type {string} */ step, /** @type {any} */ v) => void (order.push("recover"), advanced.push({ ref, step, ...v })),
    },
    forge: null,
    ingress: { describe: () => ({ name: "manual", ephemeral: false }), up: async () => (order.push("ingress.up"), { url: "https://x" }), down: async () => {} },
    heartbeat: { update: () => {} },
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
  return { serve, store, order, advanced, cleanup };
}

/** Run `fn` with console.log/error captured. @param {() => Promise<any>} fn */
async function captured(fn) {
  /** @type {string[]} */
  const lines = [];
  const { log, error } = console;
  console.log = console.error = (/** @type {any[]} */ ...a) => void lines.push(a.join(" "));
  try {
    return { result: await fn().catch((e) => e), lines };
  } finally {
    console.log = log;
    console.error = error;
  }
}

test("boot: a sandbox whose check() fails rejects serve() before ingress.up", async () => {
  const h = harness({ check: async () => ({ ok: false, reason: "sandbox image agenthook-agent:1 not found — run `agenthook doctor --fix`" }) });
  try {
    const { result } = await captured(() => h.serve());
    assert.ok(result instanceof Error);
    assert.equal(result.message, "sandbox (docker) unavailable: sandbox image agenthook-agent:1 not found — run `agenthook doctor --fix`");
    assert.deepEqual(h.order, [], "nothing brought up");
  } finally {
    h.cleanup();
  }
});

test("boot: reaped container names are logged, then recoverInterrupted still fails the interrupted run", async () => {
  const h = harness({ reap: async () => ["ah-p-7-code-aaaa"] });
  h.store.setRunning("7", { stepId: "code", startedAt: new Date().toISOString(), worktree: "/w", model: null });
  try {
    const { result, lines } = await captured(() => h.serve());
    assert.equal(result, undefined, String(result?.stack));
    assert.deepEqual(h.order, ["ingress.up", "register", "reap", "recover"]);
    assert.ok(lines.some((l) => l.includes("[recover] removed 1 orphaned sandbox container(s): ah-p-7-code-aaaa")), lines.join("\n"));
    assert.equal(h.advanced[0].outcome, "fail");
    assert.equal(h.advanced[0].reason, "interrupted by restart");
  } finally {
    h.cleanup();
  }
});

test("boot: a reap failure is logged and recovery continues", async () => {
  const h = harness({ reap: async () => { throw new Error("docker ps failed"); } });
  h.store.setRunning("7", { stepId: "code", startedAt: new Date().toISOString(), worktree: "/w", model: null });
  try {
    const { result, lines } = await captured(() => h.serve());
    assert.equal(result, undefined);
    assert.ok(lines.some((l) => l.includes("[recover] sandbox reap failed (continuing): docker ps failed")));
    assert.equal(h.advanced.length, 1);
  } finally {
    h.cleanup();
  }
});
