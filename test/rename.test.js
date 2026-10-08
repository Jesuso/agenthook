import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// `agenthook rename` — the testable core (renameProfile): collisions with another profile's
// label or state key, invalid names, the same-name no-op, and the running-receiver message.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { registryDir } from "../src/config.js";
import { controlSockPath } from "../src/paths.js";
import { rename, renameProfile, assertSafeRename } from "../src/commands/rename.js";

// peekConfig (inside renameProfile) derives a profile's stateDir from config.js's module-scoped
// registryDir (AGENTHOOK_HOME, set once by _setup.js) — not a passable param — so this test's
// state dirs must live there too, not under a separate temp registry.
const registry = registryDir;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "ah-rename-"));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const json = (v) => JSON.stringify(v, null, 2) + "\n";

/** A profile: its config file (under root/cfg/<stateKey>/) and state dir (under the real
 * registry), optionally "running" (a live pidfile). @param {{name: string, stateId?: string, running?: boolean}} o */
function profile({ name, stateId, running = false }) {
  const stateKey = stateId ?? name;
  const stateDir = path.join(registry, stateKey);
  fs.mkdirSync(stateDir, { recursive: true });
  const configPath = path.join(root, "cfg", stateKey, "agenthook.config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  /** @type {any} */
  const raw = { name, repoPath: "/repo", tracker: { type: "github", pipeline: [{ id: "code" }] } };
  if (stateId) raw.stateId = stateId;
  fs.writeFileSync(configPath, json(raw));
  if (running) fs.writeFileSync(path.join(stateDir, "server.pid"), String(process.pid));
  return { name, stateKey, configPath, stateDir };
}

test("same name: no-op, nothing written", () => {
  const p = profile({ name: "solo" });
  const before = fs.readFileSync(p.configPath, "utf8");
  const res = renameProfile({ configPath: p.configPath, newName: "solo", registry });
  assert.deepEqual(res, { changed: false, running: false, from: "solo", to: "solo", stateKey: "solo" });
  assert.equal(fs.readFileSync(p.configPath, "utf8"), before);
});

test("invalid name: throws, nothing written", () => {
  const p = profile({ name: "bad-src" });
  const before = fs.readFileSync(p.configPath, "utf8");
  assert.throws(() => renameProfile({ configPath: p.configPath, newName: "has a space", registry }), /must match/);
  assert.throws(() => renameProfile({ configPath: p.configPath, newName: "", registry }), /must match/);
  assert.equal(fs.readFileSync(p.configPath, "utf8"), before);
});

test("collision with another profile's label: throws, nothing written", () => {
  profile({ name: "taken-label" });
  const p = profile({ name: "label-src" });
  const before = fs.readFileSync(p.configPath, "utf8");
  assert.throws(() => renameProfile({ configPath: p.configPath, newName: "taken-label", registry }), /collides/);
  assert.equal(fs.readFileSync(p.configPath, "utf8"), before);
});

test("collision with another profile's state key: throws, nothing written", () => {
  profile({ name: "other-label", stateId: "taken-state" });
  const p = profile({ name: "state-src" });
  const before = fs.readFileSync(p.configPath, "utf8");
  assert.throws(() => renameProfile({ configPath: p.configPath, newName: "taken-state", registry }), /collides/);
  assert.equal(fs.readFileSync(p.configPath, "utf8"), before);
});

test("renaming to one's own state key is allowed (no self-collision)", () => {
  const p = profile({ name: "self-src", stateId: "self-state" });
  const res = renameProfile({ configPath: p.configPath, newName: "self-state", registry });
  assert.equal(res.changed, true);
  assert.equal(res.stateKey, "self-state");
  assert.deepEqual(JSON.parse(fs.readFileSync(p.configPath, "utf8")), { name: "self-state", stateId: "self-state", repoPath: "/repo", tracker: { type: "github", pipeline: [{ id: "code" }] } });
});

test("successful rename inserts stateId, keeps state dir, and audits", () => {
  const p = profile({ name: "plain" });
  const res = renameProfile({ configPath: p.configPath, newName: "plainer", registry });
  assert.deepEqual(res, { changed: true, running: false, from: "plain", to: "plainer", stateKey: "plain" });
  const raw = JSON.parse(fs.readFileSync(p.configPath, "utf8"));
  assert.equal(raw.name, "plainer");
  assert.equal(raw.stateId, "plain");
  assert.ok(fs.existsSync(path.join(p.stateDir, "config-bak")));
  const audit = fs.readFileSync(path.join(p.stateDir, "ui-audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(audit[audit.length - 1].source, "cli");
  assert.deepEqual(audit[audit.length - 1].action, "rename");
  assert.deepEqual([audit[audit.length - 1].from, audit[audit.length - 1].to], ["plain", "plainer"]);
});

test("receiver running: reports running:true", () => {
  const p = profile({ name: "live", running: true });
  const res = renameProfile({ configPath: p.configPath, newName: "livelier", registry });
  assert.equal(res.running, true);
});

test("receiver down: reports running:false", () => {
  const p = profile({ name: "quiet" });
  const res = renameProfile({ configPath: p.configPath, newName: "quieter", registry });
  assert.equal(res.running, false);
});

test("assertSafeRename: rejects invalid JSON, a changed state key, and a wrong name", () => {
  const ok = JSON.stringify({ name: "new", stateId: "old", repoPath: "/r", tracker: { type: "github", pipeline: [{ id: "code" }] } });
  assert.doesNotThrow(() => assertSafeRename(ok, "new", "old"));
  assert.throws(() => assertSafeRename("{", "new", "old"), /not valid JSON/);
  assert.throws(() => assertSafeRename(ok.replace('"stateId":"old",', ""), "new", "old"), /state key/);
  assert.throws(() => assertSafeRename(ok, "other", "old"), /name is not/);
});

// --- `rename --move` (the CLI wrapper) ---

/** Capture console output + exitCode across one `rename(args)` call. */
async function runRename(args) {
  const logs = [];
  const errs = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a) => logs.push(a.join(" "));
  console.error = (...a) => errs.push(a.join(" "));
  const before = process.exitCode;
  process.exitCode = undefined;
  try {
    await rename(args);
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  const exitCode = process.exitCode;
  process.exitCode = before;
  return { logs: logs.join("\n"), errs: errs.join("\n"), exitCode };
}

test("--move, stopped: relabels and moves the state dir in one go, stateId dropped", async () => {
  const p = profile({ name: "mvcli-old" });
  fs.writeFileSync(path.join(p.stateDir, "seen.json"), "[]");
  const res = await runRename({ _: ["mvcli-new"], config: p.configPath, move: true });
  assert.equal(res.exitCode, undefined, res.errs);
  assert.match(res.logs, /moved .*mvcli-old.* → .*mvcli-new/);
  const raw = JSON.parse(fs.readFileSync(p.configPath, "utf8"));
  assert.equal(raw.name, "mvcli-new");
  assert.equal(raw.stateId, undefined);
  assert.equal(fs.existsSync(p.stateDir), false);
  assert.ok(fs.existsSync(path.join(registry, "mvcli-new", "seen.json")));
});

test("--move with the name unchanged but a different state key: moves only", async () => {
  const p = profile({ name: "mvcli-same", stateId: "mvcli-same-old" });
  const res = await runRename({ _: ["mvcli-same"], config: p.configPath, move: true });
  assert.equal(res.exitCode, undefined, res.errs);
  assert.match(res.logs, /moved/);
  assert.equal(JSON.parse(fs.readFileSync(p.configPath, "utf8")).stateId, undefined);
  assert.ok(fs.existsSync(path.join(registry, "mvcli-same")));
});

test("--move refused up front (target dir exists): nothing relabelled, nothing moved", async () => {
  const p = profile({ name: "mvcli-blocked" });
  fs.mkdirSync(path.join(registry, "mvcli-blocked-new"));
  const before = fs.readFileSync(p.configPath, "utf8");
  const res = await runRename({ _: ["mvcli-blocked-new"], config: p.configPath, move: true });
  assert.equal(res.exitCode, 1);
  assert.match(res.errs, /already exists/);
  assert.equal(fs.readFileSync(p.configPath, "utf8"), before);
  assert.ok(fs.existsSync(p.stateDir));
});

test("--move, running: relabels and sends restart {when:'idle', moveTo} over the old key's socket", async () => {
  const p = profile({ name: "mvcli-live", running: true });
  /** @type {any[]} */
  const reqs = [];
  const server = net.createServer((socket) => {
    socket.write(JSON.stringify({ type: "hello", name: "mvcli-live", pid: 1, startedAt: "t" }) + "\n");
    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const req = JSON.parse(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        reqs.push(req);
        socket.write(JSON.stringify({ id: req.id, ok: true, result: { accepted: true, active: 1, queued: 0 } }) + "\n");
      }
    });
    socket.on("error", () => {});
  });
  await new Promise((r) => server.listen(controlSockPath(p.stateDir, p.stateKey), () => r(undefined)));
  try {
    const res = await runRename({ _: ["mvcli-live2"], config: p.configPath, move: true });
    assert.equal(res.exitCode, undefined, res.errs);
    assert.equal(reqs.length, 1);
    assert.equal(reqs[0].cmd, "restart");
    assert.deepEqual(reqs[0].args, { when: "idle", moveTo: "mvcli-live2" });
    assert.match(res.logs, /moves .* when idle/);
    const raw = JSON.parse(fs.readFileSync(p.configPath, "utf8"));
    assert.deepEqual([raw.name, raw.stateId], ["mvcli-live2", "mvcli-live"], "label now, dir at idle");
    assert.ok(fs.existsSync(p.stateDir), "the CLI never moves a running receiver's dir");
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("without --move: unchanged label-only rename, dir stays", async () => {
  const p = profile({ name: "mvcli-plain" });
  const res = await runRename({ _: ["mvcli-plain2"], config: p.configPath });
  assert.match(res.logs, /state key "mvcli-plain" unchanged/);
  assert.equal(JSON.parse(fs.readFileSync(p.configPath, "utf8")).stateId, "mvcli-plain");
  assert.ok(fs.existsSync(p.stateDir));
});
