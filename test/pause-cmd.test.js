import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// `agenthook pause` / `unpause` — the CLI maps `--harness` to the `pause`/`resume` payload over the
// control socket. A real fake socket (like test/restart-cmd.test.js) captures each request so the
// mapping is asserted, not just the reply.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { registryDir } from "../src/config/index.js";
import { controlSockPath } from "../src/paths.js";
import { pause, unpause } from "../src/commands/pause.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ah-pause-cmd-"));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

/** @param {any} v */
const json = (v) => JSON.stringify(v, null, 2) + "\n";

/** A profile with a config file + state dir + live pidfile and a fake control socket that records
 * each request (`{cmd, args}`) and replies `result` (defaulting to a success note).
 * @param {string} stateKey @param {any} [result] */
async function profile(stateKey, result) {
  const stateDir = path.join(registryDir, stateKey);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "server.pid"), String(process.pid));
  const configPath = path.join(root, stateKey, "agenthook.config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, json({ name: stateKey, repoPath: "/repo", tracker: { type: "github", pipeline: [{ id: "code" }] } }));
  const sockPath = controlSockPath(stateDir, stateKey);
  /** @type {any[]} */ const requests = [];
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
        if (req.type === "hello") continue;
        requests.push({ cmd: req.cmd, args: req.args });
        socket.write(JSON.stringify({ id: req.id, ok: true, result: result ?? { note: "ok" } }) + "\n");
      }
    });
    socket.on("error", () => {});
  });
  await new Promise((r) => server.listen(sockPath, () => r(undefined)));
  return { configPath, stateDir, server, requests };
}

/** Run one pause/unpause command, restoring console + exitCode. @param {(args: any) => Promise<any>} fn @param {string} configPath */
async function run(fn, configPath) {
  const origLog = console.log;
  console.log = () => {};
  const before = process.exitCode;
  process.exitCode = undefined;
  try {
    await fn({ _: [], config: configPath });
  } finally {
    console.log = origLog;
  }
  const exitCode = process.exitCode;
  process.exitCode = before;
  return { exitCode };
}

test("pause sends {cmd:\"pause\", args:{}} without --harness; with --harness it sends {harness}", async () => {
  const p = await profile("pause-global");
  try {
    await run((a) => pause(a), p.configPath);
    assert.deepEqual(p.requests, [{ cmd: "pause", args: {} }]);
    await run((a) => pause({ ...a, harness: "a" }), p.configPath);
    assert.deepEqual(p.requests[1], { cmd: "pause", args: { harness: "a" } });
    await run((a) => pause({ ...a, harness: "" }), p.configPath);
    assert.deepEqual(p.requests[2], { cmd: "pause", args: {} }, "an empty --harness maps to {}");
  } finally {
    await new Promise((r) => p.server.close(r));
  }
});

test("unpause sends {cmd:\"resume\", args:{}} without --harness; with --harness it sends {harness}", async () => {
  const p = await profile("pause-harness");
  try {
    await run((a) => unpause(a), p.configPath);
    assert.deepEqual(p.requests, [{ cmd: "resume", args: {} }]);
    await run((a) => unpause({ ...a, harness: "a" }), p.configPath);
    assert.deepEqual(p.requests[1], { cmd: "resume", args: { harness: "a" } });
  } finally {
    await new Promise((r) => p.server.close(r));
  }
});
