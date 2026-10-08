import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { startArgv, restartSpawnArgs } from "../src/respawn.js";
import { parse } from "../bin/agenthook.js";

const cfg = { installDir: "/opt/agenthook", configPath: "/p/agenthook.config.json" };
const bin = path.join("/opt/agenthook", "bin", "agenthook.js");

test("restartSpawnArgs: detached start on the same config with --reconcile-on-boot", () => {
  assert.deepEqual(restartSpawnArgs(cfg, { execPath: "/usr/bin/node", installDir: "/opt/agenthook" }), {
    command: "/usr/bin/node",
    args: [bin, "start", "--detach", "--config", "/p/agenthook.config.json", "--reconcile-on-boot"],
  });
});

test("restartSpawnArgs: defaults to process.execPath + cfg.installDir", () => {
  const { command, args } = restartSpawnArgs(cfg);
  assert.equal(command, process.execPath);
  assert.equal(args[0], bin);
});

test("startArgv: --detach child forwards --reconcile-on-boot only when set", () => {
  assert.deepEqual(startArgv(cfg), [bin, "start", "--config", "/p/agenthook.config.json"]);
  assert.deepEqual(startArgv(cfg, { reconcileOnBoot: true }), [bin, "start", "--config", "/p/agenthook.config.json", "--reconcile-on-boot"]);
});

test("parse: --reconcile-on-boot is a boolean flag keyed verbatim", () => {
  const args = parse(["--detach", "--config", "x.json", "--reconcile-on-boot"]);
  assert.equal(args["reconcile-on-boot"], true);
  assert.equal(args.detach, true);
  assert.equal(args.config, "x.json");
  assert.equal(parse(["--config", "x.json"])["reconcile-on-boot"], undefined);
});
