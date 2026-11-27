import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// Remote harness phase 3 pi rework (#827): the pieces test/dispatch-executor-ssh-pi.test.js leaves
// out — a dispatch-level (createDispatcher) run proving the #731 standing dedupe reaches the
// worker's stdin AND that a step's piConfigDir never crosses to the worker, the raw-launched gate
// (#710) on a pi harness (runs verbatim, writes no per-run files), a verdict-repair RESUME turn
// (resumePiArgs `--session <sid>`) finding the per-run dir and keeping both
// `--append-system-prompt` flags, and teardown (kill, reap()).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { withFakeSsh, spawnCtx, initGitRepo } from "./_ssh-helpers.js";
import { createSshExecutor, shQuote } from "../src/dispatch/executor-ssh.js";
import { pi, buildPiArgs } from "../src/agents/pi.js";
import { createDispatcher } from "../src/dispatch.js";
import { createStore } from "../src/store/index.js";
import { promptPathFor } from "../src/dispatch/prompt.js";

// --- dispatch-level: #731 dedupe on the worker's stdin, piConfigDir never crossing ---

test("dispatch: a remote pi run with standing instructions dedupes the worker's stdin to TICKET + ticket, a step piConfigDir is ignored (warn), and the per-run dir is gone after the run", async () => {
  const ssh = withFakeSsh();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ah-ssh-pi-standing-"));
  const workDir = path.join(root, "work");
  const repoPath = path.join(root, "repo");
  const piConfigDir = path.join(root, "hub-pi-config");
  fs.mkdirSync(workDir, { recursive: true });
  initGitRepo(repoPath);
  fs.mkdirSync(piConfigDir, { recursive: true });
  fs.writeFileSync(path.join(piConfigDir, "models.json"), JSON.stringify({ providers: { marker: { models: [] } }, PROVIDER_MARKER: "MUST-NOT-CROSS" }));
  try {
    const agentScript = path.join(workDir, "pi.sh");
    fs.writeFileSync(
      agentScript,
      [
        `#!/bin/sh`,
        `printf '%s\\n' "$@" > "${workDir}/argv.txt"`,
        `cat > "${workDir}/stdin.txt"`,
        `mkdir -p "$(dirname "$AGENTHOOK_VERDICT_FILE")"`,
        `echo '{"outcome":"advance","reason":"ok"}' > "$AGENTHOOK_VERDICT_FILE"`,
        `exit 0`,
      ].join("\n"),
      { mode: 0o755 },
    );
    const instructionsFile = path.join(root, "standing.md");
    fs.writeFileSync(instructionsFile, "STANDING-MARKER: do the minimal change.\n");
    const cfg = /** @type {any} */ ({
      pipeline: [{ id: "code", harness: "worker", piConfigDir }],
      harnesses: { worker: { agent: "pi", remote: { host: "worker.test", workDir, bin: agentScript } } },
      repoPath,
      stateKey: "p",
      stateDir: root,
      dataDir: root,
      logDir: root,
      instructionsFile,
    });
    const store = createStore(root);
    const adapter = /** @type {any} */ ({
      describe: () => ({ platform: "GitHub", taskNoun: "issue", trigger: "@agent", commentHowTo: "comment" }),
      fetchTask: async (ref) => ({ ref, name: "t", description: "d", url: "https://example.test/1", completed: false, assignedToUs: true }),
      advance: async () => {},
    });
    const run = createDispatcher(cfg, adapter, undefined, store, () => {}, null, undefined, { killGraceMs: 300 });
    const l = console.log;
    const w = console.warn;
    const warns = [];
    console.log = () => {};
    console.warn = (m) => warns.push(String(m));
    let result;
    try {
      result = await run({ kind: "pipeline", ref: "78", stepId: "code", dedupKey: "k:78", harness: "worker" });
    } finally {
      console.log = l;
      console.warn = w;
    }
    assert.equal(result.code, 0, JSON.stringify(result));
    assert.ok(warns.some((m) => m.includes(`piConfigDir ${piConfigDir}`) && m.includes("ignored on a remote worker")), JSON.stringify(warns));

    const logFile = fs.readdirSync(root).find((f) => f.endsWith("-78.log"));
    assert.ok(logFile, "no log file for the run");
    const sidecar = fs.readFileSync(promptPathFor(path.join(root, logFile)), "utf8");
    const ticket = sidecar.split("=== TICKET ===\n\n")[1];
    assert.ok(ticket, "the sidecar must keep the undeduped standing + marker + ticket form");
    const stdin = fs.readFileSync(path.join(workDir, "stdin.txt"), "utf8");
    assert.equal(stdin, `=== TICKET ===\n\n${ticket}`, "the worker agent's stdin must be deduped to the marker + ticket only");
    assert.ok(!stdin.includes("STANDING-MARKER"), "the standing text itself must not be sent twice — it is the --append-system-prompt file");

    const argv = fs.readFileSync(path.join(workDir, "argv.txt"), "utf8");
    assert.ok(!argv.includes("STANDING-MARKER"), "the standing text must never reach argv — only the file paths do");
    assert.ok(!argv.includes(piConfigDir), "the hub's piConfigDir path must never reach the worker's argv");
    assert.ok(!argv.includes("PROVIDER_MARKER"), "the hub's piConfigDir content must never cross to the worker");
    const allArgv = JSON.stringify(ssh.record());
    assert.ok(!allArgv.includes("PROVIDER_MARKER"), "the piConfigDir content must never reach the ssh argv either");
    assert.ok(!fs.existsSync(path.join(workDir, ".agenthook", "p", "runs", "78-code.opencode")), "the per-run dir must be removed after a clean exit");
  } finally {
    ssh.restore();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --- the raw-launched gate (#710) on a pi harness: runs verbatim, writes no per-run files ---

test("dispatch: a remote pi step's gate runs via a raw launch, passes, and the agent's own verdict survives — the gate wrote no per-run files of its own", async () => {
  const ssh = withFakeSsh();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ah-ssh-pi-gate-"));
  const workDir = path.join(root, "work");
  const repoPath = path.join(root, "repo");
  fs.mkdirSync(workDir, { recursive: true });
  initGitRepo(repoPath);
  const gateStandingFile = path.join(root, "standing.md");
  fs.writeFileSync(gateStandingFile, "GATE-STANDING-MARKER: do the minimal change.\n");
  try {
    const agentScript = path.join(workDir, "pi.sh");
    const agentArgvFile = path.join(root, "agent-argv.txt");
    const runsDir = path.join(workDir, ".agenthook", "p", "runs");
    const gateSnapshot = path.join(root, "gate-runs-snapshot.txt");
    const scriptBody = [
      "#!/bin/sh",
      `printf '%s\\n' "$@" > ${shQuote(agentArgvFile)}`,
      "cat > /dev/null",
      'mkdir -p "$(dirname "$AGENTHOOK_VERDICT_FILE")"',
      'echo \'{"outcome":"advance","reason":"the agent itself thinks it succeeded"}\' > "$AGENTHOOK_VERDICT_FILE"',
      "exit 0",
      "",
    ].join("\n");
    fs.writeFileSync(agentScript, scriptBody, { mode: 0o755 });
    const cfg = /** @type {any} */ ({
      pipeline: [
        // The gate command snapshots the worker's per-run dir WHILE the gate is running: a
        // raw launch that (buggily) created or wrote the per-run dir would show a
        // `*-code.opencode` entry in that listing, which a leftover check after the run
        // could never show (the agent's own run removes the dir either way).
        { id: "code", harness: "worker", createsWorktree: true, sourceLabel: "src:code", successLabel: "src:review", verdictRepairs: 0, gate: `ls -A ${shQuote(runsDir)} > ${shQuote(gateSnapshot)}`, gateTimeoutMinutes: 1 },
        { id: "review", sourceLabel: "src:review" },
      ],
      repoPath,
      worktreePrefix: path.join(root, "wt"),
      stateKey: "p",
      stateDir: root,
      dataDir: root,
      logDir: root,
      instructionsFile: gateStandingFile,
      harnesses: { worker: { agent: "pi", remote: { host: "worker.test", workDir, bin: agentScript } } },
    });
    const store = createStore(root);
    /** @type {any[]} */
    const advanced = [];
    const events = [];
    const adapter = /** @type {any} */ ({
      describe: () => ({
        platform: "GitHub",
        taskNoun: "issue",
        trigger: "@agent",
        commentHowTo: "comment",
        stageKeys: { source: "sourceLabel", success: "successLabel", failure: "failLabel", hold: "holdLabel", queue: "queueLabel" },
      }),
      fetchTask: async (ref) => ({ ref, name: "t", description: "d", url: "https://example.test/1", completed: false, assignedToUs: true }),
      advance: async (ref, stepId, verdict) => advanced.push({ ref, stepId, ...verdict }),
    });
    const run = createDispatcher(cfg, adapter, undefined, store, (event, ref, step, extra) => events.push({ event, ref, step, ...extra }));
    const l = console.log;
    console.log = () => {};
    let result;
    try {
      result = await run({ kind: "pipeline", ref: "55", stepId: "code", dedupKey: "k:code", harness: "worker" });
    } finally {
      console.log = l;
    }
    assert.equal(result.code, 0, JSON.stringify(result));
    assert.equal(advanced.length, 1, "exactly one advance — the gate must veto, not grant, and here it passes");
    assert.equal(advanced[0].outcome, "advance", `a passing raw-launched gate must not cost the agent's own verdict (got ${JSON.stringify(advanced[0])})`);
    assert.equal(advanced[0].reason, "the agent itself thinks it succeeded", "the agent's own verdict reason must survive the gate run untouched");
    assert.ok(events.some((e) => e.event === "gate_pass"), "gate_pass must have fired");
    // The agent's own run carried the pi argv shape (contract + standing flags before `--`,
    // nothing after); the gate ran RAW (no pi argv of its own, no per-run files).
    const agentArgv = fs.readFileSync(agentArgvFile, "utf8").trim().split("\n");
    assert.equal(agentArgv[agentArgv.length - 1], "--", `the agent's own argv must end at -- (prompt on stdin): ${JSON.stringify(agentArgv)}`);
    const flags = agentArgv.filter((a) => a === "--append-system-prompt");
    assert.equal(flags.length, 2, `the agent run must carry both --append-system-prompt flags: ${JSON.stringify(agentArgv)}`);
    // The gate itself executed on the worker and saw no per-run dir while it ran: its snapshot
    // (taken mid-gate, so a gate that created and cleaned up the dir would still be caught)
    // holds no `*.opencode` entry — only the gate's own launcher's pgid/pipe files.
    assert.ok(fs.existsSync(gateSnapshot), "the gate command must have run verbatim on the worker");
    const snapshot = fs.readFileSync(gateSnapshot, "utf8").trim().split("\n").filter(Boolean);
    assert.ok(!snapshot.some((f) => f.endsWith(".opencode")), `the gate's raw launch must not create the per-run dir: ${JSON.stringify(snapshot)}`);
    assert.ok(snapshot.every((f) => f.endsWith(".pgid") || f.endsWith(".pipe")), `only the gate launcher's own pgid/pipe files may be in the runs dir mid-gate: ${JSON.stringify(snapshot)}`);
    const leftovers = fs.existsSync(runsDir) ? fs.readdirSync(runsDir).filter((f) => f.endsWith(".opencode")) : [];
    assert.deepEqual(leftovers, [], `no per-run dir may be left behind after the run (got ${JSON.stringify(leftovers)})`);
  } finally {
    ssh.restore();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --- a verdict-repair RESUME turn (resumePiArgs `--session <sid>`) keeps the flags ---

test("ssh executor + pi.remote: a resume turn's argv carries --session <sid> AND both --append-system-prompt flags, and the per-run dir still exists while it runs", async () => {
  const ssh = withFakeSsh();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ah-ssh-pi-resume-"));
  const workDir = path.join(root, "work");
  fs.mkdirSync(workDir, { recursive: true });
  try {
    const goFile = path.join(workDir, "go");
    const agentScript = path.join(workDir, "pi.sh");
    fs.writeFileSync(
      agentScript,
      [
        `#!/bin/sh`,
        `printf '%s\\n' "$@" > "${workDir}/argv.txt"`,
        `cat > /dev/null`,
        `touch "${workDir}/started"`,
        `while [ ! -f ${goFile} ]; do sleep 0.02; done`,
        `mkdir -p "$(dirname "$AGENTHOOK_VERDICT_FILE")"`,
        `echo '{"outcome":"advance","reason":"ok"}' > "$AGENTHOOK_VERDICT_FILE"`,
        `exit 0`,
      ].join("\n"),
      { mode: 0o755 },
    );
    const remote = { host: "worker.test", workDir, bin: agentScript };
    const executor = createSshExecutor({ stateKey: "p", remote, spawnPaths: { sandboxVerdictPathFor: () => path.join(root, "hub-verdict.json") } });
    const { verdictFile, configDir } = executor.paths({ stepId: "code", ref: "9" });
    const own = pi.remote({ cfg: /** @type {any} */ ({}), step: /** @type {any} */ ({ id: "code" }), dir: /** @type {string} */ (configDir), verdictFile, standing: "S" });
    const { spawnAgent } = spawnCtx();
    const prompt = "try again, but write the verdict";
    const launchPromise = spawnAgent({
      agent: { defaults: { bin: "pi" }, buildArgs: ({ prompt: p }) => buildPiArgs({ prompt: p }), resumeArgs: pi.resumeArgs, createParser: pi.createParser },
      prompt,
      cwd: workDir,
      logPath: path.join(root, "run.log"),
      verdictFile,
      sandboxed: { ref: "9", stepId: "code", step: {}, mounts: [], files: own.files, env: own.env, args: own.args },
      executor,
      resumeSessionId: "sess-repair-1",
    });
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(path.join(workDir, "started")) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    assert.ok(fs.existsSync(path.join(workDir, "started")), "the fake pi binary never started");
    assert.ok(fs.existsSync(/** @type {string} */ (configDir)), "the per-run dir must exist while the resume turn runs (deterministic per ref+step)");
    assert.ok(fs.existsSync(path.join(/** @type {string} */ (configDir), "agenthook-unattended.md")), "the contract file must be rewritten for the resume turn");
    fs.writeFileSync(goFile, "");
    const result = await launchPromise;
    assert.equal(result.code, 0, JSON.stringify(result));
    const argv = fs.readFileSync(path.join(workDir, "argv.txt"), "utf8").trim().split("\n");
    const sessionIdx = argv.indexOf("sess-repair-1");
    assert.ok(sessionIdx > 0, `the --session flag must be in the worker argv: ${JSON.stringify(argv)}`);
    assert.equal(argv[sessionIdx - 1], "--session");
    assert.equal(argv[argv.indexOf(`${configDir}/agenthook-unattended.md`) - 1], "--append-system-prompt", "the contract flag must survive onto the resume turn");
    assert.equal(argv[argv.indexOf(`${configDir}/agenthook-standing.md`) - 1], "--append-system-prompt", "the standing flag must survive onto the resume turn");
    assert.equal(argv[argv.lastIndexOf("--") + 1], undefined, "nothing may follow -- on the resume turn either");
  } finally {
    ssh.restore();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --- teardown: kill and reap() remove the per-run dir ---

test("ssh executor + pi.remote: an explicit kill still removes the per-run dir", async () => {
  const ssh = withFakeSsh();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ah-ssh-pi-kill-"));
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
    const children = new Set();
    const ctx = spawnCtx({ children, killGraceMs: 300 });
    const promise = ctx.spawnAgent({
      agent: { defaults: { bin: "pi" }, buildArgs: ({ prompt }) => buildPiArgs({ prompt }), createParser: pi.createParser },
      prompt: "do the pi thing",
      cwd: workDir,
      logPath: path.join(root, "run.log"),
      verdictFile,
      sandboxed: { ref: "9", stepId: "code", step: {}, mounts: [], files: own.files, env: own.env, args: own.args },
      executor,
    });
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(pidFile) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    assert.ok(fs.existsSync(pidFile), "the agent never started");
    assert.ok(fs.existsSync(/** @type {string} */ (configDir)), "the per-run dir must exist while the agent runs");
    const [child] = children;
    assert.ok(child, "the local ssh client was never tracked");
    ctx.killNow("9", child.pid);
    await promise;
    assert.ok(!fs.existsSync(/** @type {string} */ (configDir)), "the per-run dir must be removed after an explicit kill, same as a clean exit");
  } finally {
    ssh.restore();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ssh executor reap(): removes a leftover pi per-run dir and does not report it in `runs`", async () => {
  const ssh = withFakeSsh();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-ssh-reap-pi-"));
  try {
    const remote = { host: "worker.test", workDir };
    const executor = createSshExecutor({ stateKey: "p", remote, spawnPaths: { sandboxVerdictPathFor: () => path.join(workDir, "hub.json") } });
    const configDir = path.join(workDir, ".agenthook", "p", "runs", "9-code.opencode");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "agenthook-unattended.md"), "contract\n");
    fs.writeFileSync(path.join(configDir, "agenthook-standing.md"), "standing\n");
    const reaped = await executor.reap();
    assert.deepEqual(reaped.runs, [], "a leftover config dir is never echoed into reap()'s `runs` list — that's the pgid names only");
    assert.ok(!fs.existsSync(configDir), "the leftover pi per-run dir must be removed by reap()");
  } finally {
    ssh.restore();
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});
