import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// `follow`/`resume` for remote (ssh) harness runs (#830): a remote run's transcript lives on
// the WORKER, so `follow` streams it read-only over the executor's probe argv (`-T`, no pty,
// never `-A`), and `resume` reaches the session's worker dir over `sshInteractiveArgv` (the
// only tty variant) — probing first, because `syncAfter` removes the dir after every run. A
// remote run of an agent that keeps no transcript (opencode) has nothing to stream: `follow`
// tails the hub-side run log instead.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, registryDir } from "../src/config.js";
import { createStore } from "../src/store.js";
import { mangle } from "../src/paths.js";
import { listSessions } from "../src/sessions.js";
import { follow, followRemote, NoTranscriptYet, remoteFollowCandidates } from "../src/commands/follow.js";
import { resume, unreachableWorker } from "../src/commands/resume.js";
import { sshInteractiveArgv, sshBaseArgs, remoteProbeArgv, remoteRunPaths, remoteTranscriptDir, shQuote } from "../src/dispatch/executor-ssh.js";
import { runtimeEnv } from "../src/dispatch/sandbox.js";

// --- fakes: an ssh that logs its argv and runs the remote script locally with $HOME pointed
// at a fake worker home (plus a non-following `tail`, so `tail -n 15 -F` prints and exits) ---

// The fake reads its controls from FILES in its own dir, not the environment: follow/resume
// launch ssh with the executor's own client env (`sshClientEnv`), which strips every variable
// but PATH/HOME/USER/XDG_RUNTIME_DIR + container prefixes — an env-var control would not
// survive to the fake.
const FAKE_SSH = `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
fs.appendFileSync(path.join(here, "record.jsonl"), JSON.stringify({ all: args, envKeys: Object.keys(process.env), secrets: { GITHUB_TOKEN: process.env.GITHUB_TOKEN, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, API_KEY: process.env.API_KEY } }) + "\\n");
try {
  const forced = fs.readFileSync(path.join(here, "SSH_EXIT"), "utf8").split("\\n");
  console.error(forced.slice(1).join("\\n"));
  process.exit(Number(forced[0]));
} catch { /* no forced exit file — run the remote script locally */ }
const home = fs.readFileSync(path.join(here, "FAKE_HOME"), "utf8").trim();
const valued = new Set(["-o", "-p", "-i", "-l"]);
let i = 0;
while (i < args.length) {
  const a = args[i];
  if (a === "-T" || a === "-t") { i++; continue; }
  if (valued.has(a)) { i += 2; continue; }
  break;
}
i++; // the host
const r = spawnSync("sh", ["-c", args.slice(i).join(" ")], { stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, HOME: home } });
process.exit(r.status ?? 1);
`;

/** A fake `tail`: print the initial lines (the remote script's `tail -n 15 -F` call shape) and
 * exit, instead of following forever. */
const FAKE_TAIL = `#!/bin/sh\nhead -n 15 "$4"\n`;

/** A fake `cat` that lingers a beat: the remote script's `cat >/dev/null` watchdog gets EOF
 * instantly here (the fake worker has no live ssh stdin), so without the delay it would `kill`
 * the just-spawned background tail before it could print. A live worker's ssh stdin blocks
 * until Ctrl-C, which is the delay this stands in for. */
const FAKE_CAT = `#!/bin/sh\nsleep 0.2\n`;

function withFakeWorkerSsh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-rfr-bin-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ah-rfr-home-"));
  fs.writeFileSync(path.join(dir, "ssh"), FAKE_SSH, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "tail"), FAKE_TAIL, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "cat"), FAKE_CAT, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "FAKE_HOME"), home);
  const saved = { PATH: process.env.PATH };
  process.env.PATH = `${dir}${path.delimiter}${process.env.PATH}`;
  return {
    home,
    /** Force every ssh call to exit `code` printing `stderr` (an unreachable worker). */
    setUnreachable: (code, stderr) => fs.writeFileSync(path.join(dir, "SSH_EXIT"), `${code}\n${stderr}`),
    clearUnreachable: () => fs.rmSync(path.join(dir, "SSH_EXIT"), { force: true }),
    record: () => (fs.existsSync(path.join(dir, "record.jsonl")) ? fs.readFileSync(path.join(dir, "record.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []),
    restore: () => {
      process.env.PATH = saved.PATH;
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

// --- profiles: a real config file on disk (follow/resume load through loadConfig), one state
// key each so the isolated AGENTHOOK_HOME registry keeps them apart ---

let n = 0;
const madeState = [];
/** @param {{pipeline?: any[], harnesses?: (p: any) => any, agent?: string}} o */
function makeProfile(o = {}) {
  n++;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `ah-rfr-${n}-`));
  const repo = path.join(root, "repo");
  const workDir = path.join(root, "worker");
  fs.mkdirSync(repo);
  fs.mkdirSync(workDir);
  const file = path.join(root, "agenthook.config.json");
  const prof = { root, file, workDir, stateKey: `rf${n}` };
  fs.writeFileSync(
    file,
    JSON.stringify({
      name: `rf${n}`,
      stateId: `rf${n}`,
      repoPath: repo,
      ...(o.agent ? { agent: o.agent } : {}),
      tracker: { type: "asana", pipeline: o.pipeline ?? [{ id: "code" }] },
      ...(o.harnesses ? { harnesses: o.harnesses(prof) } : {}),
    }),
  );
  madeState.push(prof.stateKey);
  return prof;
}
test.after(() => {
  for (const k of madeState) fs.rmSync(path.join(registryDir, k), { recursive: true, force: true });
});

/** The profile's state dir is created lazily by the server in real life; make it here so the
 * store has somewhere to append. @param {any} cfg */
function storeFor(cfg) {
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  return createStore(cfg.dataDir);
}

/** Run `fn`, capturing console.log. @param {() => Promise<void>} fn @returns {Promise<string>} */
async function withLogs(fn) {
  const out = [];
  const orig = console.log;
  console.log = (...a) => out.push(a.join(" "));
  try {
    await fn();
  } finally {
    console.log = orig;
  }
  return out.join("\n");
}

const TRANSCRIPT =
  JSON.stringify({ type: "user", timestamp: "2026-01-01T00:00:00.000Z", message: { content: [{ type: "text", text: "=== TICKET === do it" }] } }) +
  "\n" +
  JSON.stringify({ type: "assistant", timestamp: "2026-01-01T00:00:01.000Z", message: { content: [{ type: "text", text: "working on it" }] } }) +
  "\n";

/** Assert the fake ssh's received env is EXACTLY the executor's client env: no key beyond
 * `runtimeEnv` + `SSH_AUTH_SOCK` + TERM, and the seeded secrets/step-env keys absent. A
 * regression to `env: process.env` (or `{...process.env, ...step.env}`) fails both checks.
 * @param {{envKeys: string[], secrets: Record<string, string|undefined>}} rec */
function assertWorkerEnvClean(rec) {
  const allowed = new Set([...Object.keys(runtimeEnv(process.env)), "SSH_AUTH_SOCK", "TERM"]);
  assert.deepEqual(rec.envKeys.filter((k) => !allowed.has(k)).sort(), [], `unexpected keys in the worker ssh env`);
  assert.equal(rec.secrets.GITHUB_TOKEN, undefined, "seeded GITHUB_TOKEN must not reach the worker");
  assert.equal(rec.secrets.ANTHROPIC_API_KEY, undefined, "seeded ANTHROPIC_API_KEY must not reach the worker");
  assert.equal(rec.secrets.API_KEY, undefined, "a step-env-named key from process.env must not reach the worker");
}

/** Seed fake secrets + a step-env-named key into process.env; returns a restore fn. */
function seedSecrets() {
  const saved = { g: process.env.GITHUB_TOKEN, a: process.env.ANTHROPIC_API_KEY, k: process.env.API_KEY };
  process.env.GITHUB_TOKEN = "fake-gh-token";
  process.env.ANTHROPIC_API_KEY = "fake-ant-token";
  process.env.API_KEY = "fake-step-token";
  return () => {
    const put = (k, v) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
    put("GITHUB_TOKEN", saved.g);
    put("ANTHROPIC_API_KEY", saved.a);
    put("API_KEY", saved.k);
  };
}

/** Plant a worker transcript `<id>.jsonl` for launch cwd; returns its path. */
function plantTranscript(home, cwd, id) {
  const dir = path.join(home, ".claude", "projects", mangle(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, TRANSCRIPT);
  return file;
}

const workerRemote = (p) => ({ worker: { remote: { host: "worker.test", workDir: p.workDir } } });

// --- pure builders (src/dispatch/executor-ssh.js) ---

test("sshInteractiveArgv: the only tty variant — -t (not -T), the same options, shQuoted sh -c tail, never -A", () => {
  const remote = { host: "h.test", port: 2222, user: "w", identityFile: "/k", workDir: "/w" };
  assert.deepEqual(sshInteractiveArgv(remote, "S"), ["-t", "-o", "BatchMode=yes", "-p", "2222", "-i", "/k", "-l", "w", "h.test", "'sh'", "'-c'", "'S'"]);
  assert.deepEqual(sshBaseArgs(remote), ["-T", "-o", "BatchMode=yes", "-p", "2222", "-i", "/k", "-l", "w", "h.test"]);
  assert.deepEqual(remoteProbeArgv(remote, "S"), [...sshBaseArgs(remote), "'sh'", "'-c'", "'S'"]);
  assert.ok(!sshInteractiveArgv(remote, "S").includes("-A"), "never agent-socket forwarding");
});

test("remoteRunPaths / remoteTranscriptDir: reuse the executor's worker layout; the transcript dir is $HOME-relative", () => {
  const remote = { host: "h.test", workDir: "/w" };
  assert.deepEqual(remoteRunPaths(remote, "sk", { ref: "7", stepId: "code", hasWorktree: true, repoId: "default" }), {
    cwd: "/w/.agenthook/sk/worktrees/7",
    bareRepo: "/w/.agenthook/sk/repos/default.git",
  });
  assert.equal(remoteRunPaths(remote, "sk", { ref: "7", stepId: "code", hasWorktree: false }).cwd, "/w/.agenthook/sk/exports/7-code");
  assert.equal(remoteTranscriptDir("/w/.agenthook/sk/worktrees/7"), ".claude/projects/-w--agenthook-sk-worktrees-7");
});

test("unreachableWorker: one line naming host, harness and the first stderr line", () => {
  assert.equal(unreachableWorker({ host: "h.test" }, "worker", new Error("Connection refused\n")).message, `worker h.test (harness "worker") unreachable: Connection refused`);
  assert.match(unreachableWorker({ host: "h.test" }, "worker", new Error("")).message, /unreachable: ssh failed$/);
});

test("remoteFollowCandidates: only runs whose harness still points at that exact host qualify", () => {
  const cfg = { harnesses: { worker: { remote: { host: "worker.test", workDir: "/w" } } } };
  const running = {
    "1": { stepId: "code", startedAt: "a", worktree: "/w/1", harness: "worker", agent: "claude", host: "worker.test" },
    "2": { stepId: "code", startedAt: "b", worktree: "/w/2", harness: "worker", agent: "claude", host: "repointed.test" }, // harness edited mid-run
    "3": { stepId: "code", startedAt: "c", worktree: "/w/3", harness: "gone", agent: "claude", host: "gone.test" }, // harness removed
  };
  assert.deepEqual(remoteFollowCandidates(cfg, running).map((c) => c.ref), ["1"]);
});

// --- follow: an in-flight remote claude run, auto-picked with no id ---

test("follow (no id): an in-flight remote claude run wins over local search and streams its worker transcript over -T ssh", async () => {
  const ssh = withFakeWorkerSsh();
  const prof = makeProfile({ harnesses: workerRemote });
  const unseed = seedSecrets();
  try {
    const cfg = loadConfig({ configPath: prof.file });
    const wt = `${prof.workDir}/.agenthook/${prof.stateKey}/worktrees/1`;
    const file = plantTranscript(ssh.home, wt, "sess-1");
    storeFor(cfg).setRunning("1", { stepId: "code", startedAt: new Date().toISOString(), worktree: wt, harness: "worker", agent: "claude", host: "worker.test" });

    const out = await withLogs(() => follow({ config: prof.file, _: [] }));
    assert.ok(out.includes(`following: worker.test:${file}  (Ctrl+C to stop — agent keeps running)`), out);
    assert.ok(out.includes("🤖 working on it"), `rendered transcript line missing:\n${out}`);

    const last = ssh.record().at(-1);
    const argv = last.all;
    assert.equal(argv[0], "-T", "follow must use the no-pty probe argv");
    assert.deepEqual(argv.slice(0, 4), ["-T", "-o", "BatchMode=yes", "worker.test"]);
    assert.ok(!argv.includes("-t") && !argv.includes("-A"), "never a pty, never agent-socket forwarding");
    assert.ok(argv[6].includes(`.claude/projects/${mangle(wt)}`), `script must resolve the worker transcript dir under $HOME (got ${argv[6]})`);
    assert.ok(argv[6].includes('tail -n 15 -F "$f" &') && argv[6].includes("cat >/dev/null"), `the remote tail must run under the closed-stdin watchdog (got ${argv[6]})`);
    // The ssh client env is the executor's own: no seeded secrets, nothing beyond runtimeEnv.
    assertWorkerEnvClean(last);
  } finally {
    unseed();
    ssh.restore();
  }
});

test("follow (opencode profile, no remote run): the original 'no transcripts to follow' error, unchanged", async () => {
  const prof = makeProfile({ agent: "opencode" });
  await assert.rejects(follow({ config: prof.file, _: [] }), (e) => /^opencode runs have no transcripts to follow$/.test(e.message));
});

test("follow <id> (opencode profile, no remote run): same error, no ssh call", async () => {
  const ssh = withFakeWorkerSsh();
  const prof = makeProfile({ agent: "opencode" });
  try {
    await assert.rejects(follow({ config: prof.file, _: ["s-1"] }), (e) => /^opencode runs have no transcripts to follow$/.test(e.message));
    assert.equal(ssh.record().length, 0, "no remote candidate, so no ssh call");
  } finally {
    ssh.restore();
  }
});

test("follow (no id): an in-flight remote run whose worker has no transcript yet is a plain error, not a hang", async () => {
  const ssh = withFakeWorkerSsh();
  const prof = makeProfile({ harnesses: workerRemote });
  try {
    const cfg = loadConfig({ configPath: prof.file });
    const wt = `${prof.workDir}/.agenthook/${prof.stateKey}/worktrees/1`;
    storeFor(cfg).setRunning("1", { stepId: "code", startedAt: new Date().toISOString(), worktree: wt, harness: "worker", agent: "claude", host: "worker.test" });
    await assert.rejects(
      withLogs(() => follow({ config: prof.file, _: [] })),
      /no transcript yet on worker\.test for <newest> — the run has not written one/,
    );
  } finally {
    ssh.restore();
  }
});

test("follow <id>: streams that exact remote transcript; an invalid id is refused before reaching ssh; a missing id says so", async () => {
  const ssh = withFakeWorkerSsh();
  const prof = makeProfile({ harnesses: workerRemote });
  try {
    const cfg = loadConfig({ configPath: prof.file });
    const wt = `${prof.workDir}/.agenthook/${prof.stateKey}/worktrees/1`;
    const file = plantTranscript(ssh.home, wt, "sess-2");
    storeFor(cfg).setRunning("1", { stepId: "code", startedAt: new Date().toISOString(), worktree: wt, harness: "worker", agent: "claude", host: "worker.test" });

    const out = await withLogs(() => follow({ config: prof.file, _: ["sess-2"] }));
    assert.ok(out.includes(`following: worker.test:${file}`), out);
    const last = ssh.record().at(-1).all[6];
    assert.ok(last.includes("sess-2") && last.includes(".jsonl"), JSON.stringify(last));
    assert.ok(!last.includes("ls -t"), "an explicit id must pick its own file, not the newest");

    await assert.rejects(withLogs(() => follow({ config: prof.file, _: ["bad$id"] })), /invalid session id "bad\$id" for a remote transcript/);
    await assert.rejects(withLogs(() => follow({ config: prof.file, _: ["sess-3"] })), /no transcript yet on worker\.test for sess-3/);
  } finally {
    ssh.restore();
  }
});

test("followRemote: a worker ssh that can't connect is one line naming host + harness + stderr", async () => {
  const ssh = withFakeWorkerSsh();
  try {
    ssh.setUnreachable(255, "Connection refused");
    await assert.rejects(
      followRemote({ host: "worker.test", workDir: "/w" }, "/w/x", null, "worker"),
      /worker worker\.test \(harness "worker"\) unreachable: Connection refused/,
    );
  } finally {
    ssh.restore();
  }
});

test("followRemote: exit 3 (no transcript yet) is tagged NoTranscriptYet so follow's candidate loop can continue", async () => {
  const ssh = withFakeWorkerSsh();
  try {
    const wt = "/w/.agenthook/p/worktrees/1";
    await assert.rejects(followRemote({ host: "worker.test", workDir: "/w" }, wt, "none", "worker"), (e) => e instanceof NoTranscriptYet && /no transcript yet/.test(e.message));
  } finally {
    ssh.restore();
  }
});

// --- follow: an opencode remote run tails the HUB run log (nothing on the worker to stream) ---

test("follow (no id): an in-flight remote opencode run follows its HUB run log (the keepsTranscripts routing)", async () => {
  const ssh = withFakeWorkerSsh();
  const prof = makeProfile({ harnesses: workerRemote });
  try {
    const cfg = loadConfig({ configPath: prof.file });
    const wt = `${prof.workDir}/.agenthook/${prof.stateKey}/worktrees/9`;
    storeFor(cfg).setRunning("9", { stepId: "code", startedAt: new Date().toISOString(), worktree: wt, harness: "worker", agent: "opencode", host: "worker.test" });

    // No run log yet → the plain error, through the command (not the helper).
    await assert.rejects(
      withLogs(() => follow({ config: prof.file, _: [] })),
      /agent opencode keeps no transcript on worker\.test and no hub run log is readable for 9/,
    );

    // A run log + a run_start event → follow() routes opencode to the hub run log and
    // streams it raw (the abort signal is the test's stand-in for Ctrl-C).
    fs.mkdirSync(cfg.logDir, { recursive: true });
    fs.writeFileSync(path.join(cfg.logDir, "2026-01-01T00-00-00-000Z-step-code-9.log"), "hub boot line\nopencode said hello\n");
    fs.appendFileSync(path.join(cfg.stateDir, "events.jsonl"), JSON.stringify({ event: "run_start", ref: "9", step: "code", ts: "2026-01-01T00:00:00.000Z" }) + "\n");
    const ac = new AbortController();
    const p = withLogs(() => follow({ config: prof.file, _: [], signal: ac.signal }));
    await new Promise((r) => setTimeout(r, 150));
    ac.abort();
    const out = await p;
    assert.ok(out.includes("agent opencode keeps no transcript on worker.test — following its hub run log"), out);
    assert.ok(out.includes("opencode said hello"), `run log line missing:\n${out}`);
    // The keepsTranscripts routing kept opencode off the remote-tail path: no ssh at all.
    assert.equal(ssh.record().length, 0, "an opencode run must not reach the worker over ssh");
  } finally {
    ssh.restore();
  }
});

// --- resume: remote sessions are listed, probed, and reached over the tty argv ---

function recordRemoteUsage(store, ref, id, cwd) {
  store.recordUsage({
    ref, stepId: "code", sessionId: id, startedAt: new Date().toISOString(),
    agent: "claude", harness: "worker", host: "worker.test", ...(cwd ? { remoteCwd: cwd } : {}),
  });
}

test("listSessions/resume <ref>: a remote-harness usage record is listed even though claude keeps transcripts, tagged @host", async () => {
  const prof = makeProfile({ pipeline: [{ id: "code", createsWorktree: true }], harnesses: workerRemote });
  const cfg = loadConfig({ configPath: prof.file });
  const store = storeFor(cfg);
  const dir = path.join(prof.root, "wd", "7");
  fs.mkdirSync(dir, { recursive: true });
  recordRemoteUsage(store, "7", "rs-1", dir);

  const listed = listSessions(cfg, "7", store);
  assert.deepEqual(listed, [{ id: "rs-1", step: "code", at: listed[0].at, msgs: 0, prompt: "", agent: "claude", remote: { harness: "worker", host: "worker.test", cwd: dir } }]);

  const out = await withLogs(() => resume({ config: prof.file, _: ["7"] }));
  assert.ok(out.includes("rs-1 @worker.test"), out);
});

test("resume <ref> <sel> (remote, dir present): prints the ssh -t command, never the step's env values", async () => {
  const ssh = withFakeWorkerSsh();
  const prof = makeProfile({ pipeline: [{ id: "code", createsWorktree: true, env: { API_KEY: "sekrit" } }], harnesses: workerRemote });
  try {
    const cfg = loadConfig({ configPath: prof.file });
    const store = storeFor(cfg);
    const dir = path.join(ssh.home, "wd", "7");
    fs.mkdirSync(dir, { recursive: true });
    recordRemoteUsage(store, "7", "rs-1", dir);

    const out = await withLogs(() => resume({ config: prof.file, _: ["7", "rs-1"] }));
    const line = out.split("\n").find((l) => l.startsWith("ssh "));
    assert.ok(line, `no ssh line printed:\n${out}`);
    assert.ok(line.startsWith("ssh -t -o BatchMode=yes worker.test "), `not the tty argv to the right host:\n${line}`);
    // The remote script is shQuoted (with '\'' escapes), so check its ingredients, not the raw text.
    assert.ok(line.includes(dir) && line.includes("claude") && line.includes("'rs-1'"), line);
    assert.ok(!out.includes("sekrit"), "the step's env VALUES must never be printed");
    assert.ok(out.includes(`step "code" sets env API_KEY for its agent — NOT forwarded to the worker`), out);
  } finally {
    ssh.restore();
  }
});

test("resume <ref> <sel> (remote, dir gone after the run, --exec): says so, offers the two options + the no-sync warning, exits 1, spawns no interactive ssh", async () => {
  const ssh = withFakeWorkerSsh();
  const prof = makeProfile({ pipeline: [{ id: "code", createsWorktree: true }], harnesses: workerRemote });
  try {
    const cfg = loadConfig({ configPath: prof.file });
    const store = storeFor(cfg);
    // The recorded cwd is the run's real WORKTREE path (what executor.paths() recorded) — it
    // never existed on the (fake) worker, so the probe says "gone". The worktree shape is what
    // makes option 2 (hand `git worktree add`) appear.
    recordRemoteUsage(store, "7", "rs-1", `${prof.workDir}/.agenthook/${prof.stateKey}/worktrees/7`); // never created

    process.exitCode = 0;
    try {
      const out = await withLogs(() => resume({ config: prof.file, _: ["7", "rs-1"], exec: true }));
      assert.ok(out.includes("was removed after the run"), out);
      assert.ok(out.includes("re-run the step from the tracker"), out);
      assert.ok(out.includes("worktree add"), `a worktree step offers the hand-recreate (got ${out})`);
      assert.ok(out.includes("do NOT sync back to the hub"), out);
      assert.equal(process.exitCode, 1);
    } finally {
      process.exitCode = 0;
    }
    // Only the no-pty probe reached the worker — no tty launch was attempted.
    const calls = ssh.record().map((c) => c.all);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], "-T");
  } finally {
    ssh.restore();
  }
});

test("resume <ref> <sel> --exec (remote, dir present): runs the -t ssh with the tty client env and maps its exit", async () => {
  const ssh = withFakeWorkerSsh();
  // `bin` names a binary the (fake) worker doesn't have — the machine may well have a real
  // `claude`, and the assertion is on the plumbing, not on claude's exit codes. It also pins
  // the precedence `remote.bin` > agent default.
  const prof = makeProfile({ pipeline: [{ id: "code", createsWorktree: true }], harnesses: (p) => ({ worker: { remote: { host: "worker.test", workDir: p.workDir, bin: "definitely-missing-830" } } }) });
  const unseed = seedSecrets();
  try {
    const cfg = loadConfig({ configPath: prof.file });
    const store = storeFor(cfg);
    const dir = path.join(ssh.home, "wd", "7");
    fs.mkdirSync(dir, { recursive: true });
    recordRemoteUsage(store, "7", "rs-1", dir);

    process.exitCode = 0;
    try {
      await withLogs(() => resume({ config: prof.file, _: ["7", "rs-1"], exec: true }));
      // The fake worker has no `claude`, so the script's `exec 'claude' …` is sh's 127 —
      // proving the script reached the worker and its status was mapped onto exitCode.
      assert.equal(process.exitCode, 127);
    } finally {
      process.exitCode = 0;
    }
    const last = ssh.record().at(-1);
    assert.equal(last.all[0], "-t", "the exec launch is the tty variant (the probe before it was -T)");
    assert.deepEqual(last.all.slice(0, 4), ["-t", "-o", "BatchMode=yes", "worker.test"], "the tty argv keeps BatchMode, host and no -A");
    assert.equal(last.all.includes("-A"), false, "never agent-socket forwarding");
    // The exact remote script: cd into the worker dir, exec the bin with the agent's resume
    // argv. The argv element is shQuoted once more (as in runRemote), so compare that form.
    const script = `cd ${shQuote(dir)} && exec 'definitely-missing-830' '-r' 'rs-1'`;
    assert.equal(last.all[6], shQuote(script), "the tty launch must run exactly `cd <cwd> && exec <bin> -r <id>` on the worker");
    // The interactive ssh got the tty client env: no seeded secrets, nothing beyond runtimeEnv.
    assertWorkerEnvClean(last);
  } finally {
    unseed();
    ssh.restore();
  }
});

test("resume <ref> <sel> (remote, unreachable worker): one line naming host + harness + stderr", async () => {
  const ssh = withFakeWorkerSsh();
  const prof = makeProfile({ pipeline: [{ id: "code", createsWorktree: true }], harnesses: workerRemote });
  try {
    const cfg = loadConfig({ configPath: prof.file });
    const store = storeFor(cfg);
    recordRemoteUsage(store, "7", "rs-1", path.join(ssh.home, "wd", "7"));
    ssh.setUnreachable(255, "Connection timed out");
    await assert.rejects(
      withLogs(() => resume({ config: prof.file, _: ["7", "rs-1"] })),
      /worker worker\.test \(harness "worker"\) unreachable: Connection timed out/,
    );
  } finally {
    ssh.restore();
  }
});

test("resume <ref> <sel> (remote, old record without remoteCwd): a plain error naming the gap", async () => {
  const prof = makeProfile({ pipeline: [{ id: "code", createsWorktree: true }], harnesses: workerRemote });
  const store = storeFor(loadConfig({ configPath: prof.file }));
  recordRemoteUsage(store, "7", "rs-1", undefined);
  await assert.rejects(
    withLogs(() => resume({ config: prof.file, _: ["7", "rs-1"] })),
    /can't locate this run's directory on worker\.test/,
  );
});
