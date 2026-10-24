import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startArgv, restartSpawnArgs, systemdScopeAvailable, detachedSpawnSpec, classifyCgroup, spawnDetached } from "../src/respawn.js";
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

const linuxEnv = { PATH: "/usr/bin", XDG_RUNTIME_DIR: "/run/user/1000" };
const onPathYes = () => true;
const onPathNo = () => false;
const existsYes = () => true;
const existsNo = () => false;

test("systemdScopeAvailable: linux + systemd-run on PATH + reachable socket → true", () => {
  assert.equal(systemdScopeAvailable({ platform: "linux", env: linuxEnv, onPath: onPathYes, exists: existsYes }), true);
});

test("systemdScopeAvailable: non-linux → false", () => {
  assert.equal(systemdScopeAvailable({ platform: "darwin", env: linuxEnv, onPath: onPathYes, exists: existsYes }), false);
});

test("systemdScopeAvailable: AGENTHOOK_NO_SYSTEMD_SCOPE=1 opts out → false", () => {
  assert.equal(
    systemdScopeAvailable({ platform: "linux", env: { ...linuxEnv, AGENTHOOK_NO_SYSTEMD_SCOPE: "1" }, onPath: onPathYes, exists: existsYes }),
    false,
  );
});

test("systemdScopeAvailable: no systemd-run on PATH → false", () => {
  assert.equal(systemdScopeAvailable({ platform: "linux", env: linuxEnv, onPath: onPathNo, exists: existsYes }), false);
});

test("systemdScopeAvailable: no reachable user manager socket → false", () => {
  assert.equal(systemdScopeAvailable({ platform: "linux", env: linuxEnv, onPath: onPathYes, exists: existsNo }), false);
});

test("detachedSpawnSpec: scope:true wraps in systemd-run --user --scope with a unit name", () => {
  const spec = detachedSpawnSpec({ command: "/usr/bin/node", args: ["/opt/agenthook/bin/agenthook.js", "start"] }, { scope: true, stateKey: "Agenthook", now: 123 });
  assert.deepEqual(spec, {
    command: "systemd-run",
    args: ["--user", "--scope", "--collect", "--quiet", "--unit=agenthook-Agenthook-123", "/usr/bin/node", "/opt/agenthook/bin/agenthook.js", "start"],
  });
});

test("detachedSpawnSpec: scope:false returns the input unchanged", () => {
  const input = { command: "/usr/bin/node", args: ["x"] };
  assert.deepEqual(detachedSpawnSpec(input, { scope: false, stateKey: "Agenthook" }), input);
});

test("classifyCgroup: terminal scopes", () => {
  assert.deepEqual(classifyCgroup("0::/user.slice/user-1000.slice/user@1000.service/app.slice/vte-spawn-abc123.scope"), {
    scope: "vte-spawn-abc123.scope",
    terminal: true,
  });
  assert.equal(classifyCgroup("0::/a/b/tmux-spawn-xyz.scope").terminal, true);
  assert.equal(classifyCgroup("0::/a/b/app-gnome-code-12345.scope").terminal, true);
  assert.equal(classifyCgroup("0::/a/b/session-3-terminal-1.scope").terminal, true);
});

test("classifyCgroup: non-terminal scopes", () => {
  assert.deepEqual(classifyCgroup("0::/user.slice/user-1000.slice/user@1000.service/app.slice/agenthook-Agenthook-123.scope"), {
    scope: "agenthook-Agenthook-123.scope",
    terminal: false,
  });
  assert.equal(classifyCgroup("0::/system.slice/some.service").terminal, false);
});

test("classifyCgroup: garbage/empty input", () => {
  assert.deepEqual(classifyCgroup(""), { scope: null, terminal: false });
  assert.deepEqual(classifyCgroup("garbage no cgroup line here"), { scope: null, terminal: false });
});

test("spawnDetached: a child's stdout reaches <stateDir>/receiver.log (pins delivery of e.g. a boot [recover] line)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-respawn-"));
  const cfg = { stateDir: dir, stateKey: "p" };
  const prev = process.env.AGENTHOOK_NO_SYSTEMD_SCOPE;
  process.env.AGENTHOOK_NO_SYSTEMD_SCOPE = "1"; // deterministic across dev boxes/CI regardless of systemd-run availability
  try {
    spawnDetached(cfg, { command: process.execPath, args: ["-e", "console.log('[recover] reaped 1 container(s), 0 network(s) left by a previous run')"] });
    const logPath = path.join(dir, "receiver.log");
    const deadline = Date.now() + 5000;
    let content = "";
    while (Date.now() < deadline) {
      content = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "";
      if (content.includes("[recover] reaped")) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.match(content, /\[recover\] reaped 1 container\(s\), 0 network\(s\) left by a previous run/);
  } finally {
    if (prev === undefined) delete process.env.AGENTHOOK_NO_SYSTEMD_SCOPE;
    else process.env.AGENTHOOK_NO_SYSTEMD_SCOPE = prev;
  }
});
