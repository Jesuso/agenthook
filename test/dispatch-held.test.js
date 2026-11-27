import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// Dispatch — held-state lifecycle (the `@agent` resume), provider/maxMs passthrough, step
// allow/deny policy (#475), and per-step agent binary + env (#357/#470). Harnesses live in
// test/_dispatch-helpers.js.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createDispatcher, NO_VALID_VERDICT } from "../src/dispatch.js";
import { createStore } from "../src/store/index.js";
import { tmpDir, heldHarness } from "./_dispatch-helpers.js";

// --- held-state lifecycle (the `@agent` resume) through the real dispatcher ---
// A fake `claude` (a tiny sh script, no network) writes $FAKE_VERDICT to the verdict
// file and records the prompt it was handed, so runClaude runs end to end.
// --- provider/maxMs passthrough: step.provider ?? cfg.agentProvider and maxMs reach buildArgs ---

test("runStep passes step.provider (over cfg.agentProvider) and maxMs through to buildArgs", async () => {
  const dir = tmpDir();
  const bin = path.join(dir, "fake-hermes.sh");
  const argvOut = path.join(dir, "argv.txt");
  fs.writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$@" > "${argvOut}"\nprintf '%s' "$FAKE_VERDICT" > "$AGENTHOOK_VERDICT_FILE"\n`, { mode: 0o755 });
  const cfg = /** @type {any} */ ({
    pipeline: [{ id: "code", agent: "hermes", bin, provider: "ollama-launch", maxMinutes: 2, isolated: false }],
    agent: "hermes",
    agentProvider: "openai-codex",
    claudeBin: bin,
    repoPath: dir,
    worktreePrefix: path.join(dir, "wt"),
    dataDir: dir,
    logDir: dir,
    instructionsFile: path.join(dir, "none.md"),
  });
  const store = createStore(dir);
  const adapter = /** @type {any} */ ({
    describe: () => ({ platform: "GitHub", taskNoun: "issue", trigger: "@agent", commentHowTo: "comment" }),
    fetchTask: async (/** @type {string} */ ref) => ({ ref, name: "t", description: "d", url: "u", completed: false, assignedToUs: true }),
    advance: async () => {},
  });
  const run = createDispatcher(cfg, adapter, undefined, store, () => {});
  process.env.FAKE_VERDICT = JSON.stringify({ outcome: "advance" });
  const log = console.log;
  console.log = () => {};
  try {
    await run({ kind: "pipeline", ref: "42", stepId: "code", dedupKey: "k:code" });
  } finally {
    console.log = log;
  }
  const argv = fs.readFileSync(argvOut, "utf8").trim().split("\n");
  assert.ok(argv.includes("--provider"), argv.join(" "));
  assert.equal(argv[argv.indexOf("--provider") + 1], "ollama-launch"); // step.provider wins over cfg.agentProvider
  assert.ok(argv.includes("--run-budget"), argv.join(" "));
  assert.equal(argv[argv.indexOf("--run-budget") + 1], "120"); // maxMinutes: 2 -> 120s
});

test("runStep falls back to cfg.agentProvider when the step sets no provider", async () => {
  const dir = tmpDir();
  const bin = path.join(dir, "fake-hermes.sh");
  const argvOut = path.join(dir, "argv.txt");
  fs.writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$@" > "${argvOut}"\nprintf '%s' "$FAKE_VERDICT" > "$AGENTHOOK_VERDICT_FILE"\n`, { mode: 0o755 });
  const cfg = /** @type {any} */ ({
    pipeline: [{ id: "code", agent: "hermes", bin, isolated: false }],
    agent: "hermes",
    agentProvider: "openai-codex",
    claudeBin: bin,
    repoPath: dir,
    worktreePrefix: path.join(dir, "wt"),
    dataDir: dir,
    logDir: dir,
    instructionsFile: path.join(dir, "none.md"),
  });
  const store = createStore(dir);
  const adapter = /** @type {any} */ ({
    describe: () => ({ platform: "GitHub", taskNoun: "issue", trigger: "@agent", commentHowTo: "comment" }),
    fetchTask: async (/** @type {string} */ ref) => ({ ref, name: "t", description: "d", url: "u", completed: false, assignedToUs: true }),
    advance: async () => {},
  });
  const run = createDispatcher(cfg, adapter, undefined, store, () => {});
  process.env.FAKE_VERDICT = JSON.stringify({ outcome: "advance" });
  const log = console.log;
  console.log = () => {};
  try {
    await run({ kind: "pipeline", ref: "42", stepId: "code", dedupKey: "k:code" });
  } finally {
    console.log = log;
  }
  const argv = fs.readFileSync(argvOut, "utf8").trim().split("\n");
  assert.equal(argv[argv.indexOf("--provider") + 1], "openai-codex");
});

// --- step allow/deny policy (#475): refused on an agent that can't enforce it, flags on claude ---

/** Run one `code` step with an argv-recording fake as every agent's bin. @param {any} step */
async function policyRun(step) {
  const dir = tmpDir();
  const bin = path.join(dir, "fake-agent.sh");
  const argvOut = path.join(dir, "argv.txt");
  const cwdOut = path.join(dir, "cwd.txt");
  fs.writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$@" > "${argvOut}"\npwd > "${cwdOut}"\nprintf '%s' "$FAKE_VERDICT" > "$AGENTHOOK_VERDICT_FILE"\n`, { mode: 0o755 });
  const cfg = /** @type {any} */ ({
    pipeline: [{ id: "code", bin, ...step }, { id: "done", manual: true }],
    agentEnvPassthrough: ["FAKE_*"],
    claudeBin: bin,
    repoPath: dir,
    worktreePrefix: path.join(dir, "wt"),
    dataDir: dir,
    logDir: dir,
    instructionsFile: path.join(dir, "none.md"),
  });
  /** @type {any[]} */
  const advanced = [];
  const adapter = /** @type {any} */ ({
    describe: () => ({ platform: "GitHub", taskNoun: "issue", trigger: "@agent", commentHowTo: "comment" }),
    fetchTask: async (/** @type {string} */ ref) => ({ ref, name: "t", description: "d", url: "u", completed: false, assignedToUs: true }),
    advance: async (/** @type {string} */ _ref, /** @type {string} */ _step, /** @type {any} */ verdict) => advanced.push(verdict),
  });
  const run = createDispatcher(cfg, adapter, undefined, createStore(dir), () => {});
  process.env.FAKE_VERDICT = JSON.stringify({ outcome: "advance" });
  const log = console.log;
  console.log = () => {};
  try {
    await run({ kind: "pipeline", ref: "42", stepId: "code", dedupKey: "k:code" });
  } finally {
    console.log = log;
  }
  const argv = fs.existsSync(argvOut) ? fs.readFileSync(argvOut, "utf8").trim().split("\n") : null;
  const cwd = fs.existsSync(cwdOut) ? fs.readFileSync(cwdOut, "utf8").trim() : null;
  return { advanced, argv, cwd };
}

test("dispatch: a step allow/deny policy on an agent that can't enforce it is refused, nothing spawned", async () => {
  for (const agent of ["cursor", "opencode", "pi"]) {
    const { advanced, argv } = await policyRun({ agent, allow: { commands: ["git"] } });
    assert.equal(argv, null, `${agent} was spawned`);
    assert.equal(advanced[0]?.outcome, "fail");
    assert.match(advanced[0].reason, new RegExp(`${agent} cannot enforce step "code" allow policy — the run is refused rather than run unrestricted`));
  }
  const { advanced, argv } = await policyRun({ agent: "cursor", deny: { commands: ["curl"] } });
  assert.equal(argv, null);
  assert.match(advanced[0].reason, /cursor cannot enforce step "code" deny policy/);
});

test("dispatch: a claude step with allow spawns with dontAsk and an Edit rule for its verdict file", async () => {
  const { advanced, argv } = await policyRun({ allow: { commands: ["git"], paths: ["src/**"] } });
  assert.ok(argv, "claude was not spawned");
  assert.equal(advanced[0]?.outcome, "advance");
  assert.equal(argv[argv.indexOf("--permission-mode") + 1], "dontAsk");
  assert.ok(!argv.includes("--dangerously-skip-permissions"));
  assert.ok(argv.some((a) => /^Edit\(\/\/.*\/verdicts\/42-code\.json\)$/.test(a)), argv.join(" "));
});

test("dispatch: a fullAuto:false claude step without a policy runs pinned — dontAsk, user+project settings, verdict writable, settings files not (#476)", async () => {
  const { advanced, argv, cwd } = await policyRun({});
  assert.ok(argv, "claude was not spawned");
  assert.equal(advanced[0]?.outcome, "advance");
  assert.equal(argv[argv.indexOf("--setting-sources") + 1], "user,project");
  assert.equal(argv[argv.indexOf("--permission-mode") + 1], "dontAsk");
  assert.ok(!argv.includes("--dangerously-skip-permissions"));
  assert.ok(argv.some((a) => /^Edit\(\/\/.*\/verdicts\/42-code\.json\)$/.test(a)), argv.join(" "));
  assert.ok(argv.includes(`Edit(/${fs.realpathSync(String(cwd))}/.claude/settings.local.json)`) || argv.includes(`Edit(/${cwd}/.claude/settings.local.json)`), argv.join(" "));
});

test("dispatch: a hold verdict writes held.json[ref]; the next run of any step clears it", async () => {
  const { store, runStep } = heldHarness();
  await runStep("triage", { outcome: "hold", reason: "which DB?" });
  const held = store.getHeld("42");
  assert.equal(held?.stepId, "triage");
  assert.equal(held?.reason, "which DB?");
  assert.ok(held?.heldAt);

  // the owner's reply resumes triage: the comment reaches the prompt, and the hold is consumed
  const prompt = await runStep("triage", { outcome: "advance" }, "@agent use Postgres");
  assert.match(prompt, /=== HUMAN REPLY \(resume\) ===[\s\S]*@agent use Postgres/);
  assert.equal(store.getHeld("42"), undefined);

  // a different step re-entering (e.g. a manual drag-back) also consumes it
  await runStep("triage", { outcome: "hold" });
  assert.equal(store.getHeld("42")?.stepId, "triage");
  const plain = await runStep("code", { outcome: "advance" });
  assert.ok(!plain.includes("HUMAN REPLY"), "no reply section without job.comment");
  assert.equal(store.getHeld("42"), undefined);
});

test("dispatch: cfg.language reaches the step prompt via ctx.language", async () => {
  const { runStep } = heldHarness({ cfg: { language: "es" } });
  const prompt = await runStep("code", { outcome: "advance" });
  assert.match(prompt, /Write all human-facing text[\s\S]*"es"/);
});

test("dispatch: a new agent run drops a learned refmeta.prState (a re-run's finish is ready again)", async () => {
  const { store, runStep } = heldHarness();
  store.setRefMeta("42", { pr: 7, prState: "closed" });
  await runStep("code", { outcome: "advance" });
  const meta = store.getRefMeta("42");
  assert.equal(meta?.pr, 7, "the PR number stays");
  assert.equal(meta?.prState, undefined, "the stale closed state no longer overrides the next pipeline_done");
});

test("dispatch: a held ref that later fails ends with no held record", async () => {
  const { store, runStep } = heldHarness();
  await runStep("triage", { outcome: "hold" });
  assert.equal(store.getHeld("42")?.stepId, "triage");
  await runStep("triage", { outcome: "fail" }, "@agent try again");
  assert.equal(store.getHeld("42"), undefined);
});

// --- per-step agent binary + env (#357) ---
// A fake bin that records which binary ran, its argv[1], a step-only variable, the
// verdict-file path and a few receiver variables (#470's allowlist), then writes
// $FAKE_VERDICT like the shared fake.

/** @param {string} dir @param {string} name */
function envDumpBin(dir, name) {
  const bin = path.join(dir, name);
  const out = `${bin}.out`;
  fs.writeFileSync(
    bin,
    `#!/bin/sh\nprintf 'bin=%s\\nargv1=%s\\nSTEP_ONLY=%s\\nVF=%s\\nSOME_SECRET=%s\\nPATH=%s\\nGITHUB_TOKEN=%s\\n' "$0" "$1" "\${STEP_ONLY-unset}" "$AGENTHOOK_VERDICT_FILE" "\${SOME_SECRET-unset}" "\${PATH-unset}" "\${GITHUB_TOKEN-unset}" > "${out}"\nprintf '%s' "$FAKE_VERDICT" > "$AGENTHOOK_VERDICT_FILE"\n`,
    { mode: 0o755 },
  );
  const read = () => Object.fromEntries(fs.readFileSync(out, "utf8").trim().split("\n").map((l) => /** @type {[string, string]} */ (l.split(/=(.*)/s).slice(0, 2))));
  return { bin, read };
}

test("dispatch: a step without bin/env spawns cfg.claudeBin with the allowlisted env + the verdict file", async () => {
  const h = heldHarness({ steps: [{ id: "code" }, { id: "done", manual: true }] });
  const fake = envDumpBin(h.dir, "fake-claude.sh"); // overwrite cfg.claudeBin with the env dumper
  delete process.env.STEP_ONLY;
  const saved = { SOME_SECRET: process.env.SOME_SECRET, GITHUB_TOKEN: process.env.GITHUB_TOKEN };
  Object.assign(process.env, { SOME_SECRET: "x", GITHUB_TOKEN: "gh-x" });
  try {
    await h.runStep("code", { outcome: "advance" }, undefined, { prompt: false });
  } finally {
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
  const got = fake.read();
  assert.equal(got.bin, fake.bin);
  assert.equal(got.argv1, "-p");
  assert.equal(got.STEP_ONLY, "unset");
  assert.match(got.VF, /code\.json$/);
  assert.equal(got.SOME_SECRET, "unset", "a receiver secret is stripped");
  assert.equal(got.GITHUB_TOKEN, "unset", "a tracker that names no env var passes none");
  assert.notEqual(got.PATH, "unset", "PATH is in the base allowlist");
  assert.deepEqual(h.advanced, [["42", "code", "advance"]]);
});

test("dispatch: the tracker's agentEnv and the operator's agentEnvPassthrough reach the child (#470)", async () => {
  const saved = { SOME_SECRET: process.env.SOME_SECRET, GITHUB_TOKEN: process.env.GITHUB_TOKEN };
  Object.assign(process.env, { SOME_SECRET: "x", GITHUB_TOKEN: "gh-x" });
  try {
    const h = heldHarness({ steps: [{ id: "code" }, { id: "done", manual: true }], meta: { agentEnv: ["GITHUB_TOKEN"] } });
    const fake = envDumpBin(h.dir, "fake-claude.sh");
    await h.runStep("code", { outcome: "advance" }, undefined, { prompt: false });
    let got = fake.read();
    assert.equal(got.GITHUB_TOKEN, "gh-x", "the tracker prompt's token passes");
    assert.equal(got.SOME_SECRET, "unset");

    const h2 = heldHarness({ steps: [{ id: "code" }, { id: "done", manual: true }], cfg: { agentEnvPassthrough: ["FAKE_*", "SOME_SECRET"] } });
    const fake2 = envDumpBin(h2.dir, "fake-claude.sh");
    await h2.runStep("code", { outcome: "advance" }, undefined, { prompt: false });
    got = fake2.read();
    assert.equal(got.SOME_SECRET, "x", "agentEnvPassthrough widens the allowlist");
    assert.equal(got.GITHUB_TOKEN, "unset");
    assert.deepEqual(h2.advanced, [["42", "code", "advance"]]);
  } finally {
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
});

test("dispatch: a step's bin is spawned, its env reaches the child, the verdict file still wins", async () => {
  const dir = tmpDir();
  const fake = envDumpBin(dir, "claude-local.sh");
  // AGENTHOOK_VERDICT_FILE is rejected by config validation; dispatch must still override it
  const env = { STEP_ONLY: "yes", AGENTHOOK_VERDICT_FILE: path.join(dir, "hijack.json") };
  const h = heldHarness({ steps: [{ id: "code", bin: fake.bin, env }, { id: "done", manual: true }] });
  delete process.env.STEP_ONLY;
  await h.runStep("code", { outcome: "advance" }, undefined, { prompt: false });
  const got = fake.read();
  assert.equal(got.bin, fake.bin);
  assert.equal(got.argv1, "-p");
  assert.equal(got.STEP_ONLY, "yes");
  assert.match(got.VF, /code\.json$/, "the receiver's verdict file, not the step's");
  assert.equal(fs.existsSync(env.AGENTHOOK_VERDICT_FILE), false);
  assert.equal(process.env.STEP_ONLY, undefined, "step env never leaks into the receiver");
  assert.deepEqual(h.advanced, [["42", "code", "advance"]]);
});

