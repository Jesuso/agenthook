import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// `ah ui` sandbox readiness card, server side — sandboxReadiness over doctor's stubbed probes
// (no docker, no network) and `GET /api/sandbox-readiness` (cookie, 400/404, the type override).
// Temp registry + temp config files; ephemeral 127.0.0.1 port.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { DEFAULT_IMAGE } from "../src/sandbox/image.js";
import { sandboxReadiness } from "../src/ui/sandbox.js";
import { createUiServer } from "../src/ui/server.js";

const TOKEN = "t0k3n-abcdefghijklmnopqrstuvwxyz0123456789";

// realpath: macOS' tmpdir is a symlink, and configPath is compared exactly.
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ah-ui-sandbox-")));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const registry = path.join(root, "registry");
fs.mkdirSync(path.join(root, "dist"));

/** A profile whose heartbeat publishes its config (root/cfg/<name>/), with `env` as its `.env` when given.
 * @param {string} name @param {Record<string, any>} cfg @param {string} [env] */
function profile(name, cfg, env) {
  const dir = path.join(registry, name);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(root, "cfg", name, "agenthook.config.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ name, ...cfg }));
  if (env !== undefined) fs.writeFileSync(path.join(path.dirname(file), ".env"), env);
  fs.writeFileSync(path.join(dir, "heartbeat.json"), JSON.stringify({ name, configPath: file }));
}

profile("ready", { sandbox: { type: "docker" } }, "CLAUDE_CODE_OAUTH_TOKEN=secret\n");
profile("noenv", { sandbox: { type: "docker" } });
profile("nocred", { sandbox: { type: "docker", image: "mine:1" } }, "OTHER=x\nCLAUDE_CODE_OAUTH_TOKEN=\n");
profile("off", {});
fs.mkdirSync(path.join(registry, "nohb"), { recursive: true });

/** `run` stub: "arg0" or "arg0 arg1" → exit code; every call recorded.
 * @param {Record<string, number>} [codes] */
function stubRun(codes = {}) {
  /** @type {{ bin: string, args: string[] }[]} */
  const calls = [];
  const run = /** @type {import('../src/types.js').IngressRun} */ (
    async (bin, args) => (calls.push({ bin, args }), { code: codes[args.slice(0, 2).join(" ")] ?? codes[args[0]] ?? 0, stdout: "", stderr: "Cannot connect to the Docker daemon" })
  );
  return { run, calls };
}

/** `build` stub: records every call — there must be none, the UI never builds an image. */
function stubBuild() {
  /** @type {string[][]} */
  const calls = [];
  /** @param {string} bin @param {string[]} args */
  const build = (bin, args) => (calls.push([bin, ...args]), { status: 0 });
  return { build, calls };
}

/** @param {any} r @param {string} id */
const row = (r, id) => r.rows.find((/** @type {any} */ x) => x.id === id);

test("sandboxReadiness: all ✓ — runtime, image and credential, and the token value appears nowhere", async () => {
  const { run, calls } = stubRun();
  const { build, calls: builds } = stubBuild();
  const r = await sandboxReadiness(registry, "ready", { run, has: () => true, build });
  assert.equal(r?.enabled, true);
  assert.equal(r?.type, "docker");
  assert.equal(r?.image, DEFAULT_IMAGE);
  assert.deepEqual(r?.rows.map((x) => [x.id, x.ok]), [["runtime", true], ["image", true], ["credential", true]]);
  assert.ok(r?.rows.every((x) => !x.remedy));
  assert.ok(!JSON.stringify(r).includes("secret"));
  // Read-only probes only: `info` and `image inspect`, never a build.
  assert.deepEqual(calls.map((c) => c.args), [["info"], ["image", "inspect", DEFAULT_IMAGE]]);
  assert.equal(builds.length, 0);
});

test("sandboxReadiness: runtime binary missing → runtime ✗ with the install remedy, image not checked", async () => {
  const { run, calls } = stubRun();
  const r = await sandboxReadiness(registry, "ready", { run, has: () => false });
  assert.equal(row(r, "runtime").ok, false);
  assert.match(row(r, "runtime").remedy, /^install docker or put it on PATH/);
  assert.deepEqual(row(r, "image"), { id: "image", ok: false, label: `sandbox image present: ${DEFAULT_IMAGE}`, note: "not checked — runtime unavailable", remedy: row(r, "runtime").remedy });
  assert.equal(calls.length, 0);
});

test("sandboxReadiness: `info` failing → runtime ✗ (daemon remedy), image row 'not checked'", async () => {
  const { run, calls } = stubRun({ info: 1 });
  const r = await sandboxReadiness(registry, "ready", { run, has: () => true });
  assert.equal(row(r, "runtime").ok, false);
  assert.equal(row(r, "runtime").note, "Cannot connect to the Docker daemon");
  assert.match(row(r, "runtime").remedy, /^start the docker daemon\/socket/);
  assert.equal(row(r, "image").ok, false);
  assert.equal(row(r, "image").note, "not checked — runtime unavailable");
  assert.deepEqual(calls.map((c) => c.args), [["info"]]);
});

test("sandboxReadiness: default image missing → ✗ with `agenthook doctor --fix`, and nothing is built", async () => {
  const { run } = stubRun({ "image inspect": 1 });
  const { build, calls: builds } = stubBuild();
  const r = await sandboxReadiness(registry, "ready", { run, has: () => true, build });
  assert.deepEqual(row(r, "image"), { id: "image", ok: false, label: `sandbox image present: ${DEFAULT_IMAGE}`, note: "missing", remedy: "agenthook doctor --fix" });
  // doctor's fix for the default image calls `build` (a real `docker build`); the UI never applies it.
  assert.equal(builds.length, 0);
});

test("sandboxReadiness: a custom image missing → ✗ with doctor's manual build remedy", async () => {
  const { run } = stubRun({ "image inspect": 1 });
  const r = await sandboxReadiness(registry, "nocred", { run, has: () => true });
  assert.equal(r?.image, "mine:1");
  assert.match(row(r, "image").remedy, /^build mine:1 \(FROM /);
});

test("sandboxReadiness: no .env, or one without a non-empty credential var → credential ✗ with the setup-token remedy", async () => {
  const { run } = stubRun();
  for (const p of ["noenv", "nocred"]) {
    const cred = row(await sandboxReadiness(registry, p, { run, has: () => true }), "credential");
    assert.equal(cred.ok, false, p);
    assert.match(cred.remedy, /^claude setup-token, then add CLAUDE_CODE_OAUTH_TOKEN=… to .*\.env \(or ANTHROPIC_API_KEY\)$/);
  }
});

test("sandboxReadiness: unknown profile / no configPath → null; no sandbox and no type → disabled; type overrides", async () => {
  const { run, calls } = stubRun();
  assert.equal(await sandboxReadiness(registry, "nope", { run, has: () => true }), null);
  assert.equal(await sandboxReadiness(registry, "nohb", { run, has: () => true }), null);
  assert.deepEqual(await sandboxReadiness(registry, "off", { run, has: () => true }), { enabled: false, rows: [] });
  assert.equal(calls.length, 0);
  const r = await sandboxReadiness(registry, "off", { type: "podman", run, has: () => true });
  assert.equal(r?.type, "podman");
  assert.equal(calls[0].bin, process.env.PODMAN || "podman");
});

// --- GET /api/sandbox-readiness ---

/** @type {Record<string, number>} */
const probeCodes = {};
const probes = stubRun(probeCodes);
const builder = stubBuild();
const server = createUiServer({ port: 0, token: TOKEN, distDir: path.join(root, "dist"), registry, sandboxIo: { run: probes.run, has: () => true, build: builder.build } });
/** @type {number} */
let port;
test.before(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", () => r(undefined)));
  const a = server.address();
  port = a && typeof a === "object" ? a.port : 0;
});
test.after(() => new Promise((r) => server.close(() => r(undefined))));

/** @param {string} p @param {boolean} [cookie] @returns {Promise<{ status: number, body: string }>} */
function get(p, cookie = true) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port, path: p, headers: cookie ? { cookie: `ah_ui=${TOKEN}` } : {} }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode || 0, body }));
    });
    r.on("error", reject);
    r.end();
  });
}

test("GET /api/sandbox-readiness: no cookie 401, unknown profile 404, bad type 400", async () => {
  assert.equal((await get("/api/sandbox-readiness?profile=ready", false)).status, 401);
  assert.equal((await get("/api/sandbox-readiness?profile=nope")).status, 404);
  assert.equal((await get("/api/sandbox-readiness?profile=nohb")).status, 404);
  assert.equal((await get("/api/sandbox-readiness?profile=ready&type=evil")).status, 400);
  assert.equal((await get("/api/sandbox-readiness?profile=ready&type=")).status, 400);
});

test("GET /api/sandbox-readiness: the three rows, no secret; disabled without a sandbox; type=podman overrides", async () => {
  const ready = await get("/api/sandbox-readiness?profile=ready");
  assert.equal(ready.status, 200);
  assert.deepEqual(JSON.parse(ready.body).rows.map((/** @type {any} */ x) => [x.id, x.ok]), [["runtime", true], ["image", true], ["credential", true]]);
  assert.ok(!ready.body.includes("secret"));
  const off = await get("/api/sandbox-readiness?profile=off");
  assert.deepEqual(JSON.parse(off.body), { enabled: false, rows: [] });
  const pod = JSON.parse((await get("/api/sandbox-readiness?profile=ready&type=podman")).body);
  assert.equal(pod.type, "podman");
  assert.equal(probes.calls.at(-1)?.bin, process.env.PODMAN || "podman");
});

test("GET /api/sandbox-readiness: image missing → `doctor --fix` remedy, and the injected build is never called", async () => {
  probeCodes["image inspect"] = 1;
  try {
    const r = JSON.parse((await get("/api/sandbox-readiness?profile=ready")).body);
    assert.deepEqual(row(r, "image"), { id: "image", ok: false, label: `sandbox image present: ${DEFAULT_IMAGE}`, note: "missing", remedy: "agenthook doctor --fix" });
    assert.equal(builder.calls.length, 0);
  } finally {
    delete probeCodes["image inspect"];
  }
});
