import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// The boot fullAuto banner (src/engine/banner.js, #476): its wording per sandbox setup, and boot
// still starting in every case (the banner warns, it never refuses).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fullAutoBanner } from "../src/engine/banner.js";
import { createServe } from "../src/engine/boot.js";
import { createStore } from "../src/store.js";

const PIPE = [{ id: "triage" }, { id: "code" }, { id: "done", manual: true }];

test("fullAutoBanner: null without fullAuto", () => {
  assert.equal(fullAutoBanner({ fullAuto: false, pipeline: PIPE }, { user: "ana" }), null);
  assert.equal(fullAutoBanner(/** @type {any} */ ({ sandbox: { type: "podman" }, pipeline: PIPE }), { user: "ana" }), null);
});

test("fullAutoBanner: fullAuto with no sandbox → the ⚠ block naming the user, the fix and doctor", () => {
  const b = String(fullAutoBanner({ fullAuto: true, pipeline: PIPE }, { user: "ana" }));
  assert.match(b, /⚠ {2}fullAuto is ON with NO sandbox/);
  assert.match(b, /executes code here as ana;/);
  assert.match(b, /never prompt/);
  assert.match(b, /agenthook doctor/);
  assert.doesNotMatch(b, /permission prompts/);
});

test("fullAutoBanner: steps with sandbox:false under a sandbox are named as running OUTSIDE it", () => {
  const cfg = /** @type {any} */ ({ fullAuto: true, sandbox: { type: "podman" }, pipeline: [{ id: "triage", sandbox: false }, { id: "code" }, { id: "ship", sandbox: false }, { id: "done", manual: true, sandbox: false }] });
  const b = String(fullAutoBanner(cfg, { user: "ana" }));
  assert.match(b, /fullAuto is ON and step\(s\) triage, ship run OUTSIDE the sandbox — /);
  assert.match(b, /never prompt/);
});

test("fullAutoBanner: every step sandboxed → one line with the type and egress mode", () => {
  assert.equal(fullAutoBanner(/** @type {any} */ ({ fullAuto: true, sandbox: { type: "podman" }, pipeline: PIPE }), { user: "ana" }), "[boot] fullAuto inside the podman sandbox — each run sees only its worktree; egress allowlist");
  assert.match(String(fullAutoBanner(/** @type {any} */ ({ fullAuto: true, sandbox: { type: "docker", egress: { mode: "none" } }, pipeline: PIPE }))), /inside the docker sandbox .* egress none$/);
});

test("fullAutoBanner: defaults the user to the OS account", () => {
  assert.ok(String(fullAutoBanner({ fullAuto: true, pipeline: PIPE })).includes(`as ${os.userInfo().username};`));
});

/** Boot a stub engine with `extra` merged into the config; resolves with the captured log lines. @param {any} extra */
async function boot(extra) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-boot-banner-"));
  const cfg = /** @type {any} */ ({
    name: "p", stateKey: "p", provider: "local", stateDir: dir, dataDir: dir, logDir: path.join(dir, "logs"), port: 0,
    pipeline: PIPE, publicUrlFile: path.join(dir, "public_url.txt"), pidFile: path.join(dir, "server.pid"), controlSock: path.join(dir, "c.sock"), ...extra,
  });
  const sandbox = cfg.sandbox ? { describe: () => ({ name: cfg.sandbox.type, home: "/home/agent" }), check: async () => ({ ok: true }), reap: async () => [] } : null;
  const state = /** @type {any} */ ({ server: http.createServer(), control: null });
  const serve = createServe(/** @type {any} */ ({
    cfg, state, store: createStore(dir), sandbox, emit: () => {}, startedAt: new Date().toISOString(), reconcileOnBoot: false,
    adapter: { registerWebhook: async () => {}, unregisterWebhooks: async () => {}, advance: async () => {} },
    forge: null,
    ingress: { describe: () => ({ name: "manual", ephemeral: false }), up: async () => ({ url: "https://x" }), down: async () => {} },
    heartbeat: { update: () => {} },
    queue: { enqueue: () => true },
    puller: { pull: async () => {} },
    quotaPacer: { reading: () => {} },
    restart: async () => ({}), decommission: async () => ({}), ops: {}, shutdown: () => {},
  }));
  const before = { SIGINT: process.listeners("SIGINT"), SIGTERM: process.listeners("SIGTERM") };
  /** @type {string[]} */
  const lines = [];
  const { log, error } = console;
  console.log = console.error = (/** @type {any[]} */ ...a) => void lines.push(a.join(" "));
  try {
    const result = await serve().catch((e) => e);
    return { result, lines, listening: state.server.listening };
  } finally {
    console.log = log;
    console.error = error;
    for (const sig of /** @type {const} */ (["SIGINT", "SIGTERM"])) for (const l of process.listeners(sig)) if (!before[sig].includes(l)) process.removeListener(sig, l);
    state.control?.close();
    state.server.close();
  }
}

test("boot: the server starts in every fullAuto/sandbox combination (the banner never refuses)", async () => {
  for (const [extra, want] of /** @type {[any, RegExp|null][]} */ ([
    [{ fullAuto: false }, null],
    [{ fullAuto: true }, /NO sandbox/],
    [{ fullAuto: true, sandbox: { type: "podman" }, pipeline: [{ id: "code", sandbox: false }] }, /step\(s\) code run OUTSIDE/],
    [{ fullAuto: true, sandbox: { type: "podman" } }, /fullAuto inside the podman sandbox/],
  ])) {
    const { result, lines, listening } = await boot(extra);
    assert.equal(result, undefined, String(result?.stack));
    assert.ok(listening, `not listening for ${JSON.stringify(extra)}`);
    if (want) assert.ok(lines.some((l) => want.test(l)), lines.join("\n"));
    else assert.ok(!lines.some((l) => /fullAuto/.test(l)), lines.join("\n"));
  }
});
