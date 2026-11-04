import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// `agenthook service` (src/service.js, src/commands/service.js): the systemd --user unit that
// starts a receiver at login/boot. Unit text is generated and checked here; systemctl/loginctl
// are a recording fake — nothing touches the real user manager.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { renderUnit, quoteArg, userUnitDir, unitName, lingerEnabled, unsupportedReason, splitExecStart, unitConfigPath, staleUnits } from "../src/service.js";
import { service } from "../src/commands/service.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ah-service-"));

/** A config file for profile `name` in a fresh dir. @param {string} name */
function configFile(name) {
  const dir = tmp();
  const file = path.join(dir, "agenthook.config.json");
  fs.writeFileSync(file, JSON.stringify({ name }));
  return file;
}

/** A recording systemctl/loginctl fake. @param {Record<string, {status?: number, stdout?: string, stderr?: string}>} [answers] keyed by "cmd arg0" */
function fakeRun(answers = {}) {
  /** @type {string[]} */
  const calls = [];
  /** @type {import('../src/service.js').Runner} */
  const run = (cmd, args) => {
    calls.push([cmd, ...args].join(" "));
    const key = `${cmd} ${args.filter((a) => a !== "--user")[0]}`;
    const a = answers[key] ?? {};
    return { status: a.status ?? 0, stdout: a.stdout ?? "", stderr: a.stderr ?? "" };
  };
  return { run, calls };
}

/** Run a command, capturing stdout/stderr and the exit code (then reset). @param {() => Promise<any>} fn */
async function capture(fn) {
  const out = [];
  const err = [];
  const log = console.log;
  const error = console.error;
  const write = process.stdout.write;
  console.log = (...a) => out.push(a.join(" "));
  console.error = (...a) => err.push(a.join(" "));
  process.stdout.write = /** @type {any} */ ((/** @type {string} */ s) => (out.push(String(s)), true));
  try {
    await fn();
  } finally {
    console.log = log;
    console.error = error;
    process.stdout.write = write;
  }
  const code = process.exitCode ?? 0;
  process.exitCode = 0;
  return { out: out.join("\n"), err: err.join("\n"), code };
}

test("renderUnit: foreground start on the profile's config, restart on failure and on exit 75, PATH captured", () => {
  const text = renderUnit({
    name: "demo",
    stateKey: "demo",
    configPath: "/home/u/work/repo/agenthook.config.json",
    execPath: "/usr/bin/node",
    installDir: "/opt/agenthook",
    pathEnv: "/home/u/.local/bin:/usr/bin",
  });
  assert.match(text, /^\[Unit\]$/m);
  assert.match(text, /^Description=agenthook receiver \(demo\)$/m);
  assert.match(text, /^ExecStart=\/usr\/bin\/node \/opt\/agenthook\/bin\/agenthook\.js start --config \/home\/u\/work\/repo\/agenthook\.config\.json$/m);
  assert.match(text, /^WorkingDirectory=\/home\/u\/work\/repo$/m);
  assert.match(text, /^Environment=PATH=\/home\/u\/\.local\/bin:\/usr\/bin$/m);
  assert.match(text, /^Restart=on-failure$/m);
  assert.match(text, /^RestartForceExitStatus=75$/m);
  assert.match(text, /^SuccessExitStatus=75$/m, "a restart is not a failure in the journal");
  assert.match(text, /^RestartPreventExitStatus=78$/m, "a refused start is not retried");
  assert.match(text, /^RestartSec=10$/m);
  assert.match(text, /^TimeoutStopSec=30min$/m, "a stop drains running agents");
  assert.match(text, /^Environment=AGENTHOOK_SERVICE=1$/m);
  assert.match(text, /^StartLimitIntervalSec=600$/m);
  assert.match(text, /^StartLimitBurst=20$/m);
  assert.doesNotMatch(text, /KillMode/, "a restart exits for systemd instead of leaving a respawn behind");
  assert.match(text, /^WantedBy=default\.target$/m);
  assert.doesNotMatch(text, /--detach/, "systemd supervises a foreground process");
  assert.doesNotMatch(text, /AGENTHOOK_HOME/);
  assert.match(renderUnit({ name: "d", stateKey: "d", configPath: "/c.json", execPath: "/n", installDir: "/i", home: "/srv/ah" }), /^Environment=AGENTHOOK_HOME=\/srv\/ah$/m);
});

test("quoteArg: plain words pass; spaces/quotes are quoted; % always and $ in ExecStart escaped", () => {
  assert.equal(quoteArg("/usr/bin/node"), "/usr/bin/node");
  assert.equal(quoteArg("/home/u/my repo/c.json"), '"/home/u/my repo/c.json"');
  assert.equal(quoteArg('a"b'), '"a\\"b"');
  assert.equal(quoteArg("50%"), "50%%");
  assert.equal(quoteArg("$HOME"), "$$HOME");
  assert.equal(quoteArg("PATH=$x", { exec: false }), "PATH=$x");
});

test("splitExecStart / unitConfigPath: round-trip quoteArg's quoting, %% and $$", () => {
  assert.deepEqual(splitExecStart("/n /i/bin/agenthook.js start --config /c.json"), ["/n", "/i/bin/agenthook.js", "start", "--config", "/c.json"]);
  const odd = '/home/u/my "repo" 50% $x/agenthook.config.json';
  const text = renderUnit({ name: "d", stateKey: "d", configPath: odd, execPath: "/n", installDir: "/i" });
  assert.equal(unitConfigPath(text), odd);
  assert.equal(unitConfigPath("[Unit]\nDescription=x\n"), null);
  assert.equal(unitConfigPath("ExecStart=/n /i/bin/agenthook.js start\n"), null);
});

test("staleUnits: other agenthook-*.service files on the same config, never the one being written or a foreign one", () => {
  const dir = tmp();
  const write = (/** @type {string} */ n, /** @type {string} */ c) => fs.writeFileSync(path.join(dir, n), renderUnit({ name: n, stateKey: n, configPath: c, execPath: "/n", installDir: "/i" }));
  write("agenthook-old.service", "/w/a.json");
  write("agenthook-new.service", "/w/a.json");
  write("agenthook-other.service", "/w/b.json");
  fs.writeFileSync(path.join(dir, "agenthook-garbage.service"), "not a unit");
  fs.writeFileSync(path.join(dir, "unrelated.service"), "ExecStart=/x --config /w/a.json\n");
  assert.deepEqual(staleUnits(dir, "/w/a.json", "agenthook-new.service"), ["agenthook-old.service"]);
  assert.deepEqual(staleUnits(path.join(dir, "missing"), "/w/a.json", "agenthook-new.service"), []);
});

test("userUnitDir / unitName / unsupportedReason", () => {
  assert.equal(userUnitDir({ env: { XDG_CONFIG_HOME: "/x/cfg" }, home: "/h" }), "/x/cfg/systemd/user");
  assert.equal(userUnitDir({ env: { XDG_CONFIG_HOME: "rel" }, home: "/h" }), "/h/.config/systemd/user", "a relative XDG_CONFIG_HOME is ignored");
  assert.equal(unitName("p1"), "agenthook-p1.service");
  assert.equal(unsupportedReason("linux"), null);
  assert.match(String(unsupportedReason("darwin")), /needs Linux with systemd \(this is darwin\)/);
});

test("lingerEnabled: yes/no from loginctl, null when it fails", () => {
  assert.equal(lingerEnabled(fakeRun({ "loginctl show-user": { stdout: "yes\n" } }).run, "u"), true);
  assert.equal(lingerEnabled(fakeRun({ "loginctl show-user": { stdout: "no\n" } }).run, "u"), false);
  assert.equal(lingerEnabled(fakeRun({ "loginctl show-user": { status: 1 } }).run, "u"), null);
});

test("service install: writes the unit, daemon-reloads, enables (never starts), prints the linger step; no sudo", async () => {
  const cfgPath = configFile("svc1");
  const xdg = tmp();
  const f = fakeRun({ "loginctl show-user": { stdout: "no\n" } });
  const r = await capture(() =>
    service({ _: ["install"], config: cfgPath }, { platform: "linux", env: { XDG_CONFIG_HOME: xdg, PATH: "/bin" }, run: f.run, user: "someone", execPath: "/n", installDir: "/i" }),
  );
  assert.equal(r.code, 0, r.err);
  const file = path.join(xdg, "systemd", "user", "agenthook-svc1.service");
  const text = fs.readFileSync(file, "utf8");
  assert.match(text, new RegExp(`^ExecStart=/n /i/bin/agenthook\\.js start --config ${cfgPath.replace(/[.]/g, "\\.")}$`, "m"));
  assert.deepEqual(f.calls, ["systemctl --user daemon-reload", "systemctl --user enable agenthook-svc1.service", "loginctl show-user someone --property=Linger --value"]);
  assert.ok(!f.calls.some((c) => /sudo|enable-linger|\bstart\b/.test(c)), "never sudo, never enable-linger, never start");
  assert.match(r.out, /loginctl enable-linger someone/);
});

test("service install --dry-run prints the unit and writes nothing; --no-enable writes without systemctl", async () => {
  const cfgPath = configFile("svc2");
  const xdg = tmp();
  const f = fakeRun();
  const deps = { platform: "linux", env: { XDG_CONFIG_HOME: xdg }, run: f.run, user: "u", execPath: "/n", installDir: "/i" };
  const dry = await capture(() => service({ _: ["install"], config: cfgPath, "dry-run": true }, deps));
  assert.match(dry.out, /\[Service\]/);
  assert.equal(fs.existsSync(path.join(xdg, "systemd")), false);
  assert.deepEqual(f.calls, []);
  const noEnable = await capture(() => service({ _: ["install"], config: cfgPath, "no-enable": true }, deps));
  assert.equal(noEnable.code, 0);
  assert.ok(fs.existsSync(path.join(xdg, "systemd", "user", "agenthook-svc2.service")));
  assert.deepEqual(f.calls, []);
});

test("service install: a failing systemctl surfaces as an error", async () => {
  const cfgPath = configFile("svc3");
  const f = fakeRun({ "systemctl daemon-reload": { status: 1, stderr: "Failed to connect to bus" } });
  await assert.rejects(
    service({ _: ["install"], config: cfgPath }, { platform: "linux", env: { XDG_CONFIG_HOME: tmp() }, run: f.run, user: "u" }),
    /systemctl --user daemon-reload failed: Failed to connect to bus/,
  );
});

test("service uninstall: disables (--stop adds --now), removes the file, daemon-reloads", async () => {
  const cfgPath = configFile("svc4");
  const xdg = tmp();
  const deps = { platform: "linux", env: { XDG_CONFIG_HOME: xdg }, user: "u", execPath: "/n", installDir: "/i" };
  await capture(() => service({ _: ["install"], config: cfgPath, "no-enable": true }, { ...deps, run: fakeRun().run }));
  const file = path.join(xdg, "systemd", "user", "agenthook-svc4.service");
  assert.ok(fs.existsSync(file));
  const f = fakeRun();
  const r = await capture(() => service({ _: ["uninstall"], config: cfgPath, stop: true }, { ...deps, run: f.run }));
  assert.equal(r.code, 0);
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual(f.calls, ["systemctl --user disable --now agenthook-svc4.service", "systemctl --user daemon-reload"]);
});

test("service status: file, enabled, active, lingering", async () => {
  const cfgPath = configFile("svc5");
  const f = fakeRun({ "systemctl is-enabled": { stdout: "enabled\n" }, "systemctl is-active": { stdout: "active\n" }, "loginctl show-user": { stdout: "yes\n" } });
  const r = await capture(() => service({ _: ["status"], config: cfgPath }, { platform: "linux", env: { XDG_CONFIG_HOME: tmp() }, run: f.run, user: "u" }));
  assert.match(r.out, /agenthook-svc5\.service/);
  assert.match(r.out, /unit file: not installed/);
  assert.match(r.out, /enabled: +enabled/);
  assert.match(r.out, /active: +active/);
  assert.match(r.out, /lingering: on/);
});

test("service: unsupported platform and bad subcommand exit 1 without touching anything", async () => {
  const f = fakeRun();
  const mac = await capture(() => service({ _: ["install"] }, { platform: "darwin", run: f.run }));
  assert.equal(mac.code, 1);
  assert.match(mac.err, /needs Linux with systemd/);
  const bad = await capture(() => service({ _: ["frobnicate"] }, { platform: "linux", run: f.run }));
  assert.equal(bad.code, 1);
  assert.match(bad.err, /usage: agenthook service/);
  assert.deepEqual(f.calls, []);
});

test("service install: replaces a unit written for the same config under another name (rename --move); disables it, never --now", async () => {
  const cfgPath = configFile("svc6");
  const xdg = tmp();
  const unitDir = path.join(xdg, "systemd", "user");
  fs.mkdirSync(unitDir, { recursive: true });
  const old = path.join(unitDir, "agenthook-oldname.service");
  fs.writeFileSync(old, renderUnit({ name: "oldname", stateKey: "oldname", configPath: cfgPath, execPath: "/n", installDir: "/i" }));
  const other = path.join(unitDir, "agenthook-other.service");
  fs.writeFileSync(other, renderUnit({ name: "other", stateKey: "other", configPath: "/elsewhere/agenthook.config.json", execPath: "/n", installDir: "/i" }));
  const deps = { platform: "linux", env: { XDG_CONFIG_HOME: xdg, PATH: "/bin" }, user: "u", execPath: "/n", installDir: "/i" };
  const dry = fakeRun();
  const d = await capture(() => service({ _: ["install"], config: cfgPath, "dry-run": true }, { ...deps, run: dry.run }));
  assert.match(d.out, /^# would replace agenthook-oldname\.service \(same config\)$/m);
  assert.ok(fs.existsSync(old), "dry-run removes nothing");
  assert.deepEqual(dry.calls, []);
  const f = fakeRun({ "loginctl show-user": { stdout: "yes\n" } });
  const r = await capture(() => service({ _: ["install"], config: cfgPath }, { ...deps, run: f.run }));
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^replaced agenthook-oldname\.service \(same config\)$/m);
  assert.equal(fs.existsSync(old), false);
  assert.ok(fs.existsSync(other), "a unit on another config stays");
  assert.ok(fs.existsSync(path.join(unitDir, "agenthook-svc6.service")));
  assert.deepEqual(f.calls, [
    "systemctl --user disable agenthook-oldname.service",
    "systemctl --user daemon-reload",
    "systemctl --user enable agenthook-svc6.service",
    "loginctl show-user u --property=Linger --value",
  ]);
  assert.ok(!f.calls.some((c) => /--now|\bstop\b/.test(c)), "the old unit's receiver keeps running");
});

test("service install: warns when agenthook runs from the npx cache", async () => {
  const cfgPath = configFile("svc7");
  const f = fakeRun();
  const deps = { platform: "linux", env: { XDG_CONFIG_HOME: tmp() }, run: f.run, user: "u", execPath: "/n" };
  const npx = await capture(() => service({ _: ["install"], config: cfgPath, "dry-run": true }, { ...deps, installDir: "/home/u/.npm/_npx/abc123/node_modules/@jesuso/agenthook" }));
  assert.match(npx.err, /npx cache/);
  assert.match(npx.err, /npm i -g @jesuso\/agenthook/);
  const global = await capture(() => service({ _: ["install"], config: cfgPath, "dry-run": true }, { ...deps, installDir: "/usr/lib/node_modules/@jesuso/agenthook" }));
  assert.equal(global.err, "");
});
