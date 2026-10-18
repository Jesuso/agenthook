// `start --detach` waits for the child to serve before returning (waitForBoot), so the next
// command (`ticket add`, `run`) reaches the receiver instead of racing its boot.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { waitForBoot } from "../src/commands/start.js";

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
