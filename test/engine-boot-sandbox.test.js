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

/** @param {{check?: () => Promise<any>, reap?: () => Promise<{containers: string[], networks: string[], runs: string[]}>}} sb */
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
  /** @type {any[]} */
  const emitted = [];
  const sandbox = /** @type {any} */ ({
    describe: () => ({ name: "docker", home: "/home/agent" }),
    check: sb.check ?? (async () => ({ ok: true })),
    reap: async () => {
      order.push("reap");
      return sb.reap ? sb.reap() : { containers: [], networks: [], runs: [] };
    },
  });
  const state = /** @type {any} */ ({ server: http.createServer(), control: null });
  const serve = createServe(/** @type {any} */ ({
    cfg, state, store, sandbox, emit: (/** @type {string} */ event, /** @type {string} */ ref, /** @type {string} */ step, /** @type {any} */ extra) => emitted.push({ event, ref, step, ...extra }), startedAt: new Date().toISOString(), reconcileOnBoot: false,
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
  return { serve, store, order, advanced, emitted, cleanup };
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

test("boot: reaped containers/networks are logged with the run(s) they came from, then recoverInterrupted still fails the interrupted run", async () => {
  const h = harness({ reap: async () => ({ containers: ["a", "b", "c"], networks: ["n1"], runs: ["12/code"] }) });
  h.store.setRunning("7", { stepId: "code", startedAt: new Date().toISOString(), worktree: "/w", model: null });
  try {
    const { result, lines } = await captured(() => h.serve());
    assert.equal(result, undefined, String(result?.stack));
    assert.deepEqual(h.order, ["ingress.up", "register", "reap", "recover"]);
    assert.ok(lines.includes("[recover] reaped 3 container(s), 1 network(s) left by run 12/code"), lines.join("\n"));
    assert.deepEqual(h.emitted.find((e) => e.event === "sandbox_reaped"), { event: "sandbox_reaped", ref: "", step: "", containers: 3, networks: 1, runs: ["12/code"] });
    assert.equal(h.advanced[0].outcome, "fail");
    assert.equal(h.advanced[0].reason, "interrupted by restart");
  } finally {
    h.cleanup();
  }
});

test("boot: no runs labels → 'left by a previous run'; nothing reaped → no line, no event", async () => {
  const h = harness({ reap: async () => ({ containers: ["a"], networks: [], runs: [] }) });
  try {
    const { lines } = await captured(() => h.serve());
    assert.ok(lines.includes("[recover] reaped 1 container(s), 0 network(s) left by a previous run"), lines.join("\n"));
  } finally {
    h.cleanup();
  }

  const h2 = harness({ reap: async () => ({ containers: [], networks: [], runs: [] }) });
  try {
    const { lines } = await captured(() => h2.serve());
    assert.ok(!lines.some((l) => l.includes("[recover] reaped")), lines.join("\n"));
    assert.ok(!h2.emitted.some((e) => e.event === "sandbox_reaped"));
  } finally {
    h2.cleanup();
  }
});

test("boot: networks-only leftovers (0 containers) still log the line and emit the event", async () => {
  const h = harness({ reap: async () => ({ containers: [], networks: ["n1"], runs: [] }) });
  try {
    const { lines } = await captured(() => h.serve());
    assert.ok(lines.includes("[recover] reaped 0 container(s), 1 network(s) left by a previous run"), lines.join("\n"));
    assert.deepEqual(h.emitted.find((e) => e.event === "sandbox_reaped"), { event: "sandbox_reaped", ref: "", step: "", containers: 0, networks: 1, runs: [] });
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
