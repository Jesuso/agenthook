// `start --detach` waits for the child to serve before returning (waitForBoot), so the next
// command (`ticket add`, `run`) reaches the receiver instead of racing its boot.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { waitForBoot, refusal } from "../src/commands/start.js";
import { REFUSED_EXIT_CODE } from "../src/respawn.js";

const stateDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "ah-detach-"));
const cfgFor = (/** @type {string} */ dir) => ({ stateDir: dir, pidFile: path.join(dir, "server.pid") });

test("waitForBoot: resolves up when the pidfile appears naming a live pid", async () => {
  const cfg = cfgFor(stateDir());
  const p = waitForBoot(cfg, process.pid, { timeoutMs: 5000 });
  setTimeout(() => fs.writeFileSync(cfg.pidFile, `${process.pid}\n`), 50);
  assert.equal(await p, "up");
});

test("waitForBoot: an existing live pidfile resolves up at once", async () => {
  const cfg = cfgFor(stateDir());
  fs.writeFileSync(cfg.pidFile, `${process.pid}\n`);
  assert.equal(await waitForBoot(cfg, process.pid, { timeoutMs: 5000 }), "up");
});

test("waitForBoot: a dead child resolves exited, not up", async () => {
  const cfg = cfgFor(stateDir());
  assert.equal(await waitForBoot(cfg, 2 ** 22 + 12345, { timeoutMs: 5000 }), "exited");
});

test("waitForBoot: a live child with no pidfile yet times out (still booting)", async () => {
  const cfg = cfgFor(stateDir());
  assert.equal(await waitForBoot(cfg, process.pid, { timeoutMs: 100 }), "timeout");
});

test("refusal: a plain Error outside the unit; under it, exitCode 78 and one hand-over line", () => {
  const cfg = { name: "demo", stateKey: "demo", configPath: "/w/agenthook.config.json" };
  /** @type {string[]} */
  const lines = [];
  const plain = refusal(cfg, "port 4123 is in use", { env: {}, log: (l) => lines.push(l) });
  assert.equal(plain.message, "port 4123 is in use");
  assert.equal(plain.exitCode, undefined);
  assert.deepEqual(lines, []);
  const unit = refusal(cfg, "port 4123 is in use", { env: { AGENTHOOK_SERVICE: "1" }, log: (l) => lines.push(l) });
  assert.equal(unit.message, "port 4123 is in use", "the message is kept");
  assert.equal(unit.exitCode, REFUSED_EXIT_CODE);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /exiting 78 so systemd does not retry/);
  assert.match(lines[0], /agenthook stop --keep-hooks --config \/w\/agenthook\.config\.json, then systemctl --user start agenthook-demo\.service/);
});
