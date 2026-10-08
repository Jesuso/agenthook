import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// `agenthook restart` — reply mapping over the control socket (ok / alreadyPending / active:0 /
// ok:false / down / timeout), and the not-running short-circuit before any socket is touched.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { registryDir } from "../src/config.js";
import { controlSockPath } from "../src/paths.js";
import { restart } from "../src/commands/restart.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ah-restart-cmd-"));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const json = (v) => JSON.stringify(v, null, 2) + "\n";

/** A profile with a config file + state dir, a live pidfile, and a fake control socket that
 * replies via `onLine`. @param {string} stateKey @param {(req: any) => any} onLine */
async function profile(stateKey, onLine) {
  const stateDir = path.join(registryDir, stateKey);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "server.pid"), String(process.pid));
  const configPath = path.join(root, stateKey, "agenthook.config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, json({ name: stateKey, repoPath: "/repo", tracker: { type: "github", pipeline: [{ id: "code" }] } }));
  const sockPath = controlSockPath(stateDir, stateKey);
  const server = net.createServer((socket) => {
    socket.write(JSON.stringify({ type: "hello", name: stateKey, pid: 1, startedAt: "t" }) + "\n");
    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        const req = JSON.parse(line);
        const reply = onLine(req);
        if (reply) socket.write(JSON.stringify(reply) + "\n");
      }
    });
    socket.on("error", () => {});
  });
  await new Promise((r) => server.listen(sockPath, () => r(undefined)));
  return { configPath, stateDir, server };
}

/** Capture console.log/error + exitCode across one `restart(args)` call. */
async function run(configPath) {
  const logs = [];
  const errs = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a) => logs.push(a.join(" "));
  console.error = (...a) => errs.push(a.join(" "));
  const before = process.exitCode;
  process.exitCode = undefined;
  try {
    await restart({ _: [], config: configPath });
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  const exitCode = process.exitCode;
  process.exitCode = before;
  return { logs, errs, exitCode };
}

test("not running: prints a message and exits 1, no socket touched", async () => {
  const stateDir = path.join(registryDir, "down-profile");
  fs.mkdirSync(stateDir, { recursive: true });
  const configPath = path.join(root, "down-profile", "agenthook.config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, json({ name: "down-profile", repoPath: "/repo", tracker: { type: "github", pipeline: [{ id: "code" }] } }));
  const res = await run(configPath);
  assert.equal(res.exitCode, 1);
  assert.match(res.logs.join("\n"), /not running/);
});

test("accepted, agents running: prints the pending-count message", async () => {
  const p = await profile("running-profile", (req) => ({ id: req.id, ok: true, result: { accepted: true, active: 2, queued: 1 } }));
  try {
    const res = await run(p.configPath);
    assert.equal(res.exitCode, undefined);
    assert.match(res.logs.join("\n"), /restart requested.*2 running agent\(s\).*1 queued/);
  } finally {
    await new Promise((r) => p.server.close(r));
  }
});

test("accepted, nothing running: prints 'restarting now'", async () => {
  const p = await profile("idle-profile", (req) => ({ id: req.id, ok: true, result: { accepted: true, active: 0, queued: 0 } }));
  try {
    const res = await run(p.configPath);
    assert.match(res.logs.join("\n"), /restarting now/);
  } finally {
    await new Promise((r) => p.server.close(r));
  }
});

test("already pending: prints the already-pending message", async () => {
  const p = await profile("pending-profile", (req) => ({ id: req.id, ok: true, result: { accepted: true, alreadyPending: true, active: 1, queued: 0 } }));
  try {
    const res = await run(p.configPath);
    assert.match(res.logs.join("\n"), /already pending/);
  } finally {
    await new Promise((r) => p.server.close(r));
  }
});

test("ok:false: prints the receiver's error and exits 1", async () => {
  const p = await profile("badcfg-profile", (req) => ({ id: req.id, ok: false, error: "invalid config" }));
  try {
    const res = await run(p.configPath);
    assert.equal(res.exitCode, 1);
    assert.match(res.errs.join("\n"), /invalid config/);
  } finally {
    await new Promise((r) => p.server.close(r));
  }
});

test("down: no socket at all → exits 1 with a clear error", async () => {
  const stateDir = path.join(registryDir, "nosocket-profile");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "server.pid"), String(process.pid));
  const configPath = path.join(root, "nosocket-profile", "agenthook.config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, json({ name: "nosocket-profile", repoPath: "/repo", tracker: { type: "github", pipeline: [{ id: "code" }] } }));
  const res = await run(configPath);
  assert.equal(res.exitCode, 1);
  assert.match(res.errs.join("\n"), /down/);
});

test("timeout: no reply within the window → exits 1 with a clear error", async () => {
  const p = await profile("hang-profile", () => null); // never replies
  try {
    const res = await run(p.configPath);
    assert.equal(res.exitCode, 1);
    assert.match(res.errs.join("\n"), /timed out/);
  } finally {
    await new Promise((r) => p.server.close(r));
  }
}, { timeout: 10000 });
