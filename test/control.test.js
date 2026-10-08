import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { startControl } from "../src/control.js";

/** @param {string} dir */
function cfgIn(dir) {
  return /** @type {any} */ ({
    name: "testprofile",
    controlSock: path.join(dir, "control.sock"),
    pidFile: path.join(dir, "server.pid"),
  });
}

/** @param {string} sockPath */
function readOneLine(sockPath) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(sockPath);
    let data = "";
    socket.on("data", (chunk) => {
      data += chunk.toString();
      if (data.includes("\n")) {
        socket.end();
        resolve(data.split("\n")[0]);
      }
    });
    socket.on("error", reject);
  });
}

test("startControl: sends one hello line and ignores client input", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthook-control-"));
  const cfg = cfgIn(dir);
  const control = await startControl(cfg, { startedAt: "2026-01-01T00:00:00.000Z" });
  assert.ok(control);
  try {
    const line = await readOneLine(cfg.controlSock);
    const hello = JSON.parse(line);
    assert.equal(hello.type, "hello");
    assert.equal(hello.name, "testprofile");
    assert.equal(hello.pid, process.pid);
    assert.equal(hello.startedAt, "2026-01-01T00:00:00.000Z");
    if (process.platform !== "win32") {
      const mode = fs.statSync(cfg.controlSock).mode & 0o777;
      assert.equal(mode, 0o600);
    }
  } finally {
    control?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("startControl: removes a stale socket file with no live-pid owner", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthook-control-"));
  const cfg = cfgIn(dir);
  fs.writeFileSync(cfg.controlSock, ""); // leftover from a crash, no listener
  const control = await startControl(cfg, { startedAt: "x" });
  assert.ok(control);
  control?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("startControl: a live foreign pid owning the socket disables it", async (t) => {
  if (process.platform === "win32") {
    t.skip("posix-only owner check");
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthook-control-"));
  const cfg = cfgIn(dir);
  fs.writeFileSync(cfg.controlSock, "");
  fs.writeFileSync(cfg.pidFile, String(process.ppid)); // a different, live pid
  const control = await startControl(cfg, { startedAt: "x" });
  assert.equal(control, null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("startControl: close() unlinks the socket file", async (t) => {
  if (process.platform === "win32") {
    t.skip("posix-only socket file");
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthook-control-"));
  const cfg = cfgIn(dir);
  const control = await startControl(cfg, { startedAt: "x" });
  assert.ok(fs.existsSync(cfg.controlSock));
  control?.close();
  assert.ok(!fs.existsSync(cfg.controlSock));
  fs.rmSync(dir, { recursive: true, force: true });
});
