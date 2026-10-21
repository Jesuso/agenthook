import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// Boot's tracker retry (src/engine/boot-retry.js + its use in src/engine/boot.js): a tracker
// 5xx/429/network error retries indefinitely on a capped backoff, a 404 three times, anything
// else fails at once; the heartbeat says `starting` meanwhile, and a give-up downs the ingress.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createServe } from "../src/engine/boot.js";
import { createStore } from "../src/store.js";
import { abortableSleep, classifyTrackerError, retryTrackerCall, transientDelayMs } from "../src/engine/boot-retry.js";

const httpErr = (/** @type {number} */ status) => Object.assign(new Error(`HTTP ${status}`), { status });

test("classifyTrackerError: 5xx/429/network/timeout → transient, 404 → not_found, the rest → fatal", () => {
  for (const s of [500, 502, 503, 429]) assert.equal(classifyTrackerError(httpErr(s)), "transient", String(s));
  assert.equal(classifyTrackerError(httpErr(404)), "not_found");
  for (const s of [400, 401, 403, 422]) assert.equal(classifyTrackerError(httpErr(s)), "fatal", String(s));
  assert.equal(classifyTrackerError(new TypeError("fetch failed")), "transient");
  assert.equal(classifyTrackerError(new TypeError("fetch failed", { cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }) })), "transient");
  assert.equal(classifyTrackerError(Object.assign(new Error("x"), { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } })), "transient");
  assert.equal(classifyTrackerError(Object.assign(new Error("t"), { name: "TimeoutError" })), "transient");
  assert.equal(classifyTrackerError(new Error("Asana: boom")), "fatal");
  assert.equal(classifyTrackerError(new SyntaxError("Unexpected token <")), "fatal");
  assert.equal(classifyTrackerError(new TypeError("x is not a function")), "fatal");
});

test("transient backoff: 5, 10, 20, 40, 80, 160, 300, 300… seconds, never above 300", () => {
  assert.deepEqual(Array.from({ length: 9 }, (_, i) => transientDelayMs(i) / 1000), [5, 10, 20, 40, 80, 160, 300, 300, 300]);
  for (let i = 0; i < 200; i++) assert.ok(transientDelayMs(i) <= 300_000);
});

test("retryTrackerCall: the default transient waits follow the capped backoff", async () => {
  /** @type {number[]} */
  const waits = [];
  let calls = 0;
  await retryTrackerCall(
    async () => {
      if (++calls <= 8) throw httpErr(503);
    },
    { log: () => {}, sleep: async (ms) => void waits.push(ms / 1000) },
  );
  assert.deepEqual(waits, [5, 10, 20, 40, 80, 160, 300, 300]);
});

test("retryTrackerCall: a 404 retries 3 times (10/20/30 s, counted across transients), then rethrows", async () => {
  /** @type {number[]} */
  const waits = [];
  const seq = [httpErr(404), httpErr(500), httpErr(404), httpErr(404), httpErr(404)];
  let calls = 0;
  const err = await retryTrackerCall(
    async () => {
      throw seq[calls++];
    },
    { log: () => {}, sleep: async (ms) => void waits.push(ms / 1000) },
  ).catch((e) => e);
  assert.equal(err, seq[4]);
  assert.equal(calls, 5);
  assert.deepEqual(waits, [10, 5, 20, 30]);
});

test("retryTrackerCall: aborting the signal mid-wait rejects promptly with no further call", async () => {
  const ac = new AbortController();
  let calls = 0;
  const started = Date.now();
  const p = retryTrackerCall(
    async () => {
      calls++;
      throw httpErr(502);
    },
    { log: () => {}, onWaiting: () => setImmediate(() => ac.abort(new Error("stop"))), signal: ac.signal, delays: { transient: () => 60_000 } },
  );
  await assert.rejects(p, /stop/);
  assert.equal(calls, 1);
  assert.ok(Date.now() - started < 5000, "did not wait out the 60 s delay");
});

test("retryTrackerCall: an abort while fn is in flight rejects even if fn then resolves", async () => {
  const ac = new AbortController();
  const p = retryTrackerCall(
    async () => {
      setTimeout(() => ac.abort(new Error("SIGTERM")), 10);
      await new Promise((r) => setTimeout(r, 50));
      return "registered";
    },
    { log: () => {}, signal: ac.signal },
  );
  await assert.rejects(p, /SIGTERM/);
});

test("retryTrackerCall: an abort while fn never settles rejects promptly", async () => {
  const ac = new AbortController();
  const started = Date.now();
  setTimeout(() => ac.abort(new Error("stop")), 10);
  await assert.rejects(retryTrackerCall(() => new Promise(() => {}), { log: () => {}, signal: ac.signal }), /stop/);
  assert.ok(Date.now() - started < 5000, "did not wait on the hung call");
});

test("abortableSleep rejects at once on an already-aborted signal, resolves otherwise", async () => {
  await abortableSleep(1);
  await assert.rejects(abortableSleep(60_000, AbortSignal.abort(new Error("gone"))), /gone/);
});

/** @param {() => Promise<void>} register */
function harness(register) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-boot-retry-"));
  const cfg = /** @type {any} */ ({
    name: "p", stateKey: "p", provider: "local", stateDir: dir, dataDir: dir, logDir: path.join(dir, "logs"), port: 0,
    pipeline: [{ id: "code" }], publicUrlFile: path.join(dir, "public_url.txt"), pidFile: path.join(dir, "server.pid"), controlSock: path.join(dir, "c.sock"),
  });
  const store = createStore(dir);
  /** @type {string[]} */
  const order = [];
  /** @type {any[]} */
  const beats = [];
  /** @type {number[]} */
  const waits = [];
  let registers = 0;
  const state = /** @type {any} */ ({ server: http.createServer(), control: null });
  const serve = createServe(/** @type {any} */ ({
    cfg, state, store, sandbox: null, emit: () => {}, startedAt: new Date().toISOString(), reconcileOnBoot: false,
    adapter: {
      registerWebhook: async () => {
        registers++;
        await register();
        order.push("register");
      },
      unregisterWebhooks: async () => {},
      advance: async () => void order.push("recover"),
    },
    forge: null,
    ingress: { describe: () => ({ name: "manual", ephemeral: false }), up: async () => (order.push("ingress.up"), { url: "https://x" }), down: async () => void order.push("ingress.down") },
    heartbeat: { update: (/** @type {any} */ p) => void beats.push(p) },
    queue: { enqueue: () => (order.push("restore"), true) },
    puller: { pull: async () => void order.push("pull") },
    quotaPacer: { reading: () => {} },
    restart: async () => ({}), decommission: async () => ({}), ops: {}, shutdown: () => {},
    retry: { sleep: async (/** @type {number} */ ms) => void waits.push(ms) },
  }));
  const before = { SIGINT: process.listeners("SIGINT"), SIGTERM: process.listeners("SIGTERM") };
  const cleanup = () => {
    for (const sig of /** @type {const} */ (["SIGINT", "SIGTERM"])) for (const l of process.listeners(sig)) if (!before[sig].includes(l)) process.removeListener(sig, l);
    state.control?.close();
    state.server.close();
  };
  return { serve, store, order, beats, waits, registers: () => registers, cleanup, before };
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

test("boot: registerWebhook 500 twice then OK — boot completes, two retry lines, heartbeat starting → null, recovery/restore/pull after", async () => {
  let n = 0;
  const h = harness(async () => {
    if (++n <= 2) throw httpErr(500);
  });
  h.store.setRunning("7", { stepId: "code", startedAt: new Date().toISOString(), worktree: "/w", model: null });
  h.store.addQueued({ kind: "pipeline", ref: "9", stepId: "code", dedupKey: "step:code:9" });
  try {
    const { result, lines } = await captured(() => h.serve());
    assert.equal(result, undefined, String(result?.stack));
    const retries = lines.filter((l) => l.startsWith("[boot] tracker unavailable, retrying in"));
    assert.deepEqual(retries, ["[boot] tracker unavailable, retrying in 5s (HTTP 500)", "[boot] tracker unavailable, retrying in 10s (HTTP 500)"]);
    assert.deepEqual(h.waits, [5000, 10000]);
    const starting = h.beats.filter((b) => "starting" in b);
    assert.deepEqual(starting, [{ starting: "tracker unavailable" }, { starting: null }]);
    assert.deepEqual(h.order, ["ingress.up", "register", "recover", "restore", "pull"]);
    // The temporary abort listeners are gone; only serve()'s real handlers were added.
    assert.equal(process.listeners("SIGTERM").length, h.before.SIGTERM.length + 1);
  } finally {
    h.cleanup();
  }
});

test("boot: a 404 is retried 3 times (4 calls), then boot rejects and the ingress is downed", async () => {
  const h = harness(async () => {
    throw httpErr(404);
  });
  try {
    const { result, lines } = await captured(() => h.serve());
    assert.ok(result instanceof Error);
    assert.equal(result.status, 404);
    assert.equal(h.registers(), 4);
    assert.deepEqual(h.waits, [10_000, 20_000, 30_000]);
    assert.equal(lines.filter((l) => l.startsWith("[boot] tracker unavailable")).length, 3);
    assert.ok(h.order.includes("ingress.down"));
  } finally {
    h.cleanup();
  }
});

test("boot: a 401/403 rejects on the first call with no retry line", async () => {
  for (const status of [401, 403]) {
    const h = harness(async () => {
      throw httpErr(status);
    });
    try {
      const { result, lines } = await captured(() => h.serve());
      assert.equal(result.status, status);
      assert.equal(h.registers(), 1);
      assert.ok(!lines.some((l) => l.includes("tracker unavailable")), lines.join("\n"));
      assert.ok(!h.beats.some((b) => "starting" in b));
      assert.ok(h.order.includes("ingress.down"));
    } finally {
      h.cleanup();
    }
  }
});
