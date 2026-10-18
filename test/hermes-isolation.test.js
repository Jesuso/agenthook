import "./_setup.js"; // first: isolate AGENTHOOK_HOME (and HERMES_HOME) even for single-file `node --test` runs
// Hermes isolated mode (#398): the isolated home (only config.yaml copied, by hash), the
// config.yaml provider scan, the isolated argv, the adapter env + resume, the doctor lint,
// and dispatch end-to-end through a fake `hermes` script — fail-fast before spawn, and the
// HERMES_HOME the agent actually sees. Never reads or writes the real ~/.hermes: every
// source home is a temp dir (test/_setup.js points HERMES_HOME at one too).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agenthook-hermes-iso-"));
process.env.HOME = HOME;
test.after(() => fs.rmSync(HOME, { recursive: true, force: true }));

const { ensureHermesHome, hermesHomeDir, hermesSourceHome, hermesProviderInfo, hermesPreflight } = await import("../src/agents/hermes-home.js");
const { buildHermesArgs, hermes, HERMES_MAX_TURNS } = await import("../src/agents/hermes.js");
const { listSessions } = await import("../src/sessions.js");
const { resumeCommand, resumeArgs } = await import("../src/commands/resume.js");
const { hermesLints } = await import("../src/commands/doctor.js");
const { createDispatcher } = await import("../src/dispatch.js");
const { createStore } = await import("../src/store.js");

const LOCAL_YAML = `# hermes config
model:
  default: qwen3.8:27b-96k
  provider: openai-codex   # the user's cloud default
providers:
  ollama-launch:
    api: http://127.0.0.1:11434/v1
    api_key: ""
  remote-box:
    base_url: "https://gpu.example.com/v1"
toolsets:
  - terminal
  - done_bell
`;

const CLOUD_ONLY_YAML = `model:
  provider: openai-codex
  default: gpt-5
`;

const CANNED_CLOUD = "hermes step is isolated and has no credentials; use a local provider or set isolated:false";

/** A fresh temp dir. @param {string} tag */
const tmp = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `agenthook-hermes-${tag}-`));

/** A fake source home with config.yaml plus the files an isolated home must never get.
 * @param {string} [yaml] */
function fakeSource(yaml = LOCAL_YAML) {
  const src = tmp("src");
  fs.writeFileSync(path.join(src, "config.yaml"), yaml);
  fs.writeFileSync(path.join(src, "auth.json"), '{"token":"secret"}');
  fs.writeFileSync(path.join(src, ".env"), "OPENAI_API_KEY=sk-secret\n");
  fs.writeFileSync(path.join(src, "state.db"), "db");
  for (const d of ["memories", "skills", "sessions"]) {
    fs.mkdirSync(path.join(src, d));
    fs.writeFileSync(path.join(src, d, "x.md"), "private");
  }
  return src;
}

const mode = (/** @type {string} */ p) => fs.statSync(p).mode & 0o777;

// --- ensureHermesHome ---

test("ensureHermesHome: creates a 0700 home holding only config.yaml (0600)", () => {
  const src = fakeSource();
  const stateDir = tmp("state");
  const r = ensureHermesHome({ stateDir, sourceHome: src });
  assert.equal(r.ok, true);
  const home = hermesHomeDir(stateDir);
  assert.equal(home, path.join(stateDir, "hermes-home"));
  assert.equal(mode(home), 0o700);
  assert.deepEqual(fs.readdirSync(home), ["config.yaml"]);
  assert.equal(mode(path.join(home, "config.yaml")), 0o600);
  assert.equal(fs.readFileSync(path.join(home, "config.yaml"), "utf8"), LOCAL_YAML);
  if (r.ok) assert.equal(r.configText, LOCAL_YAML);
});

test("ensureHermesHome: re-copies after the source changes, leaves an unchanged copy alone", () => {
  const src = fakeSource();
  const stateDir = tmp("state");
  ensureHermesHome({ stateDir, sourceHome: src });
  const dest = path.join(hermesHomeDir(stateDir), "config.yaml");
  // hermes may write its own state beside the copy; it must survive a refresh
  fs.writeFileSync(path.join(hermesHomeDir(stateDir), "state.db"), "isolated");
  // a copy is written temp → rename, so a new inode = rewritten
  const ino = fs.statSync(dest).ino;
  ensureHermesHome({ stateDir, sourceHome: src });
  assert.equal(fs.statSync(dest).ino, ino, "unchanged source → not rewritten");
  fs.writeFileSync(path.join(src, "config.yaml"), CLOUD_ONLY_YAML);
  ensureHermesHome({ stateDir, sourceHome: src });
  assert.notEqual(fs.statSync(dest).ino, ino);
  assert.equal(fs.readFileSync(dest, "utf8"), CLOUD_ONLY_YAML);
  assert.equal(mode(dest), 0o600);
  assert.equal(fs.readFileSync(path.join(hermesHomeDir(stateDir), "state.db"), "utf8"), "isolated");
});

test("ensureHermesHome: a missing source config.yaml → ok:false with the user-facing reason, no throw", () => {
  const src = tmp("empty");
  const stateDir = tmp("state");
  const r = ensureHermesHome({ stateDir, sourceHome: src });
  assert.deepEqual(r, { ok: false, reason: `hermes step is isolated but ${path.join(src, "config.yaml")} is missing; create it or set isolated:false` });
  assert.equal(fs.existsSync(hermesHomeDir(stateDir)), false);
});

test("hermesSourceHome: HERMES_HOME wins, else ~/.hermes", () => {
  assert.equal(hermesSourceHome({ HERMES_HOME: "/h" }, "/home/u"), "/h");
  assert.equal(hermesSourceHome({}, "/home/u"), path.join("/home/u", ".hermes"));
});

// --- hermesProviderInfo ---

test("hermesProviderInfo: a loopback providers: entry is local; a remote entry is not", () => {
  assert.deepEqual(hermesProviderInfo(LOCAL_YAML, "ollama-launch"), { effective: "ollama-launch", local: true });
  assert.deepEqual(hermesProviderInfo(LOCAL_YAML, "remote-box"), { effective: "remote-box", local: false });
  assert.deepEqual(hermesProviderInfo("providers:\n  l:\n    base_url: http://localhost:8080\n", "l"), { effective: "l", local: true });
  assert.deepEqual(hermesProviderInfo("providers:\n  l:\n    api: 'http://[::1]:8080/v1'\n", "l"), { effective: "l", local: true });
});

test("hermesProviderInfo: the cloud default (model.provider not under providers:) is not local", () => {
  assert.deepEqual(hermesProviderInfo(LOCAL_YAML), { effective: "openai-codex", local: false });
  assert.deepEqual(hermesProviderInfo(CLOUD_ONLY_YAML), { effective: "openai-codex", local: false });
  // a custom provider whose URL sits on model.base_url
  assert.deepEqual(hermesProviderInfo("model:\n  provider: custom\n  base_url: http://127.0.0.1:1234/v1\n"), { effective: "custom", local: true });
});

test("hermesProviderInfo: garbage, flow-style or undecidable config → local:null (fail open)", () => {
  assert.equal(hermesProviderInfo("{{{ not: [yaml", "ollama-launch").local, null);
  assert.equal(hermesProviderInfo("\0\x01 binary junk\n:::", undefined).local, null);
  assert.equal(hermesProviderInfo("providers: {ollama: {api: 'http://127.0.0.1'}}\n", "ollama").local, null);
  assert.equal(hermesProviderInfo("toolsets:\n  - terminal\n").local, null, "no provider anywhere");
  assert.equal(hermesProviderInfo("providers:\n  x:\n    api_key: k\n", "x").local, null, "entry without a URL");
  assert.equal(hermesProviderInfo("", "x").local, null);
});

test("hermesPreflight: missing source, cloud provider and local provider", () => {
  const stateDir = tmp("state");
  assert.match(String(hermesPreflight({ stateDir, sourceHome: tmp("empty") })), /config\.yaml is missing; create it or set isolated:false$/);
  const src = fakeSource();
  assert.equal(hermesPreflight({ stateDir, sourceHome: src }), CANNED_CLOUD);
  assert.equal(hermesPreflight({ stateDir, sourceHome: src, provider: "ollama-launch" }), undefined);
  assert.equal(hermesPreflight({ stateDir, sourceHome: fakeSource("{{{ junk"), provider: "x" }), undefined, "undecidable → go ahead");
});

// --- argv + adapter ---

test("buildHermesArgs: isolated (default) adds --ignore-rules, --source tool, -t terminal,file", () => {
  const args = buildHermesArgs({ prompt: "hi", promptFile: "/tmp/p.md" });
  assert.deepEqual(args, ["chat", "-Q", "--max-turns", String(HERMES_MAX_TURNS), "--query-file", "/tmp/p.md", "--ignore-rules", "--source", "tool", "-t", "terminal,file"]);
  assert.deepEqual(buildHermesArgs({ prompt: "hi", promptFile: "/tmp/p.md", isolated: true, toolsets: ["a", "b"] }).slice(-2), ["-t", "a,b"]);
});

test("buildHermesArgs: isolated:false is today's argv byte-for-byte; + toolsets adds only -t", () => {
  const o = { prompt: "hi", promptFile: "/tmp/p.md", model: "m", provider: "p", effort: "high", fullAuto: true, maxMs: 60000 };
  const today = ["chat", "-Q", "--yolo", "--max-turns", String(HERMES_MAX_TURNS), "--query-file", "/tmp/p.md", "-m", "m", "--provider", "p", "--reasoning", "high", "--run-budget", "60"];
  assert.deepEqual(buildHermesArgs({ ...o, isolated: false }), today);
  assert.deepEqual(buildHermesArgs({ ...o, isolated: false, toolsets: ["terminal", "web"] }), [...today, "-t", "terminal,web"]);
});

test("hermes adapter: env = the isolated home unless isolated:false; resumes with chat --resume", () => {
  const cfg = /** @type {any} */ ({ stateDir: "/s/p", dataDir: "/s/p" });
  assert.deepEqual(hermes.env?.({ cfg, step: /** @type {any} */ ({ id: "code" }) }), { HERMES_HOME: "/s/p/hermes-home" });
  assert.equal(hermes.env?.({ cfg, step: /** @type {any} */ ({ id: "code", isolated: false }) }), undefined);
  assert.deepEqual(hermes.resumeCommand?.("sid-1"), ["chat", "--resume", "sid-1"]);
});

// --- resume ---

test("resume: a hermes session is listed from usage.jsonl and resumes with HERMES_HOME set", () => {
  const stateDir = tmp("state");
  const cfg = /** @type {any} */ ({
    repoPath: "/h/solo",
    worktreePrefix: "/h/wt",
    claudeBin: "claude",
    stateDir,
    dataDir: stateDir,
    logDir: path.join(stateDir, "logs"),
    agent: "hermes",
    pipeline: [{ id: "code" }, { id: "plain", isolated: false }, { id: "own", env: { HERMES_HOME: "/mine", TOKEN: "sk-x" } }],
  });
  const store = /** @type {any} */ ({
    getRepo: () => undefined,
    readUsage: () => [
      { ref: "7", stepId: "code", startedAt: "2026-10-18T10:00:00.000Z", sessionId: "h-1" },
      { ref: "7", stepId: "plain", startedAt: "2026-10-18T10:05:00.000Z", sessionId: "h-2" },
      { ref: "7", stepId: "own", startedAt: "2026-10-18T10:09:00.000Z", sessionId: "h-3" },
    ],
  });
  const s = listSessions(cfg, "7", store);
  assert.deepEqual(s.map((x) => [x.id, x.step, x.agent]), [["h-1", "code", "hermes"], ["h-2", "plain", "hermes"], ["h-3", "own", "hermes"]]);
  assert.deepEqual(resumeArgs(cfg, s[0]), ["chat", "--resume", "h-1"]);
  const home = path.join(stateDir, "hermes-home");
  const iso = resumeCommand(cfg, s[0], "/h/wt/7");
  assert.equal(iso.line, `cd /h/wt/7 && HERMES_HOME=${home} hermes chat --resume h-1   # code`);
  assert.deepEqual(iso.env, { HERMES_HOME: home }, "--exec spawns with it");
  assert.equal(iso.envNote, null);
  const plain = resumeCommand(cfg, s[1], "/h/wt/7");
  assert.equal(plain.line, "cd /h/wt/7 && hermes chat --resume h-2   # plain");
  assert.equal(plain.env, undefined);
  // the step's own HERMES_HOME wins and, like every step env value, is never printed
  const own = resumeCommand(cfg, s[2], "/h/wt/7");
  assert.deepEqual(own.env, { HERMES_HOME: "/mine", TOKEN: "sk-x" });
  assert.equal(own.line, "cd /h/wt/7 && hermes chat --resume h-3   # own");
  assert.match(String(own.envNote), /HERMES_HOME, TOKEN/);
});

// --- doctor ---

test("hermesLints: warns for an isolated hermes step with no source config.yaml or a non-local provider", () => {
  const cfg = /** @type {any} */ ({
    agent: "hermes",
    pipeline: [
      { id: "local", provider: "ollama-launch" },
      { id: "cloud" },
      { id: "remote", provider: "remote-box" },
      { id: "off", isolated: false },
      { id: "own", env: { HERMES_HOME: "/x" } },
      { id: "cl", agent: "claude" },
      { id: "m", manual: true },
    ],
  });
  /** @type {string[]} */
  const reads = [];
  const readFile = (/** @type {string} */ f) => (reads.push(f), LOCAL_YAML);
  const lints = hermesLints(cfg, { sourceHome: "/fake", readFile });
  assert.deepEqual(lints.map((l) => [l.level, l.label]), [
    ["warn", 'step "cloud" isolated hermes home'],
    ["warn", 'step "remote" isolated hermes home'],
  ]);
  assert.match(lints[0].note, /provider "openai-codex" is not a local providers: entry in \/fake\/config\.yaml/);
  assert.deepEqual(reads, ["/fake/config.yaml"], "read once");
  const missing = hermesLints(cfg, { sourceHome: "/fake", readFile: () => null });
  assert.equal(missing.length, 3);
  assert.match(missing[0].note, /\/fake\/config\.yaml is missing/);
  assert.deepEqual(hermesLints({ ...cfg, agentProvider: "ollama-launch" }, { sourceHome: "/fake", readFile }).map((l) => l.label), ['step "remote" isolated hermes home']);
});

// --- dispatch end-to-end through a fake hermes ---

/**
 * Run one hermes `code` step through the real dispatcher with a fake `hermes` that records
 * its argv + HERMES_HOME and writes an advance verdict.
 * @param {any} stepOver @param {{yaml?: string|null, agentProvider?: string}} [o]
 */
async function runHermes(stepOver, { yaml = LOCAL_YAML, agentProvider } = {}) {
  const dir = tmp("dispatch");
  const src = process.env.HERMES_HOME ?? "";
  fs.rmSync(path.join(src, "config.yaml"), { force: true });
  if (yaml !== null) fs.writeFileSync(path.join(src, "config.yaml"), yaml);
  const bin = path.join(dir, "fake-hermes.sh");
  const argvOut = path.join(dir, "argv.txt");
  const envOut = path.join(dir, "env.txt");
  const exportEnvOut = path.join(dir, "export-env.txt");
  const exportArgvOut = path.join(dir, "export-argv.txt");
  // dispatch's post-exit finalize (#395) re-invokes this same fake bin for `sessions
  // export`: branch on $1 so that call doesn't clobber the `chat` probe files. It dumps its
  // own HERMES_HOME (so a test can check it matches the run's) and writes a usage row to
  // the file it's given (its last argv) — unless FAKE_EXPORT_FAIL is set, to drive the
  // failure path.
  fs.writeFileSync(
    bin,
    `#!/bin/sh
if [ "$1" = "chat" ]; then
  printf '%s\\n' "$@" > "${argvOut}"
  printf '%s' "\${HERMES_HOME-<unset>}" > "${envOut}"
  if [ -z "$FAKE_NO_SESSION" ]; then
    echo "session_id: fake-1" >&2
  fi
  printf '{"outcome":"advance"}' > "$AGENTHOOK_VERDICT_FILE"
else
  printf '%s\\n' "$@" > "${exportArgvOut}"
  printf '%s' "\${HERMES_HOME-<unset>}" > "${exportEnvOut}"
  if [ -n "$FAKE_EXPORT_FAIL" ]; then
    exit 7
  fi
  for file in "$@"; do :; done
  printf '%s\\n' "\${FAKE_EXPORT_ROW:-{\\"input_tokens\\":18010,\\"output_tokens\\":1371,\\"cache_read_tokens\\":102182,\\"cache_write_tokens\\":0}}" > "$file"
fi
`,
    { mode: 0o755 },
  );
  const cfg = /** @type {any} */ ({
    pipeline: [{ id: "code", agent: "hermes", bin, ...stepOver }, { id: "done", manual: true }],
    agent: "hermes",
    ...(agentProvider ? { agentProvider } : {}),
    claudeBin: bin,
    repoPath: dir,
    worktreePrefix: path.join(dir, "wt"),
    stateDir: dir,
    dataDir: dir,
    logDir: dir,
    instructionsFile: path.join(dir, "none.md"),
  });
  const store = createStore(dir);
  /** @type {any[]} */
  const advanced = [];
  /** @type {any[]} */
  const events = [];
  const adapter = /** @type {any} */ ({
    describe: () => ({ platform: "GitHub", taskNoun: "issue", trigger: "@agent", commentHowTo: "comment" }),
    fetchTask: async (/** @type {string} */ ref) => ({ ref, name: "t", description: "d", url: "u", completed: false, assignedToUs: true }),
    advance: async (/** @type {string} */ ref, /** @type {string} */ stepId, /** @type {any} */ v) => advanced.push({ ref, stepId, ...v }),
  });
  const run = createDispatcher(cfg, adapter, undefined, store, (/** @type {any[]} */ ...e) => events.push(e));
  const log = console.log;
  console.log = () => {};
  try {
    await run({ kind: "pipeline", ref: "42", stepId: "code", dedupKey: "k:code" });
  } finally {
    console.log = log;
  }
  const read = (/** @type {string} */ f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8") : null);
  const logFile = fs.readdirSync(dir).find((f) => f.endsWith(".log"));
  return {
    dir,
    advanced,
    events,
    argv: read(argvOut)?.trim().split("\n") ?? null,
    hermesHome: read(envOut),
    exportArgv: read(exportArgvOut)?.trim().split("\n") ?? null,
    exportHermesHome: read(exportEnvOut),
    log: logFile ? fs.readFileSync(path.join(dir, logFile), "utf8") : "",
    usage: store.readUsage(),
  };
}

test("dispatch: an isolated hermes step on a local provider spawns in the isolated home and advances", async () => {
  const r = await runHermes({ provider: "ollama-launch" });
  assert.equal(r.hermesHome, path.join(r.dir, "hermes-home"));
  assert.deepEqual(fs.readdirSync(path.join(r.dir, "hermes-home")), ["config.yaml"]);
  assert.ok(r.argv);
  assert.deepEqual(r.argv?.slice(-5), ["--ignore-rules", "--source", "tool", "-t", "terminal,file"]);
  assert.equal(r.argv?.[r.argv.indexOf("--provider") + 1], "ollama-launch");
  assert.deepEqual(r.advanced.map((a) => a.outcome), ["advance"]);
  assert.equal(r.usage[0]?.sessionId, "fake-1");
});

test("dispatch: the isolated cloud default fails before spawn with the canned reason in the run log", async () => {
  const r = await runHermes({});
  assert.equal(r.argv, null, "no agent spawned");
  assert.deepEqual(r.advanced.map((a) => [a.outcome, a.reason]), [["fail", CANNED_CLOUD]]);
  assert.match(r.log, new RegExp(`\\[agenthook\\] ${CANNED_CLOUD}`));
  assert.ok(r.events.some((e) => e[0] === "run_end" && e[3]?.outcome === "fail"));
  // a profile-level local agentProvider makes it go
  assert.equal((await runHermes({}, { agentProvider: "ollama-launch" })).advanced[0].outcome, "advance");
});

test("dispatch: a missing source config.yaml fails before spawn with its reason", async () => {
  const r = await runHermes({ provider: "ollama-launch" }, { yaml: null });
  assert.equal(r.argv, null);
  const reason = `hermes step is isolated but ${path.join(String(process.env.HERMES_HOME), "config.yaml")} is missing; create it or set isolated:false`;
  assert.deepEqual(r.advanced.map((a) => [a.outcome, a.reason]), [["fail", reason]]);
  assert.ok(r.log.includes(reason));
});

test("dispatch: isolated:false keeps today's argv and injects no HERMES_HOME; a step env HERMES_HOME wins", async () => {
  const off = await runHermes({ isolated: false }, { yaml: null });
  assert.equal(off.hermesHome, process.env.HERMES_HOME, "only the receiver's own env reaches it");
  assert.ok(!off.argv?.includes("--ignore-rules") && !off.argv?.includes("-t"), String(off.argv));
  assert.equal(off.advanced[0].outcome, "advance");
  const own = await runHermes({ env: { HERMES_HOME: "/elsewhere" } }, { yaml: null });
  assert.equal(own.hermesHome, "/elsewhere");
  assert.ok(own.argv?.includes("--ignore-rules"), "still isolated argv");
  assert.equal(own.advanced[0].outcome, "advance", "the step manages its own home: no preflight");
});

// --- post-exit finalize: hermes `sessions export` token capture (#395) ---

test("dispatch: finalize success — usage.jsonl/run_end carry the export's tokens, unpriced, no costUsd; export ran with the run's HERMES_HOME", async () => {
  const r = await runHermes({ provider: "ollama-launch" });
  assert.deepEqual(r.exportArgv?.slice(0, 2), ["sessions", "export"]);
  assert.ok(r.exportArgv?.includes("--session-id") && r.exportArgv?.includes("fake-1"));
  assert.equal(r.exportHermesHome, r.hermesHome, "the export sees the same isolated HERMES_HOME the chat run used");
  assert.deepEqual([r.usage[0].input, r.usage[0].output, r.usage[0].cacheRead, r.usage[0].cacheCreate], [18010, 1371, 102182, 0]);
  assert.equal(r.usage[0].unpriced, true);
  assert.equal("costUsd" in r.usage[0] && r.usage[0].costUsd !== undefined, false);
  const end = r.events.find((e) => e[0] === "run_end")?.[3];
  assert.deepEqual([end.input, end.output, end.cacheRead, end.cacheCreate], [18010, 1371, 102182, 0]);
  assert.equal(end.unpriced, true);
  assert.equal("costUsd" in end, false);
  // the scratch export dir is gone once the run is done
  assert.equal(fs.existsSync(path.join(r.dir, "exports", "42-code")), false);
});

test("dispatch: finalize failure (export exits non-zero) — tokens stay 0, one log line, outcome unaffected", async () => {
  process.env.FAKE_EXPORT_FAIL = "1";
  try {
    const r = await runHermes({ provider: "ollama-launch" });
    assert.deepEqual([r.usage[0].input, r.usage[0].output, r.usage[0].cacheRead, r.usage[0].cacheCreate], [0, 0, 0, 0]);
    assert.equal(r.usage[0].unpriced, true);
    assert.match(r.log, /\[agenthook\] hermes usage export failed:/);
    assert.equal(r.advanced[0].outcome, "advance", "a finalize failure never touches the verdict");
    assert.equal(fs.existsSync(path.join(r.dir, "exports", "42-code")), false, "the scratch dir is still cleaned up");
  } finally {
    delete process.env.FAKE_EXPORT_FAIL;
  }
});

test("dispatch: no session id (no session_id: line) — finalize is never invoked", async () => {
  process.env.FAKE_NO_SESSION = "1";
  try {
    const r = await runHermes({ provider: "ollama-launch" });
    assert.equal(r.exportArgv, null, "sessions export was never run");
    assert.equal(r.usage.length, 0, "no result (no session_id) -> no usage record at all");
  } finally {
    delete process.env.FAKE_NO_SESSION;
  }
});

test("dispatch: a preflight-refused run (no local provider) — finalize is never invoked", async () => {
  const r = await runHermes({});
  assert.equal(r.argv, null, "no agent spawned");
  assert.equal(r.exportArgv, null, "no export either");
});
