import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// Remote harness phase 3 (#739, the remote-harness epic #681): an OpenCode agent on a remote
// worker, through the SAME ssh executor claude already uses (src/dispatch/executor-ssh.js) plus
// opencode's new `remote` hook (src/agents/opencode.js). test/dispatch-executor-ssh.test.js is
// already ~87 KB, so this is a new file, sharing its fake-ssh fixture via test/_ssh-helpers.js.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { withFakeSsh, spawnCtx } from "./_ssh-helpers.js";
import { createSshExecutor } from "../src/dispatch/executor-ssh.js";
import { opencode, buildOpencodeArgs } from "../src/agents/opencode.js";
import { validateRawConfig } from "../src/config/validate/index.js";
import { REMOTE_AGENTS } from "../src/agents/names.js";
import { remoteHarnessChecks } from "../src/commands/doctor.js";
import { createDispatcher } from "../src/dispatch/index.js";
import { createStore } from "../src/store/index.js";

/** A tiny git repo with one commit — a worktree-step dispatch run needs a real hub repo (#690
 * syncs HEAD to the worker before every run). @param {string} dir */
function initGitRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const g = (args) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  g(["init", "--quiet", "-b", "main"]);
  g(["config", "user.email", "a@example.test"]);
  g(["config", "user.name", "a"]);
  fs.writeFileSync(path.join(dir, "README.md"), "hi\n");
  g(["add", "README.md"]);
  g(["commit", "--quiet", "-m", "init"]);
}

// --- config: opencode is accepted on a remote harness, cursor/hermes still refused ---

function baseConfig(overrides = {}) {
  return {
    name: "p",
    tracker: { type: "local", pipeline: [{ id: "code", harness: "worker" }] },
    repoPath: "/repo",
    harnesses: { worker: { remote: { host: "h", workDir: "/w" } } },
    ...overrides,
  };
}

test("config: a remote harness resolving to opencode is accepted", () => {
  const cfg = baseConfig({ harnesses: { worker: { agent: "opencode", remote: { host: "h", workDir: "/w" } } } });
  const v = validateRawConfig(cfg);
  assert.equal(v.ok, true, v.ok ? "" : v.errors.join("\n"));
});

for (const bad of ["cursor", "hermes"]) {
  test(`config refusal: a remote harness resolving to agent ${bad}`, () => {
    const cfg = baseConfig({ harnesses: { worker: { agent: bad, remote: { host: "h", workDir: "/w" } } } });
    const v = validateRawConfig(cfg);
    assert.equal(v.ok, false);
    assert.ok(v.errors.some((e) => e.includes(`resolves to agent ${JSON.stringify(bad)}`) && e.includes(`supported on a remote worker: ${REMOTE_AGENTS.join(", ")}`)), v.errors.join("\n"));
  });
}

// --- opencode.remote(): the unit (files/env it builds, cap/validation reuse, standing dedupe) ---

test("opencode.remote: no opencodeConfig, no standing — just the contract file + a config holding only instructions, OPENCODE_CONFIG pointing at it", () => {
  const own = opencode.remote({ cfg: /** @type {any} */ ({}), step: /** @type {any} */ ({ id: "code" }), dir: "/run/code-1.opencode", verdictFile: "/v/verdict.json" });
  assert.equal(own.env.OPENCODE_CONFIG, "/run/code-1.opencode/opencode.json");
  assert.equal(own.env.OPENCODE_DISABLE_AUTOUPDATE, "1");
  assert.equal(own.env.OPENCODE_DISABLE_MODELS_FETCH, "1");
  assert.equal(own.files.length, 2, JSON.stringify(own.files));
  const config = JSON.parse(own.files.find((f) => f.dst === "/run/code-1.opencode/opencode.json").content);
  assert.deepEqual(config.instructions, ["/run/code-1.opencode/agenthook-unattended.md"]);
  assert.ok(!own.standingInInstructions);
});

test("opencode.remote: a given opencodeConfig's instructions are merged with the contract's, and the config's own fields survive", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-ocr-cfg-"));
  const cfgPath = path.join(dir, "opencode.json");
  fs.writeFileSync(cfgPath, JSON.stringify({ model: "anthropic/claude", instructions: ["/already/there.md"] }));
  try {
    const own = opencode.remote({ cfg: /** @type {any} */ ({}), step: /** @type {any} */ ({ id: "code", opencodeConfig: cfgPath }), dir: "/run/code-1.opencode", verdictFile: "/v/verdict.json" });
    const config = JSON.parse(own.files.find((f) => f.dst === "/run/code-1.opencode/opencode.json").content);
    assert.equal(config.model, "anthropic/claude");
    assert.deepEqual(config.instructions, ["/already/there.md", "/run/code-1.opencode/agenthook-unattended.md"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("opencode.remote: an oversize or invalid opencodeConfig throws `opencodeConfig <path>: …` — never builds files", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-ocr-bad-"));
  try {
    const missing = path.join(dir, "nope.json");
    assert.throws(() => opencode.remote({ cfg: /** @type {any} */ ({}), step: /** @type {any} */ ({ opencodeConfig: missing }), dir: "/run/x.opencode", verdictFile: "/v/verdict.json" }), new RegExp(`^Error: opencodeConfig ${missing}:`));
    const bad = path.join(dir, "bad.json");
    fs.writeFileSync(bad, "not json");
    assert.throws(() => opencode.remote({ cfg: /** @type {any} */ ({}), step: /** @type {any} */ ({ opencodeConfig: bad }), dir: "/run/x.opencode", verdictFile: "/v/verdict.json" }), /invalid JSON/);
    const big = path.join(dir, "big.json");
    fs.writeFileSync(big, JSON.stringify({ pad: "x".repeat(300 * 1024) }));
    assert.throws(() => opencode.remote({ cfg: /** @type {any} */ ({}), step: /** @type {any} */ ({ opencodeConfig: big }), dir: "/run/x.opencode", verdictFile: "/v/verdict.json" }), /exceeds the .* cap/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("opencode.remote: standing ≤ 16 KB is written as a second instructions file, and standingInInstructions is reported", () => {
  const own = opencode.remote({ cfg: /** @type {any} */ ({}), step: /** @type {any} */ ({ id: "code" }), dir: "/run/code-1.opencode", verdictFile: "/v/verdict.json", standing: "repo + step instructions" });
  assert.ok(own.standingInInstructions);
  const standingFile = own.files.find((f) => f.dst === "/run/code-1.opencode/agenthook-standing.md");
  assert.equal(standingFile.content, "repo + step instructions");
  const config = JSON.parse(own.files.find((f) => f.dst.endsWith("opencode.json")).content);
  assert.ok(config.instructions.includes("/run/code-1.opencode/agenthook-standing.md"));
});

test("opencode.remote: standing > 16 KB is dropped (warns), never written as a file", () => {
  const own = opencode.remote({ cfg: /** @type {any} */ ({}), step: /** @type {any} */ ({ id: "code" }), dir: "/run/code-1.opencode", verdictFile: "/v/verdict.json", standing: "x".repeat(17 * 1024) });
  assert.ok(!own.standingInInstructions);
  assert.ok(!own.files.some((f) => f.dst.includes("agenthook-standing.md")));
});

// --- end-to-end against the fake ssh transport: argv shape, stdin, env, files, cleanup ---

/** A fake `opencode` binary: records its argv/stdin, echoes the OPENCODE_CONFIG file's content
 * back (so the test can check what the worker actually saw), emits one `step_finish` JSONL event
 * (so the usage/turn-stats path exercises for real), then — once `goFile` appears, so a test can
 * inspect the per-run config dir WHILE the run is still in flight — writes the verdict and exits.
 * @param {{workDir: string, goFile: string}} o */
function fakeOpencodeScript({ workDir, goFile }) {
  return [
    `#!/bin/sh`,
    `printf '%s' "$*" > "${workDir}/argv.txt"`,
    `cat > "${workDir}/stdin.txt"`,
    `cp "$OPENCODE_CONFIG" "${workDir}/seen-config.json" 2>/dev/null || true`,
    `env | grep -E '^(OPENCODE_|AGENTHOOK_|ANTHROPIC_|SSH_AUTH_SOCK|GITHUB_)' > "${workDir}/env.txt" || true`,
    `touch "${workDir}/started"`,
    `while [ ! -f ${goFile} ]; do sleep 0.02; done`,
    `echo '{"type":"step_finish","sessionID":"sess-1","part":{"tokens":{"input":120,"output":40,"cache":{"read":0,"write":0}},"cost":0}}'`,
    `mkdir -p "$(dirname "$AGENTHOOK_VERDICT_FILE")"`,
    `echo '{"outcome":"advance","reason":"ok"}' > "$AGENTHOOK_VERDICT_FILE"`,
    `exit 0`,
  ].join("\n");
}

test("ssh executor + opencode.remote: worker argv carries no prompt, the prompt lands on stdin, the worker env carries exactly the allowed + hook keys, and the per-run config dir is removed after a clean exit", async () => {
  const ssh = withFakeSsh();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ah-ssh-oc-"));
  const workDir = path.join(root, "work");
  fs.mkdirSync(workDir, { recursive: true });
  try {
    const goFile = path.join(workDir, "go");
    const agentScript = path.join(workDir, "opencode.sh");
    fs.writeFileSync(agentScript, fakeOpencodeScript({ workDir, goFile }), { mode: 0o755 });
    const remote = { host: "worker.test", workDir, bin: agentScript };
    const hubVerdictFile = path.join(root, "hub-verdict.json");
    const executor = createSshExecutor({ stateKey: "p", remote, spawnPaths: { sandboxVerdictPathFor: () => hubVerdictFile } });
    const { verdictFile, configDir } = executor.paths({ stepId: "code", ref: "9" });
    const own = opencode.remote({ cfg: /** @type {any} */ ({}), step: /** @type {any} */ ({ id: "code" }), dir: /** @type {string} */ (configDir), verdictFile });

    const { spawnAgent } = spawnCtx();
    const prompt = "do the opencode thing";
    const args = buildOpencodeArgs({ prompt, fullAuto: true });
    const launchPromise = spawnAgent({
      agent: { defaults: { bin: "opencode" }, buildArgs: () => args, createParser: opencode.createParser },
      prompt,
      cwd: workDir,
      logPath: path.join(root, "run.log"),
      verdictFile,
      env: { OPENCODE_API_KEY: "hub-secret-must-not-cross", OPENCODE_FOO: "bar", ANTHROPIC_API_KEY: "also-must-not-cross", GITHUB_TOKEN: "tracker-token-must-not-cross" },
      sandboxed: { ref: "9", stepId: "code", step: {}, mounts: [], files: own.files, env: own.env },
      executor,
    });

    // While the run is in flight: the config dir's files exist on the worker.
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(path.join(workDir, "started")) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    assert.ok(fs.existsSync(path.join(workDir, "started")), "the fake opencode binary never started");
    assert.ok(fs.existsSync(/** @type {string} */ (configDir)), "the per-run config dir must exist while the agent runs");
    assert.ok(fs.existsSync(path.join(/** @type {string} */ (configDir), "opencode.json")), "opencode.json must exist while the agent runs");
    const configOnDisk = JSON.parse(fs.readFileSync(path.join(/** @type {string} */ (configDir), "opencode.json"), "utf8"));
    assert.deepEqual(configOnDisk.instructions, [`${configDir}/agenthook-unattended.md`]);

    fs.writeFileSync(goFile, "");
    const result = await launchPromise;
    assert.equal(result.code, 0, JSON.stringify(result));
    assert.equal(result.turnStats?.turns, 1, JSON.stringify(result.turnStats));
    assert.deepEqual(
      result.result?.tokens && { input: result.result.tokens.input, output: result.result.tokens.output },
      { input: 120, output: 40 },
      "the usage tally must carry the fake agent's real step_finish numbers, same as a local OpenCode run",
    );

    const argv = fs.readFileSync(path.join(workDir, "argv.txt"), "utf8");
    assert.ok(!argv.includes(prompt), "the prompt must never reach the worker's own argv");
    assert.match(argv, /^run --format json --auto .*--$/, `unexpected worker argv: ${argv}`);
    const stdin = fs.readFileSync(path.join(workDir, "stdin.txt"), "utf8");
    assert.equal(stdin, prompt, "the prompt must arrive on the agent's own stdin");

    const seenConfig = JSON.parse(fs.readFileSync(path.join(workDir, "seen-config.json"), "utf8"));
    assert.deepEqual(seenConfig.instructions, [`${configDir}/agenthook-unattended.md`]);

    const env = fs.readFileSync(path.join(workDir, "env.txt"), "utf8");
    assert.match(env, /^AGENTHOOK_VERDICT_FILE=/m);
    assert.match(env, new RegExp(`^OPENCODE_CONFIG=${configDir}/opencode\\.json$`, "m"));
    assert.match(env, /^OPENCODE_DISABLE_AUTOUPDATE=1$/m);
    assert.match(env, /^OPENCODE_DISABLE_MODELS_FETCH=1$/m);
    assert.ok(!env.includes("OPENCODE_API_KEY"), "the hub's own OPENCODE_API_KEY must never cross");
    assert.ok(!env.includes("OPENCODE_FOO"), "a hub-side OPENCODE_* value unrelated to the hook's return must never cross");
    assert.ok(!env.includes("ANTHROPIC_API_KEY"), "ANTHROPIC_* must never cross");
    assert.ok(!env.includes("GITHUB_TOKEN"), "tracker tokens must never cross");
    // The fake ssh is a local child of this process, so it inherits the test host's own agent
    // socket; a real worker never does (no `-A`). What must hold is that the receiver never
    // frames one — `remoteEnvAllowlist` is asserted on directly in the -config tests.
    assert.ok(!env.includes("SSH_AUTH_SOCK") || !!process.env.SSH_AUTH_SOCK, "no agent-forward socket unless the host itself had one");

    assert.ok(fs.existsSync(hubVerdictFile), "the verdict must be copied back to the hub");
    assert.deepEqual(JSON.parse(fs.readFileSync(hubVerdictFile, "utf8")), { outcome: "advance", reason: "ok" });

    assert.ok(!fs.existsSync(/** @type {string} */ (configDir)), "the per-run config dir must be removed after a clean exit");
  } finally {
    ssh.restore();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ssh executor + opencode.remote: an error event then a non-zero exit fails the run with an errorLine, like a local OpenCode crash", async () => {
  const ssh = withFakeSsh();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ah-ssh-oc-err-"));
  const workDir = path.join(root, "work");
  fs.mkdirSync(workDir, { recursive: true });
  try {
    const agentScript = path.join(workDir, "opencode-fail.sh");
    fs.writeFileSync(
      agentScript,
      [
        `#!/bin/sh`,
        `cat > /dev/null`,
        `echo '{"type":"error","error":{"name":"ProviderAuthError","data":{"message":"bad key"}}}'`,
        `echo "ProviderAuthError: bad key" >&2`,
        `exit 1`,
      ].join("\n"),
      { mode: 0o755 },
    );
    const remote = { host: "worker.test", workDir, bin: agentScript };
    const executor = createSshExecutor({ stateKey: "p", remote, spawnPaths: { sandboxVerdictPathFor: () => path.join(root, "hub-verdict.json") } });
    const { verdictFile, configDir } = executor.paths({ stepId: "code", ref: "10" });
    const own = opencode.remote({ cfg: /** @type {any} */ ({}), step: /** @type {any} */ ({ id: "code" }), dir: /** @type {string} */ (configDir), verdictFile });
    const { spawnAgent } = spawnCtx();
    const { createOpencodeParser } = /** @type {any} */ (opencode);
    const result = await spawnAgent({
      agent: { defaults: { bin: "opencode" }, buildArgs: ({ prompt }) => buildOpencodeArgs({ prompt }), createParser: opencode.createParser },
      prompt: "hi",
      cwd: workDir,
      logPath: path.join(root, "run.log"),
      verdictFile,
      env: {},
      sandboxed: { ref: "10", stepId: "code", step: {}, mounts: [], files: own.files, env: own.env },
      executor,
    });
    assert.notEqual(result.code, 0);
    assert.match(result.errorLine ?? "", /ProviderAuthError/);
    assert.ok(!fs.existsSync(/** @type {string} */ (configDir)), "the per-run config dir must be removed after a failed exit too");
  } finally {
    ssh.restore();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ssh executor: a remote opencode launch throws when the prompt isn't found at the claude-arg1 or opencode-last-arg position — refused, nothing spawns", async () => {
  const ssh = withFakeSsh();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ah-ssh-oc-mismatch-"));
  try {
    const remote = { host: "worker.test", workDir: root, bin: "whatever" };
    const executor = createSshExecutor({ stateKey: "p", remote, spawnPaths: { sandboxVerdictPathFor: () => path.join(root, "hub-verdict.json") } });
    await assert.rejects(
      executor.launch({ runId: "r1", ref: "1", stepId: "code", bin: "whatever", args: ["run", "--format", "json", "--", "the prompt"], env: {}, prompt: "a different prompt" }),
      /could not find the prompt/,
    );
  } finally {
    ssh.restore();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --- doctor: remoteHarnessChecks resolves the harness's own agent, not a hard-coded claude ---

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
    if (script.includes("--version")) return overrides.version ?? { code: 0, stdout: "0.1.0\n", stderr: "" };
    if (script.startsWith("command -v ")) return overrides.bin ?? { code: 0, stdout: "", stderr: "" };
    if (script.startsWith("mkdir -p") && script.includes("test -w")) return overrides.workDir ?? { code: 0, stdout: "", stderr: "" };
    if (script.includes("ANTHROPIC_API_KEY")) throw new Error("the claude credential probe must not run for an opencode harness");
    throw new Error(`unexpected probe script: ${script}`);
  };
}

test("remoteHarnessChecks: an opencode harness probes the opencode bin (not claude), reports its version, and never runs the claude credential probe", async () => {
  const cfg = /** @type {any} */ ({ harnesses: { worker: { agent: "opencode", remote: { host: "h", workDir: "/w" } } } });
  const checks = await remoteHarnessChecks(cfg, { run: fakeRemoteRun({ version: { code: 0, stdout: "1.19.5\n", stderr: "" } }) });
  const binCheck = checks.find((c) => c.label.includes("has agent bin"));
  assert.ok(binCheck, JSON.stringify(checks));
  assert.match(binCheck.label, /"opencode"/);
  assert.equal(binCheck.ok, true);
  assert.match(binCheck.note, /1\.19\.5/);
  assert.ok(!checks.some((c) => c.label.includes("credentials")), "no credential check for an opencode harness");
});

test("remoteHarnessChecks: a missing opencode bin on an opencode harness is a ✗ with the OpenCode install hint", async () => {
  const cfg = /** @type {any} */ ({ harnesses: { worker: { agent: "opencode", remote: { host: "h", workDir: "/w" } } } });
  const checks = await remoteHarnessChecks(cfg, { run: fakeRemoteRun({ bin: { code: 1, stdout: "", stderr: "" } }) });
  const binCheck = checks.find((c) => c.label.includes("has agent bin"));
  assert.equal(binCheck.ok, false);
  assert.match(binCheck.fix.manual, /opencode\.ai/);
});

test("remoteHarnessChecks: remote.bin overrides the resolved agent's own default even for opencode", async () => {
  const cfg = /** @type {any} */ ({ harnesses: { worker: { agent: "opencode", remote: { host: "h", workDir: "/w", bin: "/custom/opencode" } } } });
  const checks = await remoteHarnessChecks(cfg, { run: fakeRemoteRun({}) });
  const binCheck = checks.find((c) => c.label.includes("has agent bin"));
  assert.match(binCheck.label, /\/custom\/opencode/);
});

// --- full dispatch, through step.js's remote branch: the worker verdict routes the run ---

test("dispatch: a worktree step on an opencode remote harness runs through step.js's remote branch end to end — the worker's verdict is copied back and the run advances", async () => {
  const ssh = withFakeSsh();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ah-ssh-oc-dispatch-"));
  const workDir = path.join(root, "work");
  const repoPath = path.join(root, "repo");
  fs.mkdirSync(workDir, { recursive: true });
  initGitRepo(repoPath);
  try {
    const agentScript = path.join(workDir, "opencode.sh");
    fs.writeFileSync(
      agentScript,
      [
        `#!/bin/sh`,
        `cat > /dev/null`,
        `[ -f "$OPENCODE_CONFIG" ] || { echo "no OPENCODE_CONFIG" >&2; exit 1; }`,
        `echo '{"type":"step_finish","sessionID":"s1","part":{"tokens":{"input":10,"output":5,"cache":{"read":0,"write":0}},"cost":0}}'`,
        `mkdir -p "$(dirname "$AGENTHOOK_VERDICT_FILE")"`,
        `echo '{"outcome":"advance","reason":"ok"}' > "$AGENTHOOK_VERDICT_FILE"`,
        `exit 0`,
      ].join("\n"),
      { mode: 0o755 },
    );
    const cfg = /** @type {any} */ ({
      pipeline: [{ id: "code", harness: "worker" }],
      harnesses: { worker: { agent: "opencode", remote: { host: "worker.test", workDir, bin: agentScript } } },
      repoPath,
      stateKey: "p",
      stateDir: root,
      dataDir: root,
      logDir: root,
      instructionsFile: path.join(root, "none.md"),
    });
    const store = createStore(root);
    const advanceCalls = [];
    const adapter = /** @type {any} */ ({
      describe: () => ({ platform: "GitHub", taskNoun: "issue", trigger: "@agent", commentHowTo: "comment" }),
      fetchTask: async (ref) => ({ ref, name: "t", description: "d", url: "https://example.test/1", completed: false, assignedToUs: true }),
      advance: async (...a) => advanceCalls.push(a),
    });
    const run = createDispatcher(cfg, adapter, undefined, store, () => {}, null, undefined, { killGraceMs: 300 });
    const l = console.log;
    console.log = () => {};
    try {
      const result = await run({ kind: "pipeline", ref: "77", stepId: "code", dedupKey: "k:77", harness: "worker" });
      assert.equal(result.code, 0, JSON.stringify(result));
    } finally {
      console.log = l;
    }
    assert.equal(advanceCalls.length, 1, "the worker's verdict must actually route the run, not just exit 0");
    assert.equal(advanceCalls[0][0], "77");
    assert.equal(advanceCalls[0][1], "code");
    assert.equal(advanceCalls[0][2].outcome, "advance");
    assert.equal(advanceCalls[0][2].reason, "ok");
    const usage = store.readUsage();
    assert.equal(usage.length, 1);
    assert.equal(usage[0].input, 10);
    assert.equal(usage[0].output, 5);
  } finally {
    ssh.restore();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("dispatch: a remote opencode harness with no remote.bin defaults the worker bin to the agent's own default — a fake `opencode` on the worker PATH runs, not `claude`", async () => {
  const ssh = withFakeSsh();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ah-ssh-oc-defaultbin-"));
  const workDir = path.join(root, "work");
  const repoPath = path.join(root, "repo");
  fs.mkdirSync(workDir, { recursive: true });
  initGitRepo(repoPath);
  // The fake ssh runs `sh -c <launcher>` locally with the test's own PATH, so a directory
  // holding an executable literally named `opencode` stands in for the worker's installed CLI.
  const bins = path.join(root, "bins");
  fs.mkdirSync(bins, { recursive: true });
  const marker = path.join(workDir, "argv0.txt");
  fs.writeFileSync(
    path.join(bins, "opencode"),
    [
      `#!/bin/sh`,
      `printf '%s' "$0" > "${marker}"`,
      `printf ' %s' "$*" >> "${marker}"`,
      `cat > /dev/null`,
      `[ -f "$OPENCODE_CONFIG" ] || { echo "no OPENCODE_CONFIG" >&2; exit 1; }`,
      `echo '{"type":"step_finish","sessionID":"s2","part":{"tokens":{"input":7,"output":3,"cache":{"read":0,"write":0}},"cost":0}}'`,
      `mkdir -p "$(dirname "$AGENTHOOK_VERDICT_FILE")"`,
      `echo '{"outcome":"advance","reason":"ok"}' > "$AGENTHOOK_VERDICT_FILE"`,
      `exit 0`,
    ].join("\n"),
    { mode: 0o755 },
  );
  const savedPath = process.env.PATH;
  process.env.PATH = `${bins}${path.delimiter}${savedPath}`;
  try {
    const cfg = /** @type {any} */ ({
      pipeline: [{ id: "code", harness: "worker" }],
      harnesses: { worker: { agent: "opencode", remote: { host: "worker.test", workDir } } },
      repoPath,
      stateKey: "p",
      stateDir: root,
      dataDir: root,
      logDir: root,
      instructionsFile: path.join(root, "none.md"),
    });
    const store = createStore(root);
    const advanceCalls = [];
    const adapter = /** @type {any} */ ({
      describe: () => ({ platform: "GitHub", taskNoun: "issue", trigger: "@agent", commentHowTo: "comment" }),
      fetchTask: async (ref) => ({ ref, name: "t", description: "d", url: "https://example.test/1", completed: false, assignedToUs: true }),
      advance: async (...a) => advanceCalls.push(a),
    });
    const run = createDispatcher(cfg, adapter, undefined, store, () => {}, null, undefined, { killGraceMs: 300 });
    const l = console.log;
    console.log = () => {};
    let result;
    try {
      result = await run({ kind: "pipeline", ref: "78", stepId: "code", dedupKey: "k:78", harness: "worker" });
    } finally {
      console.log = l;
    }
    assert.equal(result.code, 0, JSON.stringify(result));
    assert.equal(advanceCalls.length, 1, "the fake opencode's verdict must route the run");
    assert.ok(fs.existsSync(marker), "the fake `opencode` binary on the worker PATH must actually run");
    const argv0 = fs.readFileSync(marker, "utf8");
    assert.match(argv0, /\/opencode run --format json/, `the worker argv[0] must be opencode, not claude: ${argv0}`);
  } finally {
    process.env.PATH = savedPath;
    ssh.restore();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

