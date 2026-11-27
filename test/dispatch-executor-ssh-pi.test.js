import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// Remote (ssh) harness phase 3 pi (#827): a pi agent on a remote worker, through the SAME ssh
// executor claude/opencode already use (src/dispatch/executor-ssh.js) plus pi's new `remote` hook
// (src/agents/pi.js). test/agents-pi.test.js covers pi.remote at the unit level (files/args/env,
// piConfigDir ignored); this file covers the config gate, the worker argv/stdin/env/file contract
// through the fake ssh, and `remoteHarnessChecks`' pi preflight. Reuses the `.opencode`-suffixed
// per-run dir (a historical name) — the contract/standing files land there with no generated config.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { withFakeSsh, spawnCtx } from "./_ssh-helpers.js";
import { createSshExecutor, shQuote } from "../src/dispatch/executor-ssh.js";
import { pi, buildPiArgs } from "../src/agents/pi.js";
import { validateRawConfig } from "../src/config/validate/index.js";
import { REMOTE_AGENTS } from "../src/agents/names.js";
import { remoteHarnessChecks } from "../src/commands/doctor.js";

// --- config: pi is accepted on a remote harness; the refusal lists REMOTE_AGENTS ---

function baseConfig(overrides = {}) {
  return {
    name: "p",
    tracker: { type: "local", pipeline: [{ id: "code", harness: "worker" }] },
    repoPath: "/repo",
    harnesses: { worker: { remote: { host: "h", workDir: "/w" } } },
    ...overrides,
  };
}

test("config: a remote harness resolving to pi is accepted", () => {
  const v = validateRawConfig(baseConfig({ harnesses: { worker: { agent: "pi", remote: { host: "h", workDir: "/w" } } } }));
  assert.equal(v.ok, true, v.ok ? "" : v.errors.join("\n"));
});

for (const bad of ["cursor", "hermes"]) {
  test(`config refusal: a remote harness resolving to agent ${bad} lists the supported agents from REMOTE_AGENTS`, () => {
    const v = validateRawConfig(baseConfig({ harnesses: { worker: { agent: bad, remote: { host: "h", workDir: "/w" } } } }));
    assert.equal(v.ok, false);
    assert.ok(v.errors.some((e) => e.includes(`resolves to agent ${JSON.stringify(bad)}`) && e.includes(`supported on a remote worker: ${REMOTE_AGENTS.join(", ")}`)), v.errors.join("\n"));
  });
}

// --- end-to-end against the fake ssh transport: argv shape, stdin, env, files, cleanup ---

/** A fake `pi` binary: records its argv (one arg per line), stdin and the interesting env, emits
 * real pi JSONL on stdout (a session, two assistant message_ends with per-turn usage, one
 * compaction — so the worker-stdout path through createPiParser is exercised for real, not just
 * the transport), then — once `goFile` appears, so a test can inspect the per-run dir WHILE the
 * run is in flight — writes the verdict and exits.
 * @param {{workDir: string, goFile: string}} o */
function fakePiScript({ workDir, goFile }) {
  return [
    `#!/bin/sh`,
    `printf '%s\\n' "$@" > "${workDir}/argv.txt"`,
    `cat > "${workDir}/stdin.txt"`,
    `env | grep -E '^(PI_|ANTHROPIC_|GITHUB_|GH_TOKEN|AGENTHOOK_|TERM|LANG|CI)' > "${workDir}/env.txt" || true`,
    `touch "${workDir}/started"`,
    `while [ ! -f ${goFile} ]; do sleep 0.02; done`,
    `echo '{"type":"session","id":"sess-pi-1"}'`,
    `echo '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"turn one"}],"usage":{"input":120,"output":40,"cacheRead":10,"cacheWrite":5}}}'`,
    `echo '{"type":"message_end","message":{"role":"assistant","content":[],"usage":{"input":70,"output":30,"cacheRead":20,"cacheWrite":0}}}'`,
    `echo '{"type":"compaction_end","result":{"usage":{"input":50,"output":20},"tokensBefore":1000,"estimatedTokensAfter":400}}'`,
    `mkdir -p "$(dirname "$AGENTHOOK_VERDICT_FILE")"`,
    `echo '{"outcome":"advance","reason":"ok"}' > "$AGENTHOOK_VERDICT_FILE"`,
    `exit 0`,
  ].join("\n");
}

test("ssh executor + pi.remote: worker argv ends at -- (prompt on stdin, never argv), carries both --append-system-prompt flags, worker env is exactly the allowlist + PI_OFFLINE, and the per-run dir is removed after a clean exit", async () => {
  const ssh = withFakeSsh();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ah-ssh-pi-"));
  const workDir = path.join(root, "work");
  fs.mkdirSync(workDir, { recursive: true });
  try {
    const goFile = path.join(workDir, "go");
    const agentScript = path.join(workDir, "pi.sh");
    fs.writeFileSync(agentScript, fakePiScript({ workDir, goFile }), { mode: 0o755 });
    const remote = { host: "worker.test", workDir, bin: agentScript };
    const hubVerdictFile = path.join(root, "hub-verdict.json");
    const executor = createSshExecutor({ stateKey: "p", remote, spawnPaths: { sandboxVerdictPathFor: () => hubVerdictFile } });
    const { verdictFile, configDir } = executor.paths({ stepId: "code", ref: "9" });
    const own = pi.remote({ cfg: /** @type {any} */ ({}), step: /** @type {any} */ ({ id: "code" }), dir: /** @type {string} */ (configDir), verdictFile: "/v/verdict.json", standing: "DO THE MINIMAL THING." });
    const prompt = "do the pi thing";
    const { spawnAgent } = spawnCtx();
    const launchPromise = spawnAgent({
      agent: { defaults: { bin: "pi" }, buildArgs: ({ prompt: p }) => buildPiArgs({ prompt: p }), createParser: pi.createParser },
      prompt,
      cwd: workDir,
      logPath: path.join(root, "run.log"),
      verdictFile,
      env: { PI_MODEL: "must-not-cross", ANTHROPIC_API_KEY: "must-not-cross", GITHUB_TOKEN: "tracker-token-must-not-cross" },
      sandboxed: { ref: "9", stepId: "code", step: {}, mounts: [], files: own.files, env: own.env, args: own.args },
      executor,
    });

    // While the run is in flight: the per-run dir holds the contract + standing files.
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(path.join(workDir, "started")) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    assert.ok(fs.existsSync(path.join(workDir, "started")), "the fake pi binary never started");
    assert.ok(fs.existsSync(/** @type {string} */ (configDir)), "the per-run dir must exist while the agent runs");
    const contract = fs.readFileSync(path.join(/** @type {string} */ (configDir), "agenthook-unattended.md"), "utf8");
    assert.ok(contract.includes("$AGENTHOOK_VERDICT_FILE"), "the contract must name the verdict file");
    assert.equal(fs.readFileSync(path.join(/** @type {string} */ (configDir), "agenthook-standing.md"), "utf8"), "DO THE MINIMAL THING.");

    fs.writeFileSync(goFile, "");
    const result = await launchPromise;
    assert.equal(result.code, 0, JSON.stringify(result));

    // Usage/turns/context/compactions come off the worker's own stdout through createPiParser,
    // exactly like a local pi run: two assistant message_ends = 2 turns (per-turn usage summed,
    // context = input + cacheRead + cacheWrite), the compaction's spend added but not a turn.
    assert.equal(result.turnStats?.turns, 2, JSON.stringify(result.turnStats));
    assert.equal(result.turnStats?.firstContext, 135, "turn 1: 120 input + 10 cacheRead + 5 cacheWrite");
    assert.equal(result.turnStats?.peakContext, 135, "turn 2's context (90) never exceeds turn 1's");
    assert.equal(result.turnStats?.lastContext, 90, "turn 2: 70 input + 20 cacheRead + 0 cacheWrite");
    assert.equal(result.turnStats?.compactions, 1);
    assert.equal(result.result?.session_id, "sess-pi-1");
    const t = result.result?.tokens;
    assert.deepEqual(
      t && { input: t.input, output: t.output, cacheRead: t.cacheRead, cacheCreate: t.cacheCreate },
      { input: 240, output: 90, cacheRead: 30, cacheCreate: 5 },
      "the usage tally must carry the worker JSONL's numbers (turns + compaction spend), same as a local pi run",
    );

    const argvText = fs.readFileSync(path.join(workDir, "argv.txt"), "utf8");
    const argv = argvText.trim().split("\n");
    const promptIdx = argv.indexOf(prompt);
    assert.equal(promptIdx, -1, "the prompt must never reach the worker's own argv");
    const sep = argv.lastIndexOf("--");
    assert.notEqual(sep, -1, "the argv must end in the -- separator (prompt went over stdin)");
    assert.equal(argv[sep + 1], undefined, "nothing may follow --");
    const contractFlag = argv.indexOf(`${configDir}/agenthook-unattended.md`);
    const standingFlag = argv.indexOf(`${configDir}/agenthook-standing.md`);
    assert.equal(argv[contractFlag - 1], "--append-system-prompt", `argv: ${JSON.stringify(argv)}`);
    assert.equal(argv[standingFlag - 1], "--append-system-prompt", `argv: ${JSON.stringify(argv)}`);
    assert.ok(contractFlag > 0 && contractFlag < sep, "the contract flag must sit before the -- separator");
    assert.deepEqual(argv.slice(0, 4), ["-p", "--mode", "json", "--offline"], `argv head: ${JSON.stringify(argv)}`);

    const stdin = fs.readFileSync(path.join(workDir, "stdin.txt"), "utf8");
    assert.equal(stdin, prompt, "the prompt must arrive on the agent's own stdin");

    const env = fs.readFileSync(path.join(workDir, "env.txt"), "utf8");
    assert.match(env, /^PI_OFFLINE=1$/m, "the hook's PI_OFFLINE must cross");
    assert.match(env, /^AGENTHOOK_VERDICT_FILE=/m, "the AGENTHOOK_* keys must cross");
    assert.ok(!env.includes("PI_MODEL"), "a hub/harness PI_* value unrelated to the hook's return must never cross");
    assert.ok(!env.includes("ANTHROPIC_API_KEY"), "ANTHROPIC_* must never cross");
    assert.ok(!env.includes("GITHUB_TOKEN"), "tracker tokens must never cross");
    // ...and neither the worker's own argv nor the framed ssh calls may carry the values at all
    // (not just the agent-visible env): the allowlist is the only thing that crossed.
    assert.ok(!argvText.includes("must-not-cross"), `the hub-side secret values must not appear in the worker argv: ${argvText}`);
    assert.ok(!JSON.stringify(ssh.record()).includes("must-not-cross"), "the hub-side secret values must not appear in any ssh call (argv or framed env)");

    assert.ok(fs.existsSync(hubVerdictFile), "the verdict must be copied back to the hub");
    assert.deepEqual(JSON.parse(fs.readFileSync(hubVerdictFile, "utf8")), { outcome: "advance", reason: "ok" });

    assert.ok(!fs.existsSync(/** @type {string} */ (configDir)), "the per-run dir must be removed after a clean exit");
  } finally {
    ssh.restore();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --- a maxMs timeout also removes the per-run dir ---

test("ssh executor + pi.remote: a maxMs timeout still removes the per-run dir and reports timedOut", async () => {
  const ssh = withFakeSsh();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ah-ssh-pi-timeout-"));
  const workDir = path.join(root, "work");
  fs.mkdirSync(workDir, { recursive: true });
  try {
    const pidFile = path.join(root, "agent.pid");
    const agentScript = path.join(workDir, "sleepy-pi.sh");
    fs.writeFileSync(
      agentScript,
      [`#!/bin/sh`, `echo "$$" > ${shQuote(pidFile)}`, `trap '' TERM`, `cat > /dev/null`, `sleep 30`].join("\n"),
      { mode: 0o755 },
    );
    const remote = { host: "worker.test", workDir, bin: agentScript };
    const executor = createSshExecutor({ stateKey: "p", remote, spawnPaths: { sandboxVerdictPathFor: () => path.join(root, "hub-verdict.json") } });
    const { verdictFile, configDir } = executor.paths({ stepId: "code", ref: "9" });
    const own = pi.remote({ cfg: /** @type {any} */ ({}), step: /** @type {any} */ ({ id: "code" }), dir: /** @type {string} */ (configDir), verdictFile });
    const { spawnAgent } = spawnCtx({ killGraceMs: 300 });
    const promise = spawnAgent({
      agent: { defaults: { bin: "pi" }, buildArgs: ({ prompt }) => buildPiArgs({ prompt }), createParser: pi.createParser },
      prompt: "do the pi thing",
      cwd: workDir,
      logPath: path.join(root, "run.log"),
      verdictFile,
      maxMs: 1000,
      idleMs: 60_000,
      sandboxed: { ref: "9", stepId: "code", step: {}, mounts: [], files: own.files, env: own.env, args: own.args },
      executor,
    });
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(pidFile) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    assert.ok(fs.existsSync(pidFile), "the agent never started");
    assert.ok(fs.existsSync(/** @type {string} */ (configDir)), "the per-run dir must exist while the agent runs");
    const result = await promise;
    assert.equal(result.timedOut, "max", JSON.stringify(result));
    assert.ok(!fs.existsSync(/** @type {string} */ (configDir)), "the per-run dir must be removed after a timeout, same as a clean exit or a kill");
  } finally {
    ssh.restore();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --- doctor: remoteHarnessChecks resolves the harness's own agent and knows pi's install hint ---

/** shQuote's inverse (src/dispatch/executor-ssh.js), for reading back the probe script a
 * remoteHarnessChecks call sent as the last element of its ssh argv. */
function unshQuote(q) {
  return q.slice(1, -1).replace(/'\\''/g, "'");
}

/** A fake `io.run` for remoteHarnessChecks: routes each probe script to the matching override
 * (default: succeeds with no output). */
function fakeRemoteRun(overrides = {}) {
  return async (bin, args) => {
    assert.equal(bin, "ssh");
    const script = unshQuote(args.at(-1));
    if (script === "true") return overrides.reach ?? { code: 0, stdout: "", stderr: "" };
    if (script === "command -v git") return overrides.git ?? { code: 0, stdout: "", stderr: "" };
    if (script.includes("--version")) return overrides.version ?? { code: 0, stdout: "0.73.0\n", stderr: "" };
    if (script.startsWith("command -v ")) return overrides.bin ?? { code: 0, stdout: "", stderr: "" };
    if (script.startsWith("mkdir -p") && script.includes("test -w")) return overrides.workDir ?? { code: 0, stdout: "", stderr: "" };
    if (script.includes("ANTHROPIC_API_KEY")) throw new Error("the claude credential probe must not run for a pi harness");
    throw new Error(`unexpected probe script: ${script}`);
  };
}

test("remoteHarnessChecks: a pi harness probes the pi bin (not claude), reports its version, and never runs the claude credential probe", async () => {
  const cfg = /** @type {any} */ ({ harnesses: { worker: { agent: "pi", remote: { host: "h", workDir: "/w" } } } });
  const checks = await remoteHarnessChecks(cfg, { run: fakeRemoteRun({ version: { code: 0, stdout: "0.73.0\n", stderr: "" } }) });
  const binCheck = checks.find((c) => c.label.includes("has agent bin"));
  assert.ok(binCheck, JSON.stringify(checks));
  assert.match(binCheck.label, /"pi"/);
  assert.equal(binCheck.ok, true);
  assert.match(binCheck.note, /0\.73\.0/);
  assert.ok(!checks.some((c) => c.label.includes("credentials")), "no credential check for a pi harness");
});

test("remoteHarnessChecks: a missing pi bin on a pi harness is a ✗ with the pi install hint", async () => {
  const cfg = /** @type {any} */ ({ harnesses: { worker: { agent: "pi", remote: { host: "h", workDir: "/w" } } } });
  const checks = await remoteHarnessChecks(cfg, { run: fakeRemoteRun({ bin: { code: 1, stdout: "", stderr: "" } }) });
  const binCheck = checks.find((c) => c.label.includes("has agent bin"));
  assert.ok(binCheck, JSON.stringify(checks));
  assert.equal(binCheck.ok, false);
  assert.match(binCheck.fix?.manual ?? "", /npm i -g @earendil-works\/pi-coding-agent/, JSON.stringify(binCheck));
});
