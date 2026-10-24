import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// `agenthook start`'s pre-boot port-claim check (#537): a busy port that's another registered
// profile's own configured port should fail before boot, naming that profile — not surface as a
// bare EADDRINUSE deep in engine boot. Offline: a raw TCP listener stands in for "busy", a
// hand-written registry entry for "claimed".
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { start } from "../src/commands/start.js";
import { loadConfig, registryDir } from "../src/config.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ah-start-port-"));
let seq = 0;

/** A loaded local profile pointing at `port`, in a fresh tmp git repo. @param {number} port */
function profileOn(port) {
  const root = tmp();
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  execFileSync("git", ["-C", repo, "init", "-q"]);
  execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"]);
  const file = path.join(root, "agenthook.config.json");
  const pipeline = [{ id: "code", sourceStatus: "code", successStatus: "review" }, { id: "review", manual: true, sourceStatus: "review" }];
  fs.writeFileSync(
    file,
    JSON.stringify({ name: `ah-start-port-${process.pid}-${++seq}`, repoPath: repo, port, ingress: { type: "manual", url: "http://127.0.0.1:1" }, tracker: { type: "local", pipeline } }),
  );
  return { file, cfg: loadConfig({ configPath: file }) };
}

/** A registered-but-not-this profile claiming `port`, with or without a live pidfile. @param {number} port @param {{ live?: boolean }} [o] */
function claimant(port, { live = false } = {}) {
  const other = profileOn(port);
  const dir = path.join(registryDir, other.cfg.stateKey);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "profile.json"), JSON.stringify({ configPath: other.file, stateKey: other.cfg.stateKey, name: other.cfg.name }));
  if (live) fs.writeFileSync(path.join(dir, "server.pid"), String(process.pid));
  return other.cfg.name;
}

/** A bound TCP listener on 127.0.0.1, closed by the caller. @returns {Promise<{server: net.Server, port: number}>} */
function listen() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = /** @type {net.AddressInfo} */ (server.address());
      resolve({ server, port });
    });
  });
}

test("start: a busy port claimed by another registered profile fails before boot, naming it (running: no)", async () => {
  const { server, port } = await listen();
  try {
    const name = claimant(port);
    const { file } = profileOn(port);
    await assert.rejects(() => start({ config: file }), (e) => {
      assert.match(e.message, new RegExp(`profile "${name}" is configured for it \\(running: no\\)`));
      return true;
    });
  } finally {
    server.close();
  }
});

test("start: names the claimant as running when its pidfile holds a live pid", async () => {
  const { server, port } = await listen();
  try {
    const name = claimant(port, { live: true });
    const { file } = profileOn(port);
    await assert.rejects(() => start({ config: file }), (e) => {
      assert.match(e.message, new RegExp(`profile "${name}" is configured for it \\(running: yes\\)`));
      return true;
    });
  } finally {
    server.close();
  }
});
