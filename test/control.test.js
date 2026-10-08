import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { startControl, listenPrivate } from "../src/control.js";

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

test("listenPrivate: socket carries no group/other bits immediately on resolve, before any chmod", { skip: process.platform === "win32" }, async () => {
  // Node creates the socket file at the OS default (0777), so umask(0o077) brings it
  // out at 0700 — already unreachable by another local user; startControl's belt-and-
  // braces chmodSync afterward narrows that further to the canonical 0600.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthook-control-"));
  const sockPath = path.join(dir, "control.sock");
  const server = net.createServer();
  try {
    await listenPrivate(server, sockPath);
    const mode = fs.statSync(sockPath).mode & 0o777;
    assert.equal(mode & 0o077, 0);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("listenPrivate: umask is restored after a successful listen", { skip: process.platform === "win32" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthook-control-"));
  const sockPath = path.join(dir, "control.sock");
  const before = process.umask();
  const server = net.createServer();
  try {
    await listenPrivate(server, sockPath);
    assert.equal(process.umask(), before);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("listenPrivate: umask is restored after a failed listen", { skip: process.platform === "win32" }, async () => {
  const before = process.umask();
  const server = net.createServer();
  await assert.rejects(listenPrivate(server, "/nonexistent-dir/control.sock"));
  assert.equal(process.umask(), before);
  server.close();
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

/** @param {string} sockPath */
function connectAfterHello(sockPath) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(sockPath);
    socket.setEncoding("utf8");
    let buf = "";
    function onData(chunk) {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      socket.off("data", onData);
      const hello = JSON.parse(buf.slice(0, nl));
      const rest = buf.slice(nl + 1);
      resolve({ socket, hello, rest });
    }
    socket.on("data", onData);
    socket.on("error", reject);
  });
}

/** Reads NDJSON reply lines off a socket, resolving replies by `id`. */
function replyReader(socket, leftover = "") {
  const waiters = new Map();
  const seen = new Map();
  let buf = leftover;
  function drain() {
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim() === "") continue;
      const msg = JSON.parse(line);
      if (waiters.has(msg.id)) {
        waiters.get(msg.id)(msg);
        waiters.delete(msg.id);
      } else {
        seen.set(msg.id, msg);
      }
    }
  }
  socket.on("data", (chunk) => {
    buf += chunk;
    drain();
  });
  drain();
  return {
    waitFor(id) {
      if (seen.has(id)) {
        const msg = seen.get(id);
        seen.delete(id);
        return Promise.resolve(msg);
      }
      return new Promise((resolve) => waiters.set(id, resolve));
    },
  };
}

function fakeAdapter(stages) {
  return {
    describe: () => ({ stageKeys: { source: "sourceSectionGid" } }),
    listStages: async () => stages,
  };
}

test("control protocol: multiple requests on one connection, one chunk, reply by id", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthook-control-"));
  const cfg = cfgIn(dir);
  const adapter = fakeAdapter([{ id: "a", label: "A" }]);
  const control = await startControl(cfg, { startedAt: "x", adapter });
  try {
    const { socket, rest } = await connectAfterHello(cfg.controlSock);
    const reader = replyReader(socket, rest);
    socket.write(JSON.stringify({ id: 1, cmd: "discover" }) + "\n" + JSON.stringify({ id: 2, cmd: "discover" }) + "\n");
    const [r1, r2] = await Promise.all([reader.waitFor(1), reader.waitFor(2)]);
    assert.equal(r1.ok, true);
    assert.equal(r2.ok, true);
    assert.deepEqual(r1.result.stages, [{ id: "a", label: "A" }]);
    socket.end();
  } finally {
    control?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("control protocol: requests split across chunks still get replies by id", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthook-control-"));
  const cfg = cfgIn(dir);
  const adapter = fakeAdapter([]);
  const control = await startControl(cfg, { startedAt: "x", adapter });
  try {
    const { socket, rest } = await connectAfterHello(cfg.controlSock);
    const reader = replyReader(socket, rest);
    const line = JSON.stringify({ id: 7, cmd: "discover" }) + "\n";
    socket.write(line.slice(0, 5));
    await new Promise((r) => setTimeout(r, 10));
    socket.write(line.slice(5));
    const r = await reader.waitFor(7);
    assert.equal(r.ok, true);
    socket.end();
  } finally {
    control?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("control protocol: a slow first call does not block a fast second call's reply", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthook-control-"));
  const cfg = cfgIn(dir);
  let resolveSlow;
  const adapter = {
    describe: () => ({}),
    listStages: () => new Promise((r) => (resolveSlow = () => r([{ id: "s", label: "S" }]))),
  };
  const control = await startControl(cfg, { startedAt: "x", adapter });
  try {
    const { socket, rest } = await connectAfterHello(cfg.controlSock);
    const reader = replyReader(socket, rest);
    socket.write(JSON.stringify({ id: "slow", cmd: "discover" }) + "\n");
    await new Promise((r) => setTimeout(r, 10));
    socket.write(JSON.stringify({ id: "fast", cmd: "nope" }) + "\n");
    const fast = await reader.waitFor("fast");
    assert.deepEqual(fast, { id: "fast", ok: false, error: "unknown command" });
    resolveSlow();
    const slow = await reader.waitFor("slow");
    assert.equal(slow.ok, true);
    socket.end();
  } finally {
    control?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("control protocol: more than 64KB without a newline closes the socket", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthook-control-"));
  const cfg = cfgIn(dir);
  const control = await startControl(cfg, { startedAt: "x" });
  try {
    const { socket } = await connectAfterHello(cfg.controlSock);
    const closed = new Promise((resolve) => socket.on("close", resolve));
    socket.write("x".repeat(64 * 1024 + 1));
    await closed;
  } finally {
    control?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("control protocol: malformed JSON, non-object, or missing/non-string cmd -> bad request", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthook-control-"));
  const cfg = cfgIn(dir);
  const control = await startControl(cfg, { startedAt: "x" });
  try {
    const { socket, rest } = await connectAfterHello(cfg.controlSock);
    const reader = replyReader(socket, rest);
    socket.write("not json\n");
    socket.write(JSON.stringify([1, 2]) + "\n");
    socket.write(JSON.stringify({ id: 3, cmd: 42 }) + "\n");
    socket.write(JSON.stringify({ id: 4 }) + "\n");
    const r3 = await reader.waitFor(3);
    const r4 = await reader.waitFor(4);
    assert.deepEqual(r3, { id: 3, ok: false, error: "bad request" });
    assert.deepEqual(r4, { id: 4, ok: false, error: "bad request" });
    socket.end();
  } finally {
    control?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("control protocol: unknown cmd, including 'toString', -> unknown command", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthook-control-"));
  const cfg = cfgIn(dir);
  const control = await startControl(cfg, { startedAt: "x" });
  try {
    const { socket, rest } = await connectAfterHello(cfg.controlSock);
    const reader = replyReader(socket, rest);
    socket.write(JSON.stringify({ id: 1, cmd: "toString" }) + "\n");
    socket.write(JSON.stringify({ id: 2, cmd: "nope" }) + "\n");
    assert.deepEqual(await reader.waitFor(1), { id: 1, ok: false, error: "unknown command" });
    assert.deepEqual(await reader.waitFor(2), { id: 2, ok: false, error: "unknown command" });
    socket.end();
  } finally {
    control?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("control protocol: discover strips extra fields on stage objects", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthook-control-"));
  const cfg = cfgIn(dir);
  cfg.provider = "asana";
  const adapter = fakeAdapter([{ id: "a", label: "A", extra: "drop me" }]);
  const control = await startControl(cfg, { startedAt: "x", adapter });
  try {
    const { socket, rest } = await connectAfterHello(cfg.controlSock);
    const reader = replyReader(socket, rest);
    socket.write(JSON.stringify({ id: 1, cmd: "discover" }) + "\n");
    const r = await reader.waitFor(1);
    assert.equal(r.ok, true);
    assert.deepEqual(r.result, {
      tracker: "asana",
      stageKeys: { source: "sourceSectionGid" },
      stages: [{ id: "a", label: "A" }],
    });
    socket.end();
  } finally {
    control?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("control protocol: discover with no listStages -> stages: null", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthook-control-"));
  const cfg = cfgIn(dir);
  cfg.provider = "local";
  const adapter = { describe: () => ({}) };
  const control = await startControl(cfg, { startedAt: "x", adapter });
  try {
    const { socket, rest } = await connectAfterHello(cfg.controlSock);
    const reader = replyReader(socket, rest);
    socket.write(JSON.stringify({ id: 1, cmd: "discover" }) + "\n");
    const r = await reader.waitFor(1);
    assert.deepEqual(r.result, { tracker: "local", stageKeys: null, stages: null });
    socket.end();
  } finally {
    control?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("control protocol: no adapter -> stages: null, stageKeys: null", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthook-control-"));
  const cfg = cfgIn(dir);
  cfg.provider = "local";
  const control = await startControl(cfg, { startedAt: "x" });
  try {
    const { socket, rest } = await connectAfterHello(cfg.controlSock);
    const reader = replyReader(socket, rest);
    socket.write(JSON.stringify({ id: 1, cmd: "discover" }) + "\n");
    const r = await reader.waitFor(1);
    assert.deepEqual(r.result, { tracker: "local", stageKeys: null, stages: null });
    socket.end();
  } finally {
    control?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("control protocol: discover caches within 60s, refetches after", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthook-control-"));
  const cfg = cfgIn(dir);
  let calls = 0;
  let t = 1000;
  const adapter = {
    describe: () => ({}),
    listStages: async () => {
      calls++;
      return [{ id: "a", label: "A" }];
    },
  };
  const control = await startControl(cfg, { startedAt: "x", adapter, now: () => t });
  try {
    const { socket, rest } = await connectAfterHello(cfg.controlSock);
    const reader = replyReader(socket, rest);
    socket.write(JSON.stringify({ id: 1, cmd: "discover" }) + "\n");
    await reader.waitFor(1);
    t += 59 * 1000;
    socket.write(JSON.stringify({ id: 2, cmd: "discover" }) + "\n");
    await reader.waitFor(2);
    assert.equal(calls, 1);
    t += 2 * 1000; // now 61s past the first call
    socket.write(JSON.stringify({ id: 3, cmd: "discover" }) + "\n");
    await reader.waitFor(3);
    assert.equal(calls, 2);
    socket.end();
  } finally {
    control?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("control protocol: a rejected listStages is not cached, reply hides the message, next call retries", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthook-control-"));
  const cfg = cfgIn(dir);
  let calls = 0;
  const adapter = {
    describe: () => ({}),
    listStages: async () => {
      calls++;
      if (calls === 1) throw new Error("https://secret-tracker-url/with?token=abc");
      return [{ id: "a", label: "A" }];
    },
  };
  const control = await startControl(cfg, { startedAt: "x", adapter });
  try {
    const { socket, rest } = await connectAfterHello(cfg.controlSock);
    const reader = replyReader(socket, rest);
    socket.write(JSON.stringify({ id: 1, cmd: "discover" }) + "\n");
    const r1 = await reader.waitFor(1);
    assert.deepEqual(r1, { id: 1, ok: false, error: "discover failed" });
    assert.ok(!JSON.stringify(r1).includes("secret-tracker-url"));
    socket.write(JSON.stringify({ id: 2, cmd: "discover" }) + "\n");
    const r2 = await reader.waitFor(2);
    assert.equal(r2.ok, true);
    assert.equal(calls, 2);
    socket.end();
  } finally {
    control?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
