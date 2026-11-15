import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// Doctor — named harnesses (#632), remoteHarnessChecks (#691, doctor's ssh preflight for
// every harnesses.<name>.remote), and the credential probe script itself, run for real
// under `sh` (#691 review).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { agentBinChecks, harnessBinChecks, remoteHarnessChecks, harnessLanLints, opencodeConfigLints, opencodeEffortLints, harnessSlotLints, runChecks } from "../src/commands/doctor.js";
import { cleanProfile, io } from "./_doctor-helpers.js";

// --- named harnesses (#632) ---

test("harnessBinChecks: flags a harness with its own bin or a different agent, not one that only inherits the profile's", () => {
  const cfg = /** @type {any} */ ({
    claudeBin: "claude",
    agent: "claude",
    harnesses: {
      local: { bin: "/opt/custom-claude" },
      same: { agent: "claude" },
      other: { agent: "cursor" },
      plain: {},
    },
    pipeline: [{ id: "code", harness: ["local", "same", "other", "plain"] }],
  });
  assert.deepEqual(harnessBinChecks(cfg), [
    { name: "local", bin: "/opt/custom-claude" },
    { name: "other", bin: "agent" },
  ]);
});

test("harnessBinChecks: [] without harnesses", () => {
  assert.deepEqual(harnessBinChecks(/** @type {any} */ ({ claudeBin: "claude" })), []);
});

test("harnessBinChecks: a harness only routed through a sandboxed step resolves its bin inside the image, not on the host", () => {
  const cfg = /** @type {any} */ ({
    claudeBin: "claude",
    sandbox: { type: "docker" },
    harnesses: { local: { bin: "claude-in-image" } },
    pipeline: [{ id: "code", harness: "local" }], // sandboxed by default — no sandbox: false
  });
  assert.deepEqual(harnessBinChecks(cfg), [], "sandboxed-only routing never fails doctor on a host that lacks the image's binary");
});

test("harnessBinChecks: a harness no step routes through is silent", () => {
  const cfg = /** @type {any} */ ({
    claudeBin: "claude",
    harnesses: { local: { bin: "/opt/custom-claude" } },
    pipeline: [{ id: "triage", manual: true }],
  });
  assert.deepEqual(harnessBinChecks(cfg), []);
});

test("harnessBinChecks: a harness routed through an unsandboxed step is checked, and ✗ when its bin isn't on PATH", () => {
  const cfg = /** @type {any} */ ({
    claudeBin: "claude",
    sandbox: { type: "docker" },
    harnesses: { local: { bin: "missing-claude" } },
    pipeline: [{ id: "code", harness: "local", sandbox: false }],
  });
  assert.deepEqual(harnessBinChecks(cfg), [{ name: "local", bin: "missing-claude" }]);
});

test("harnessBinChecks: a remote harness's bin runs on the worker — never checked on the host (#691)", () => {
  const cfg = /** @type {any} */ ({
    claudeBin: "claude",
    harnesses: { worker: { remote: { host: "h", workDir: "/w", bin: "not-on-this-host" } } },
    pipeline: [{ id: "code", harness: "worker" }],
  });
  assert.deepEqual(harnessBinChecks(cfg), []);
});

test("agentBinChecks: a step routed only through remote harness(es) is omitted — its bin runs on the worker (#691)", () => {
  const cfg = /** @type {any} */ ({
    claudeBin: "claude",
    harnesses: { worker: { remote: { host: "h", workDir: "/w" } }, local: {} },
    pipeline: [
      { id: "code", harness: "worker" },
      { id: "mixed", harness: ["worker", "local"] },
      { id: "host-only" },
    ],
  });
  const groups = agentBinChecks(cfg);
  const steps = groups.flatMap((g) => g.steps);
  assert.ok(!steps.includes("code"), "a step routed only through remote harnesses must be omitted");
  assert.ok(steps.includes("mixed"), "a step with a local harness in its list still needs the host check");
  assert.ok(steps.includes("host-only"));
});

// --- remoteHarnessChecks (#691): doctor's ssh preflight for every harnesses.<name>.remote ---

/** shQuote's inverse (src/dispatch/executor-ssh.js), for reading back the probe script a
 * remoteHarnessChecks call sent as the last element of its ssh argv. */
function unshQuote(q) {
  return q.slice(1, -1).replace(/'\\''/g, "'");
}

/** A fake `io.run` for remoteHarnessChecks: routes each probe script to the matching override
 * (default: succeeds with no output), so a test only has to say what's different. */
function fakeRemoteRun(overrides = {}) {
  return async (bin, args) => {
    assert.equal(bin, "ssh");
    const script = unshQuote(args.at(-1));
    if (script === "true") return overrides.reach ?? { code: 0, stdout: "", stderr: "" };
    if (script === "command -v git") return overrides.git ?? { code: 0, stdout: "", stderr: "" };
    if (script.includes("--version")) return overrides.version ?? { code: 0, stdout: "claude 1.2.3\n", stderr: "" };
    if (script.startsWith("command -v ")) return overrides.bin ?? { code: 0, stdout: "", stderr: "" };
    if (script.startsWith("mkdir -p") && script.includes("test -w")) return overrides.workDir ?? { code: 0, stdout: "", stderr: "" };
    if (script.includes("ANTHROPIC_API_KEY")) return overrides.cred ?? { code: 1, stdout: "", stderr: "" };
    throw new Error(`unexpected probe script: ${script}`);
  };
}

test("remoteHarnessChecks: [] without any remote harness", async () => {
  const checks = await remoteHarnessChecks(/** @type {any} */ ({ harnesses: { local: {} } }), {
    run: async () => {
      throw new Error("must not be called");
    },
  });
  assert.deepEqual(checks, []);
});

test("remoteHarnessChecks: an unreachable worker is one ✗, and the rest of that harness's probes are skipped", async () => {
  const cfg = /** @type {any} */ ({ harnesses: { worker: { remote: { host: "worker.test", workDir: "/w" } } } });
  const run = fakeRemoteRun({ reach: { code: 255, stdout: "", stderr: "ssh: connect to host worker.test port 22: Connection refused\n" } });
  const checks = await remoteHarnessChecks(cfg, { run });
  assert.equal(checks.length, 1);
  assert.equal(checks[0].ok, false);
  assert.match(checks[0].label, /is reachable/);
  assert.match(checks[0].note, /Connection refused/);
});

test("remoteHarnessChecks: missing git on the worker is a ✗", async () => {
  const cfg = /** @type {any} */ ({ harnesses: { worker: { remote: { host: "h", workDir: "/w" } } } });
  const checks = await remoteHarnessChecks(cfg, { run: fakeRemoteRun({ git: { code: 1, stdout: "", stderr: "" } }) });
  const gitCheck = checks.find((c) => c.label.includes("has git"));
  assert.equal(gitCheck.ok, false);
});

test("remoteHarnessChecks: a missing remote.bin is a ✗", async () => {
  const cfg = /** @type {any} */ ({ harnesses: { worker: { remote: { host: "h", workDir: "/w", bin: "claude" } } } });
  const checks = await remoteHarnessChecks(cfg, { run: fakeRemoteRun({ bin: { code: 1, stdout: "", stderr: "" } }) });
  const binCheck = checks.find((c) => c.label.includes("has agent bin"));
  assert.equal(binCheck.ok, false);
});

test("remoteHarnessChecks: an unwritable workDir is a ✗", async () => {
  const cfg = /** @type {any} */ ({ harnesses: { worker: { remote: { host: "h", workDir: "/w" } } } });
  const checks = await remoteHarnessChecks(cfg, { run: fakeRemoteRun({ workDir: { code: 1, stdout: "", stderr: "" } }) });
  const wd = checks.find((c) => c.label.includes("workDir writable"));
  assert.equal(wd.ok, false);
});

test("remoteHarnessChecks: no credential source found is a ⚠, never a ✗", async () => {
  const cfg = /** @type {any} */ ({ harnesses: { worker: { remote: { host: "h", workDir: "/w" } } } });
  const checks = await remoteHarnessChecks(cfg, { run: fakeRemoteRun({ cred: { code: 1, stdout: "", stderr: "" } }) });
  const cred = checks.find((c) => c.label.includes("has agent credentials"));
  assert.equal(cred.ok, true);
  assert.equal(cred.warn, true);
});

test("remoteHarnessChecks: all good — ok lines including the agent's --version output; the credential probe only names a source, never a value", async () => {
  const cfg = /** @type {any} */ ({ harnesses: { worker: { remote: { host: "h", workDir: "/w", bin: "claude" } } } });
  const run = fakeRemoteRun({
    version: { code: 0, stdout: "2.0.1 (Claude Code)\n", stderr: "" },
    cred: { code: 0, stdout: "env:ANTHROPIC_API_KEY\n", stderr: "" },
  });
  const checks = await remoteHarnessChecks(cfg, { run });
  assert.ok(checks.every((c) => c.ok), JSON.stringify(checks));
  const binCheck = checks.find((c) => c.label.includes("has agent bin"));
  assert.match(binCheck.note, /2\.0\.1/);
  const cred = checks.find((c) => c.label.includes("has agent credentials"));
  assert.equal(cred.note, "env:ANTHROPIC_API_KEY");
  assert.ok(!/sk-|AKIA|Bearer /.test(cred.note), "a credential value must never be echoed, only its source");
});

// --- the credential probe script itself, run for real under `sh` (#691 review): a test that
// only compares a fake run's canned stdout to itself can't catch the script leaking the actual
// value, so this captures the exact script remoteHarnessChecks sends and executes it. ---

/** Runs the real REMOTE_CREDENTIAL_PROBE script (captured off a live remoteHarnessChecks call,
 * never duplicated by hand) under `sh -c`, against an isolated HOME and env.
 * @param {{ env?: Record<string,string>, home?: string }} opts */
function runCredentialProbe({ env = {}, home } = {}) {
  /** @type {string|undefined} */
  let script;
  const capture = async (_bin, args) => {
    const s = unshQuote(args.at(-1));
    if (s.includes("ANTHROPIC_API_KEY")) script = s;
    return { code: 0, stdout: "", stderr: "" };
  };
  const cfg = /** @type {any} */ ({ harnesses: { worker: { remote: { host: "h", workDir: "/w" } } } });
  return remoteHarnessChecks(cfg, { run: capture }).then(() => {
    const homeDir = home ?? fs.mkdtempSync(path.join(os.tmpdir(), "ah-cred-home-"));
    const res = spawnSync("sh", ["-c", /** @type {string} */ (script)], {
      env: { PATH: process.env.PATH, HOME: homeDir, ...env },
      encoding: "utf8",
    });
    return res;
  });
}

test("REMOTE_CREDENTIAL_PROBE script: an env var source prints only the var name, never its value", async () => {
  const res = await runCredentialProbe({ env: { ANTHROPIC_API_KEY: "sk-secret-xyz-should-never-appear" } });
  assert.equal(res.status, 0);
  assert.equal(res.stdout.trim(), "env:ANTHROPIC_API_KEY");
  assert.ok(!res.stdout.includes("sk-secret-xyz-should-never-appear"), "the real key must never be echoed");
});

test("REMOTE_CREDENTIAL_PROBE script: a non-empty ~/.claude/.credentials.json is reported by path, never read out", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ah-cred-home-"));
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", ".credentials.json"), '{"secret":"sk-should-never-appear"}');
  const res = await runCredentialProbe({ home });
  assert.equal(res.status, 0);
  assert.equal(res.stdout.trim(), "file:~/.claude/.credentials.json");
  assert.ok(!res.stdout.includes("sk-should-never-appear"));
});

test("REMOTE_CREDENTIAL_PROBE script: apiKeyHelper in settings.json is reported by key name, never the file contents", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ah-cred-home-"));
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), '{"apiKeyHelper":"/usr/local/bin/get-secret-key --flag=sk-should-never-appear"}');
  const res = await runCredentialProbe({ home });
  assert.equal(res.status, 0);
  assert.equal(res.stdout.trim(), "apiKeyHelper:~/.claude/settings.json");
  assert.ok(!res.stdout.includes("sk-should-never-appear"));
});

test("REMOTE_CREDENTIAL_PROBE script: no source found exits non-zero with no output", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ah-cred-home-"));
  const res = await runCredentialProbe({ home, env: { ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "", CLAUDE_CODE_OAUTH_TOKEN: "" } });
  assert.notEqual(res.status, 0);
  assert.equal(res.stdout.trim(), "");
});

test("remoteHarnessChecks: every probe's ssh argv carries BatchMode=yes, never -A, and the harness's port/identityFile/user", async () => {
  const cfg = /** @type {any} */ ({ harnesses: { worker: { remote: { host: "h", port: 2201, identityFile: "/k", user: "u", workDir: "/w" } } } });
  /** @type {string[][]} */
  const calls = [];
  const inner = fakeRemoteRun();
  const run = async (bin, args) => {
    calls.push(args);
    return inner(bin, args);
  };
  await remoteHarnessChecks(cfg, { run });
  assert.ok(calls.length > 1);
  for (const argv of calls) {
    assert.ok(!argv.includes("-A"), "never agent-forward");
    const oIdx = argv.indexOf("-o");
    assert.equal(argv[oIdx + 1], "BatchMode=yes");
    assert.equal(argv[argv.indexOf("-p") + 1], "2201");
    assert.equal(argv[argv.indexOf("-i") + 1], "/k");
    assert.equal(argv[argv.indexOf("-l") + 1], "u");
  }
});

test("runChecks: wires remoteHarnessChecks in — a profile with a remote harness gets ssh probes through the injected run (#691)", async () => {
  const pipeline = [
    { id: "code", sourceStatus: "code", successStatus: "review", instructionsFile: "./prompts/CODE.md", harness: "worker" },
    { id: "review", sourceStatus: "review", successStatus: "done" },
    { id: "done", manual: true, sourceStatus: "done" },
  ];
  const { cfg, repo } = cleanProfile({
    tracker: { type: "local", pipeline },
    harnesses: { worker: { remote: { host: "worker.test", workDir: "/w" } } },
  });
  /** @type {string[][]} */
  const calls = [];
  const run = async (bin, args) => {
    calls.push([bin, ...args]);
    return fakeRemoteRun()(bin, args);
  };
  const checks = await runChecks(/** @type {any} */ ({ ...cfg, repoPath: repo }), io({ run }));
  assert.ok(calls.some((c) => c[0] === "ssh"), "doctor must run the remote probes through the injected run, not skip them");
  assert.ok(checks.some((c) => /remote harness "worker" is reachable/.test(c.label)));
});

test("harnessLanLints: [] without sandbox or without harnesses", () => {
  const h = { local: { env: { ANTHROPIC_BASE_URL: "http://192.168.1.5:11434" } } };
  assert.deepEqual(harnessLanLints(/** @type {any} */ ({ harnesses: h })), [], "no sandbox block");
  assert.deepEqual(harnessLanLints(/** @type {any} */ ({ sandbox: { type: "docker" } })), [], "no harnesses");
});

test("harnessLanLints: a loopback harness ANTHROPIC_BASE_URL always warns, regardless of egress rules", () => {
  const cfg = /** @type {any} */ ({
    sandbox: { type: "docker", egress: { allow: ["127.0.0.1:11434!private"] } },
    harnesses: { local: { env: { ANTHROPIC_BASE_URL: "http://localhost:11434" } } },
    pipeline: [{ id: "code", harness: "local" }],
  });
  const lints = harnessLanLints(cfg);
  assert.equal(lints.length, 1);
  assert.equal(lints[0].label, `harness "local": ANTHROPIC_BASE_URL http://localhost:11434 is loopback`);
  assert.match(lints[0].note, /is the container itself/);
});

test("harnessLanLints: a loopback harness endpoint is silent when the routed step opts out of the sandbox", () => {
  const cfg = /** @type {any} */ ({
    sandbox: { type: "docker" },
    harnesses: { local: { env: { ANTHROPIC_BASE_URL: "http://localhost:11434" } } },
    pipeline: [{ id: "code", harness: "local", sandbox: false }],
  });
  assert.deepEqual(harnessLanLints(cfg), [], "step runs on the host — localhost there works fine");
});

test("harnessLanLints: a loopback harness no step routes through is silent", () => {
  const cfg = /** @type {any} */ ({
    sandbox: { type: "docker" },
    harnesses: { local: { env: { ANTHROPIC_BASE_URL: "http://localhost:11434" } } },
    pipeline: [{ id: "triage", manual: true }],
  });
  assert.deepEqual(harnessLanLints(cfg), [], "unused harness");
});

test("harnessLanLints: a private (non-loopback) harness endpoint needs a matching !private rule on every routed step", () => {
  const url = "http://192.168.68.2:11434";
  const cfg = /** @type {any} */ ({
    sandbox: { type: "docker" },
    harnesses: { local: { env: { ANTHROPIC_BASE_URL: url } } },
    pipeline: [{ id: "code", harness: "local" }, { id: "triage", manual: true }],
  });
  const missing = harnessLanLints(cfg);
  assert.deepEqual(missing, [{ level: "warn", label: `harness "local": ANTHROPIC_BASE_URL ${url} is a private address`, note: `sandboxed runs need "192.168.68.2:11434!private" in sandbox.egress.allow` }]);

  const allowed = harnessLanLints({ ...cfg, sandbox: { type: "docker", egress: { allow: ["192.168.68.2:11434!private"] } } });
  assert.deepEqual(allowed, []);
});

test("harnessLanLints: a plain step's own ANTHROPIC_BASE_URL is checked the same way, independent of any harness", () => {
  const cfg = /** @type {any} */ ({
    sandbox: { type: "docker" },
    harnesses: { local: {} }, // harnesses must be configured at all for doctor to look
    pipeline: [{ id: "code", env: { ANTHROPIC_BASE_URL: "http://10.0.0.9:9000" } }],
  });
  const lints = harnessLanLints(cfg);
  assert.deepEqual(lints, [{ level: "warn", label: `step "code": ANTHROPIC_BASE_URL http://10.0.0.9:9000 is a private address`, note: `sandboxed runs need "10.0.0.9:9000!private" in sandbox.egress.allow` }]);
});

test("harnessLanLints: a step's own loopback ANTHROPIC_BASE_URL is silent here — egressLints already flags it", () => {
  const cfg = /** @type {any} */ ({
    sandbox: { type: "docker" },
    harnesses: { local: {} },
    pipeline: [{ id: "code", env: { ANTHROPIC_BASE_URL: "http://localhost:11434" } }],
  });
  assert.deepEqual(harnessLanLints(cfg), []);
});

test("harnessLanLints: an IPv6 private address suggests a bracketed host in the egress rule", () => {
  const url = "http://[fd00::5]:11434";
  const cfg = /** @type {any} */ ({
    sandbox: { type: "docker" },
    harnesses: { local: { env: { ANTHROPIC_BASE_URL: url } } },
    pipeline: [{ id: "code", harness: "local" }],
  });
  const lints = harnessLanLints(cfg);
  assert.deepEqual(lints, [{ level: "warn", label: `harness "local": ANTHROPIC_BASE_URL ${url} is a private address`, note: `sandboxed runs need "[fd00::5]:11434!private" in sandbox.egress.allow` }]);
});

test("harnessLanLints: a public hostname, egress mode other than allowlist, or an unclassifiable hostname is silent", () => {
  const harnesses = { local: { env: { ANTHROPIC_BASE_URL: "http://api.example.com:11434" } } };
  assert.deepEqual(harnessLanLints(/** @type {any} */ ({ sandbox: { type: "docker" }, harnesses, pipeline: [{ id: "code", harness: "local" }] })), [], "public hostname — can't tell without DNS");

  const privateHarness = { local: { env: { ANTHROPIC_BASE_URL: "http://192.168.1.5:11434" } } };
  const openCfg = /** @type {any} */ ({ sandbox: { type: "docker", egress: { mode: "open" } }, harnesses: privateHarness, pipeline: [{ id: "code", harness: "local" }] });
  assert.deepEqual(harnessLanLints(openCfg), [], "open mode doesn't need the rule");
});

test("opencodeConfigLints: [] without sandbox, without an opencodeConfig, or on a host step", () => {
  assert.deepEqual(opencodeConfigLints(/** @type {any} */ ({ pipeline: [{ id: "code", opencodeConfig: "/x.json" }] })), [], "no sandbox block");
  const cfg = /** @type {any} */ ({ sandbox: { type: "docker" }, pipeline: [{ id: "code" }] });
  assert.deepEqual(opencodeConfigLints(cfg), [], "no opencodeConfig");
  const hostStep = /** @type {any} */ ({ sandbox: { type: "docker" }, pipeline: [{ id: "code", opencodeConfig: "/x.json", sandbox: false }] });
  assert.deepEqual(opencodeConfigLints(hostStep), [], "step runs on the host");
});

test("opencodeConfigLints: a loopback provider baseURL always warns; a private one needs a matching !private rule", () => {
  const content = JSON.stringify({ provider: { ollama: { options: { baseURL: "http://localhost:11434/v1" } } } });
  const cfg = /** @type {any} */ ({ sandbox: { type: "docker" }, pipeline: [{ id: "code", opencodeConfig: "/x.json" }] });
  const loop = opencodeConfigLints(cfg, { read: () => content });
  assert.deepEqual(loop, [{ level: "warn", label: `opencodeConfig /x.json: provider "ollama" baseURL http://localhost:11434/v1`, note: `inside the sandbox "localhost" is the container itself, not this host — use the host's LAN IP (and allow it with !private)` }]);

  const privateContent = JSON.stringify({ provider: { ollama: { options: { baseURL: "http://192.168.1.10:11434/v1" } } } });
  const missing = opencodeConfigLints(cfg, { read: () => privateContent });
  assert.deepEqual(missing, [{ level: "warn", label: `opencodeConfig /x.json: provider "ollama" baseURL http://192.168.1.10:11434/v1`, note: `sandboxed runs need "192.168.1.10:11434!private" in sandbox.egress.allow` }]);

  const allowedCfg = { ...cfg, sandbox: { type: "docker", egress: { allow: ["192.168.1.10:11434!private"] } } };
  assert.deepEqual(opencodeConfigLints(allowedCfg, { read: () => privateContent }), []);
});

test("opencodeConfigLints: the harness's opencodeConfig applies where the step sets none; an unreadable or invalid file warns with the error", () => {
  const cfg = /** @type {any} */ ({
    sandbox: { type: "docker" },
    harnesses: { "oc-local": { agent: "opencode", opencodeConfig: "/harness.json" } },
    pipeline: [{ id: "code", harness: "oc-local" }],
  });
  const content = JSON.stringify({ provider: { ollama: { options: { baseURL: "http://localhost:11434/v1" } } } });
  const lints = opencodeConfigLints(cfg, { read: () => content });
  assert.equal(lints.length, 1);
  assert.match(lints[0].label, /^opencodeConfig \/harness\.json:/);

  const bad = opencodeConfigLints(cfg, {
    read: () => {
      throw new Error("ENOENT: no such file");
    },
  });
  assert.deepEqual(bad, [{ level: "warn", label: "opencodeConfig /harness.json", note: "unreadable: ENOENT: no such file" }]);

  const invalid = opencodeConfigLints(cfg, { read: () => "{not json" });
  assert.equal(invalid.length, 1);
  assert.match(invalid[0].note, /^invalid JSON:/);
});

test("opencodeEffortLints: [] without sandbox, a non-opencode agent, a step without effort, or no opencodeConfig", () => {
  const content = JSON.stringify({ provider: { openrouter: { models: { "deepseek-v3": {} } } } });
  const noSandbox = /** @type {any} */ ({ pipeline: [{ id: "code", effort: "high", model: "openrouter/deepseek-v3", opencodeConfig: "/x.json" }] });
  assert.deepEqual(opencodeEffortLints(noSandbox, { read: () => content }), []);

  const notOpencode = /** @type {any} */ ({ sandbox: { type: "docker" }, agent: "claude", pipeline: [{ id: "code", effort: "high", model: "openrouter/deepseek-v3", opencodeConfig: "/x.json" }] });
  assert.deepEqual(opencodeEffortLints(notOpencode, { read: () => content }), []);

  const noEffort = /** @type {any} */ ({ sandbox: { type: "docker" }, agent: "opencode", pipeline: [{ id: "code", model: "openrouter/deepseek-v3", opencodeConfig: "/x.json" }] });
  assert.deepEqual(opencodeEffortLints(noEffort, { read: () => content }), []);

  const noConfig = /** @type {any} */ ({ sandbox: { type: "docker" }, agent: "opencode", pipeline: [{ id: "code", effort: "high", model: "openrouter/deepseek-v3" }] });
  assert.deepEqual(opencodeEffortLints(noConfig, { read: () => content }), []);
});

test("opencodeEffortLints: one info line when the declared model lacks the variant; none when it's declared", () => {
  const cfg = /** @type {any} */ ({ sandbox: { type: "docker" }, agent: "opencode", pipeline: [{ id: "code", effort: "high", model: "openrouter/deepseek-v3", opencodeConfig: "/x.json" }] });
  const noVariant = JSON.stringify({ provider: { openrouter: { models: { "deepseek-v3": {} } } } });
  const missing = opencodeEffortLints(cfg, { read: () => noVariant });
  assert.deepEqual(missing, [{ level: "info", label: `step "code": effort "high"`, note: `opencodeConfig /x.json declares no "high" variant for openrouter/deepseek-v3 — OpenCode will not send a reasoning effort` }]);

  const withVariant = JSON.stringify({ provider: { openrouter: { models: { "deepseek-v3": { variants: { high: { reasoningEffort: "high" } } } } } } });
  assert.deepEqual(opencodeEffortLints(cfg, { read: () => withVariant }), []);

  const disabledVariant = JSON.stringify({ provider: { openrouter: { models: { "deepseek-v3": { variants: { high: { disabled: true } } } } } } });
  assert.equal(opencodeEffortLints(cfg, { read: () => disabledVariant }).length, 1, "a disabled variant counts as not declared");
});

test("opencodeEffortLints: [] when the model is not declared in the config", () => {
  const cfg = /** @type {any} */ ({ sandbox: { type: "docker" }, agent: "opencode", pipeline: [{ id: "code", effort: "high", model: "openrouter/deepseek-v3", opencodeConfig: "/x.json" }] });
  const content = JSON.stringify({ provider: { openrouter: { models: {} } } });
  assert.deepEqual(opencodeEffortLints(cfg, { read: () => content }), []);
});

test("opencodeEffortLints: a harness-supplied opencodeConfig/model is honored", () => {
  const cfg = /** @type {any} */ ({
    sandbox: { type: "docker" },
    harnesses: { "oc-local": { agent: "opencode", model: "openrouter/deepseek-v3", opencodeConfig: "/harness.json" } },
    pipeline: [{ id: "code", harness: "oc-local", effort: "medium" }],
  });
  const content = JSON.stringify({ provider: { openrouter: { models: { "deepseek-v3": {} } } } });
  const lints = opencodeEffortLints(cfg, { read: () => content });
  assert.deepEqual(lints, [{ level: "info", label: `step "code" on "oc-local": effort "medium"`, note: `opencodeConfig /harness.json declares no "medium" variant for openrouter/deepseek-v3 — OpenCode will not send a reasoning effort` }]);
});

test("harnessSlotLints: [] without harnesses; one ℹ per harness (slot count or unbounded); ⚠ when a step's harnesses all cap to 0", () => {
  assert.deepEqual(harnessSlotLints(/** @type {any} */ ({})), []);
  const cfg = /** @type {any} */ ({
    harnesses: { local: { maxConcurrent: 2 }, remote: {} },
    pipeline: [{ id: "code", harness: ["local", "remote"] }],
  });
  const lints = harnessSlotLints(cfg);
  assert.deepEqual(lints.filter((l) => l.level === "info"), [
    { level: "info", label: `harness "local"`, note: "2 slot(s)" },
    { level: "info", label: `harness "remote"`, note: "unbounded" },
  ]);
  assert.deepEqual(lints.filter((l) => l.level === "warn"), []);

  const dead = /** @type {any} */ ({
    harnesses: { a: { maxConcurrent: 0 }, b: { maxConcurrent: 0 } },
    pipeline: [{ id: "code", harness: ["a", "b"] }],
  });
  const deadLints = harnessSlotLints(dead);
  assert.ok(deadLints.some((l) => l.level === "warn" && l.label === `step "code" harness slots` && /can never run/.test(l.note)));
});

test("runChecks: harness bins, LAN endpoint and slot lines show up end to end, and are absent without harnesses", async () => {
  const { cfg } = cleanProfile();
  const plain = await runChecks(cfg, io());
  assert.ok(!plain.some((c) => c.label.includes("harness ")), "no harnesses — no new lines");

  const withHarnesses = /** @type {any} */ ({
    ...cfg,
    sandbox: { type: "docker" },
    harnesses: { local: { bin: "/opt/custom-claude", env: { ANTHROPIC_BASE_URL: "http://192.168.68.2:11434" } }, remote: { maxConcurrent: 3 } },
    pipeline: [
      { id: "code", harness: "local", env: { CLAUDE_CODE_OAUTH_TOKEN: "t" } },
      { id: "code-host", harness: "local", sandbox: false, env: { CLAUDE_CODE_OAUTH_TOKEN: "t" } },
      { id: "done", manual: true },
    ],
  });
  const checks = await runChecks(withHarnesses, io({ has: () => true, run: async () => ({ code: 0, stdout: "", stderr: "" }) }));
  assert.ok(checks.some((c) => c.label === `harness "local" binary "/opt/custom-claude"` && c.ok));
  assert.ok(checks.some((c) => c.warn && c.label.startsWith(`harness "local": ANTHROPIC_BASE_URL`) && /private address/.test(c.label)));
  assert.ok(checks.some((c) => c.info && c.label === `harness "remote"` && c.note === "3 slot(s)"));
});
