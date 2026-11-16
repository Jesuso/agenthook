import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// End to end through the real dispatcher, with $DOCKER pointing at a fake client (sandboxHarness,
// _dispatch-sandbox-helpers.js). The fake records its argv, and for `run` execs the inner
// `<bin> <args>` on the host in --workdir with only the `-e` names it was given (values from its
// own env) — like a runtime. Covers the agent's run, its gate (#710), cancel, and the host git
// calls dispatch makes along the way (time-capped against a wedged/FIFO repo).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { hostGitFacts } from "../src/dispatch/sandbox.js";
import { HOST_GIT_TIMEOUT_MS, listWorktrees } from "../src/worktree.js";
import { fixture, g, isAgentRun, sandboxHarness } from "./_dispatch-sandbox-helpers.js";

test("sandbox e2e: a claude step runs through the runtime, routes on its per-run verdict, mounts its worktree", async () => {
  const h = sandboxHarness([{ id: "code", createsWorktree: true, env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-secret-9f3a" } }, { id: "done", manual: true }]);
  try {
    await h.go("code");
    assert.deepEqual(h.advanced.map((a) => [a.step, a.outcome, a.reason]), [["code", "advance", "ok"]]);
    const run = h.calls().find(isAgentRun);
    assert.ok(run, "the runtime client was spawned");
    const wt = path.join(h.root, "wts", "42");
    const mounts = run.flatMap((/** @type {string} */ x, /** @type {number} */ i) => (x === "--mount" ? [run[i + 1]] : []));
    assert.ok(mounts.includes(`type=bind,src=${wt},dst=${wt}`), mounts.join("\n"));
    assert.ok(mounts.includes(`type=bind,src=${path.join(h.repo, ".git", "config")},dst=${path.join(h.repo, ".git", "config")},readonly`));
    assert.ok(mounts.some((m) => m.startsWith(`type=bind,src=${path.join(h.root, "home", ".claude", "projects")}`)), "the transcript dir");
    assert.ok(!run.some((/** @type {string} */ x) => x.includes("sk-secret-9f3a")), "no env value in argv");
    const got = h.innerOut();
    assert.match(got?.VF ?? "", /\/verdicts\/run-42-code\/verdict\.json$/);
    assert.equal(got?.SSH, "unset", "host-only keys never reach the container");
    assert.equal(got?.TOKEN, "sk-secret-9f3a");
    assert.equal(got?.PWD, wt);
    assert.equal(got?.NOAUTO, "1");
    assert.notEqual(got?.GITCOUNT, "unset");
    assert.equal(fs.existsSync(path.join(h.state, "verdicts", "run-42-code")), false, "per-run verdict dir removed");
    assert.deepEqual(fs.readdirSync(path.join(h.state, "sandbox-home")), [], "per-run HOME removed");
  } finally {
    h.restore();
  }
});

test("sandbox e2e: a run-token adapter (#474) mounts GH_CONFIG_DIR read-only, passes its env, strips GITHUB_TOKEN from the container, and disposes once", async () => {
  const credsDir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-run-creds-"));
  fs.mkdirSync(path.join(credsDir, "gh"));
  fs.writeFileSync(path.join(credsDir, "gh", "hosts.yml"), "github.com:\n  oauth_token: ghs_x\n");
  let disposeCalls = 0;
  const runCredentials = async () => ({
    env: { GH_CONFIG_DIR: path.join(credsDir, "gh"), GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "credential.https://github.com.helper", GIT_CONFIG_VALUE_0: "!gh auth git-credential" },
    strip: ["GH_TOKEN", "GITHUB_TOKEN"],
    label: "GitHub App token: o/r, expires soon",
    dispose: async () => void disposeCalls++,
  });
  const h = sandboxHarness([{ id: "code", createsWorktree: true, env: { CLAUDE_CODE_OAUTH_TOKEN: "tok" } }, { id: "done", manual: true }], { runCredentials, agentEnvPassthrough: ["GITHUB_TOKEN"] });
  const savedToken = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = "ghp_operator_secret";
  try {
    await h.go("code");
    assert.equal(h.advanced[0]?.outcome, "advance");
    const run = h.calls().find(isAgentRun);
    assert.ok(run, "the runtime client was spawned");
    const mounts = run.flatMap((/** @type {string} */ x, /** @type {number} */ i) => (x === "--mount" ? [run[i + 1]] : []));
    assert.ok(mounts.includes(`type=bind,src=${path.join(credsDir, "gh")},dst=${path.join(credsDir, "gh")},readonly`), mounts.join("\n"));
    assert.ok(run.includes("GH_CONFIG_DIR"), "GH_CONFIG_DIR passed by name");
    assert.ok(run.includes("GIT_CONFIG_COUNT"), "a single, merged GIT_CONFIG_COUNT passed by name");
    assert.ok(!run.includes("GITHUB_TOKEN"), "stripped even though allowlisted and set in the receiver env");
    const got = h.innerOut();
    assert.equal(got?.GHCFG, path.join(credsDir, "gh"));
    assert.equal(got?.GHTOK, "unset", "the container never sees the receiver's GITHUB_TOKEN");
    assert.notEqual(got?.GITCOUNT, "unset");
    assert.equal(disposeCalls, 1, "dispose runs once after a normal exit");
  } finally {
    if (savedToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = savedToken;
    fs.rmSync(credsDir, { recursive: true, force: true });
    h.restore();
  }
});

test("sandbox e2e: a no-worktree claude step (triage) mounts nothing under the host ~/.claude — its transcript goes to a receiver-owned dir", async () => {
  const h = sandboxHarness([{ id: "triage", env: { CLAUDE_CODE_OAUTH_TOKEN: "tok" } }, { id: "done", manual: true }]);
  g(h.repo, ["worktree", "remove", "--force", path.join(h.root, "wts", "42")]); // no worktree yet: cwd = the main checkout
  try {
    await h.go("triage");
    assert.equal(h.advanced[0]?.outcome, "advance");
    const run = h.calls().find(isAgentRun);
    assert.ok(run, "the runtime client was spawned");
    const srcs = run.flatMap((/** @type {string} */ x, /** @type {number} */ i) => (x === "--mount" ? [run[i + 1].split(",")[1].slice("src=".length)] : []));
    const hostClaude = path.join(h.root, "home", ".claude");
    assert.ok(!srcs.some((/** @type {string} */ s) => s === hostClaude || s.startsWith(hostClaude + path.sep)), srcs.join("\n"));
    assert.ok(srcs.includes(path.join(h.state, "sandbox-transcripts", h.repo.replace(/[^A-Za-z0-9]/g, "-"))), "the receiver-owned transcript dir");
    assert.ok(run.some((/** @type {string} */ x) => x === `type=bind,src=${h.repo},dst=${h.repo},readonly`), "the main checkout, read-only");
  } finally {
    h.restore();
  }
});

test("sandbox e2e: a sandboxed cursor step is refused and the runtime is never spawned", async () => {
  const h = sandboxHarness([{ id: "code", agent: "cursor" }, { id: "done", manual: true }]);
  try {
    await h.go("code");
    assert.equal(h.advanced[0].outcome, "fail");
    assert.match(h.advanced[0].reason, /cursor does not support the sandbox yet — the run is refused rather than run on the host \(set "sandbox": false on step "code"/);
    assert.deepEqual(h.calls(), []);
  } finally {
    h.restore();
  }
});

test("sandbox e2e: a sandboxed opencode step (agent: opencode) is not refused and runs through the runtime, with the per-run HOME mounted", async () => {
  const h = sandboxHarness([{ id: "code", agent: "opencode", createsWorktree: true }, { id: "done", manual: true }]);
  // The harness's claudeBin stub doubles as the opencode binary here — the stub is agent-agnostic.
  h.cfg.pipeline[0].bin = h.cfg.claudeBin;
  try {
    await h.go("code");
    assert.equal(h.advanced[0]?.outcome, "advance", JSON.stringify(h.advanced));
    const run = h.calls().find(isAgentRun);
    assert.ok(run, "the runtime client was spawned");
    const mounts = run.flatMap((/** @type {string} */ x, /** @type {number} */ i) => (x === "--mount" ? [run[i + 1]] : []));
    assert.ok(mounts.some((m) => m.startsWith(`type=bind,src=${path.join(h.state, "sandbox-home")}`) && m.endsWith(`,dst=${path.join("/home", "agent")}`)), mounts.join("\n"));
  } finally {
    h.restore();
  }
});

test("sandbox e2e: a sandboxed opencode run with no verdict gets no repair spawn (#677 — sandboxResume:false)", async () => {
  const h = sandboxHarness([{ id: "code", agent: "opencode", createsWorktree: true }, { id: "done", manual: true }], {
    inner: `#!/bin/sh\nprintf '{"type":"step_start","sessionID":"ses_oc"}\\n'\nexit 0\n`,
  });
  h.cfg.pipeline[0].bin = h.cfg.claudeBin;
  try {
    await h.go("code");
    assert.equal(h.advanced[0]?.outcome, "hold", JSON.stringify(h.advanced));
    assert.equal(h.calls().filter(isAgentRun).length, 1, "no resume spawn — opencode's sandboxed session db is gone at teardown");
    assert.equal(h.events.find((e) => e.event === "verdict_repair"), undefined);
    assert.equal(h.events.find((e) => e.event === "run_end")?.data.repaired, undefined);
  } finally {
    h.restore();
  }
});

test("sandbox e2e: a harness with agent: opencode routes a sandboxed run through it unrefused", async () => {
  const h = sandboxHarness([{ id: "code", harness: "oc-local", createsWorktree: true }, { id: "done", manual: true }]);
  h.cfg.harnesses = { "oc-local": { agent: "opencode", bin: h.cfg.claudeBin } };
  try {
    await h.go("code", { harness: "oc-local" });
    assert.equal(h.advanced[0]?.outcome, "advance", JSON.stringify(h.advanced));
    const run = h.calls().find(isAgentRun);
    assert.ok(run, "the runtime client was spawned");
  } finally {
    h.restore();
  }
});

// --- a step's gate (#710), sandboxed: the gate's argv reaches sandbox.wrap (another docker
// `run`), with the run's own mounts — never a direct host spawn of it ---

test("sandbox e2e: a step's gate runs through sandbox.wrap, with the same mounts as the agent's run", async () => {
  const h = sandboxHarness([{ id: "code", createsWorktree: true, gate: "echo sandboxed-gate-ran", gateTimeoutMinutes: 1, env: { CLAUDE_CODE_OAUTH_TOKEN: "tok" } }, { id: "done", manual: true }]);
  try {
    await h.go("code");
    assert.equal(h.advanced[0]?.outcome, "advance", JSON.stringify(h.advanced));
    const runs = h.calls().filter(isAgentRun);
    assert.equal(runs.length, 2, "the agent's run, then the gate's own run");
    const [agentRun, gateRun] = runs;
    // Same flag-skip the FAKE_DOCKER client itself uses to find `<bin> <args...>` after `run`.
    const valued = new Set(["--pull", "--name", "--label", "--cap-drop", "--security-opt", "--pids-limit", "--memory", "--cpus", "--user", "--mount", "--network"]);
    /** @param {string[]} run */
    const clientArgv = (run) => {
      let i = 1;
      for (; i < run.length; i++) {
        const a = run[i];
        if (a === "-e" || a === "--workdir") { i++; continue; }
        if (valued.has(a)) { i++; continue; }
        if (!a.startsWith("-")) break;
      }
      return run.slice(i + 1); // drop the image name, keep <bin> <args...>
    };
    assert.deepEqual(clientArgv(gateRun), ["sh", "-c", "echo sandboxed-gate-ran"]);
    // Each wrap() call gets its own container and its own per-container sandbox-home mount
    // (a random id baked into the path, src/sandbox/container.js containerName) — that part
    // legitimately differs between the agent's and the gate's own containers; everything else
    // (the run's own mounts: worktree, verdict dir, git dirs, …) must be identical.
    /** @param {string[]} run */
    const mountsOf = (run) => run.flatMap((/** @type {string} */ x, /** @type {number} */ i) => (x === "--mount" ? [run[i + 1]] : [])).filter((m) => !m.includes("/sandbox-home/")).sort();
    assert.deepEqual(mountsOf(gateRun), mountsOf(agentRun), "the gate gets the run's own mounts, unchanged");
  } finally {
    h.restore();
  }
});

test("sandbox e2e: the gate's container gets the run's sandbox env (GIT_CONFIG_*) but no run-credential env (#710 review)", async () => {
  const credsDir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-run-creds-"));
  fs.mkdirSync(path.join(credsDir, "gh"));
  fs.writeFileSync(path.join(credsDir, "gh", "hosts.yml"), "github.com:\n  oauth_token: ghs_x\n");
  const runCredentials = async () => ({
    env: { GH_CONFIG_DIR: path.join(credsDir, "gh"), GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "credential.https://github.com.helper", GIT_CONFIG_VALUE_0: "!gh auth git-credential" },
    strip: ["GH_TOKEN", "GITHUB_TOKEN"],
    label: "GitHub App token: o/r, expires soon",
    dispose: async () => {},
  });
  const h = sandboxHarness([{ id: "code", createsWorktree: true, gate: "echo sandboxed-gate-ran", gateTimeoutMinutes: 1, env: { CLAUDE_CODE_OAUTH_TOKEN: "tok" } }, { id: "done", manual: true }], { runCredentials, agentEnvPassthrough: ["GITHUB_TOKEN"] });
  const savedToken = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = "ghp_operator_secret";
  try {
    await h.go("code");
    assert.equal(h.advanced[0]?.outcome, "advance", JSON.stringify(h.advanced));
    const runs = h.calls().filter(isAgentRun);
    assert.equal(runs.length, 2, "the agent's run, then the gate's own run");
    const [agentRun, gateRun] = runs;
    // Env reaches the container by NAME (`-e NAME`, src/sandbox/container.js); the gate's must carry
    // the run's git config pairs (safe.directory/identity — a gate that runs git in the container
    // needs them) while never carrying the per-run credential env (GH_CONFIG_DIR is creds' own,
    // merged into sandboxedRun.env by mergeGitConfigEnv) or the operator's GITHUB_TOKEN.
    const envNames = (/** @type {string[]} */ run) => {
      /** @type {string[]} */ const out = [];
      for (let i = 1; i < run.length - 1; i++) if (run[i] === "-e") out.push(run[i + 1].split("=")[0]);
      return out;
    };
    const gateEnv = envNames(gateRun);
    const agentEnv = envNames(agentRun);
    assert.ok(agentEnv.includes("GH_CONFIG_DIR"), "the agent's run carries the per-run credential dir");
    assert.ok(agentEnv.includes("GIT_CONFIG_COUNT"), "the agent's run carries the git config");
    assert.ok(!agentEnv.includes("GITHUB_TOKEN"), "the agent's run has the stripped token");
    assert.ok(gateEnv.includes("GIT_CONFIG_COUNT"), "the gate gets the run's git config pairs");
    assert.ok(gateEnv.some((n) => n.startsWith("GIT_CONFIG_KEY_")), "the git config KEY_n pairs are named");
    assert.ok(!gateEnv.includes("GH_CONFIG_DIR"), "the gate never sees the per-run credential dir");
    assert.ok(!gateEnv.includes("GITHUB_TOKEN"), "the gate never sees the operator's token");
  } finally {
    if (savedToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = savedToken;
    fs.rmSync(credsDir, { recursive: true, force: true });
    h.restore();
  }
});

test("sandbox e2e: sandbox:false spawns the agent directly on the host (shared verdict path)", async () => {
  const h = sandboxHarness([{ id: "code", sandbox: false }, { id: "done", manual: true }]);
  try {
    await h.go("code");
    assert.equal(h.advanced[0].outcome, "advance");
    assert.deepEqual(h.calls(), []);
    assert.match(h.innerOut()?.VF ?? "", /\/verdicts\/42-code\.json$/);
    assert.equal(h.innerOut()?.SSH, "/tmp/host-agent.sock", "an unsandboxed run keeps the receiver's env");
  } finally {
    h.restore();
  }
});

test("sandbox e2e: a claude step with no credential var is refused with the setup-token reason", async () => {
  const h = sandboxHarness([{ id: "code" }, { id: "done", manual: true }]);
  const keys = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX"];
  const saved = keys.map((k) => [k, process.env[k]]);
  for (const k of keys) delete process.env[k];
  try {
    await h.go("code");
    assert.equal(h.advanced[0].outcome, "fail");
    assert.match(h.advanced[0].reason, /sandboxed claude has no credentials — run `claude setup-token`/);
    assert.deepEqual(h.calls(), []);
  } finally {
    for (const [k, v] of saved) if (v !== undefined) process.env[/** @type {string} */ (k)] = v;
    h.restore();
  }
});

test("sandbox e2e: a cancel mid-run force-stops the container (`kill <id>`) and fails the run", async () => {
  const h = sandboxHarness([{ id: "code", env: { CLAUDE_CODE_OAUTH_TOKEN: "tok" } }, { id: "done", manual: true }], { inner: "#!/bin/sh\nexec sleep 30\n" });
  try {
    const done = h.go("code");
    // Wait for the fake client to be up (it logs first), not just spawned.
    for (let i = 0; i < 200 && !h.calls().some(isAgentRun); i++) await new Promise((r) => setTimeout(r, 25));
    assert.ok(h.store.listRunning()["42"]?.pid, "running");
    assert.equal(h.run.cancel("42"), true);
    await done;
    const run = h.calls().find(isAgentRun);
    const name = run[run.indexOf("--name") + 1];
    assert.ok(h.calls().some((c) => c[0] === "kill" && c[1] === name), JSON.stringify(h.calls().map((c) => c.slice(0, 2))));
    assert.equal(h.advanced[0].outcome, "fail");
    assert.equal(h.advanced[0].reason, "cancelled by operator");
  } finally {
    h.restore();
  }
});

test("sandbox e2e: a cancel landing before the spawn (wrap pending) never starts the container", async () => {
  const h = sandboxHarness([{ id: "code", env: { CLAUDE_CODE_OAUTH_TOKEN: "tok" } }, { id: "done", manual: true }], { inner: "#!/bin/sh\nexec sleep 30\n" });
  try {
    const done = h.go("code");
    assert.equal(h.run.cancel("42"), true, "flagged in the pre-spawn window");
    await done;
    assert.equal(h.calls().some(isAgentRun), false);
    assert.equal(h.advanced[0].outcome, "fail");
    assert.equal(h.advanced[0].reason, "cancelled by operator");
  } finally {
    h.restore();
  }
});

test("sandbox e2e: a worktree whose .git was rewritten by an earlier run is refused; nothing outside is mounted", async () => {
  const h = sandboxHarness([{ id: "review", env: { CLAUDE_CODE_OAUTH_TOKEN: "tok" } }, { id: "done", manual: true }]);
  const home = path.join(h.root, "operator-home");
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(h.root, "wts", "42", ".git"), `gitdir: ${home}\n`);
  try {
    await h.go("review");
    assert.equal(h.advanced[0].outcome, "fail");
    assert.match(h.advanced[0].reason, /^sandbox setup failed: worktree git metadata does not point into /);
    assert.deepEqual(h.calls(), [], "the runtime is never spawned");
  } finally {
    h.restore();
  }
});

test("sandbox e2e: a FIFO verdict file is dropped (no verdict), never opened — the receiver doesn't hang", { timeout: 20000 }, async () => {
  const h = sandboxHarness([{ id: "code", requireVerdict: false, env: { CLAUDE_CODE_OAUTH_TOKEN: "tok" } }, { id: "done", manual: true }], { inner: '#!/bin/sh\nmkfifo "$AGENTHOOK_VERDICT_FILE"\n' });
  try {
    await h.go("code");
    assert.equal(h.advanced[0].outcome, "advance", "a clean exit with no (readable) verdict");
    assert.equal(fs.existsSync(path.join(h.state, "verdicts", "run-42-code")), false);
  } finally {
    h.restore();
  }
});

test("sandbox e2e: an oversize verdict file is dropped unread", async () => {
  const big = `{"outcome":"hold","reason":"big"}` + " ".repeat(1024 * 1024 + 1);
  const h = sandboxHarness([{ id: "code", requireVerdict: false, env: { CLAUDE_CODE_OAUTH_TOKEN: "tok" } }, { id: "done", manual: true }], { inner: `#!/bin/sh\nhead -c ${big.length} /dev/zero | tr '\\0' ' ' > "$AGENTHOOK_VERDICT_FILE"\nprintf '%s' '{"outcome":"hold","reason":"big"}' | dd of="$AGENTHOOK_VERDICT_FILE" conv=notrunc status=none\n` });
  try {
    await h.go("code");
    assert.equal(h.advanced[0].outcome, "advance", "the hold verdict was never read");
  } finally {
    h.restore();
  }
});

// Review #481 pass 3: the common git dir is rw in the container, so an agent can plant a FIFO at
// `.git/HEAD` (or `packed-refs`). git then blocks on open forever; every synchronous host git call
// is time-capped so a wedged repo fails the read instead of freezing the receiver's event loop.
test("hostGitFacts: a FIFO at the common dir's HEAD fails the reads within the cap, never hangs", { timeout: 20000 }, () => {
  const { repo } = fixture();
  g(repo, ["config", "user.name", "op"]);
  assert.equal(hostGitFacts(repo).author.name, "op", "sanity: reads work on a healthy repo");
  const head = path.join(repo, ".git", "HEAD");
  fs.rmSync(head);
  execFileSync("mkfifo", [head]);
  const t0 = Date.now();
  const facts = hostGitFacts(repo, { timeoutMs: 500 });
  assert.ok(Date.now() - t0 < 10000, "returned within the cap, not blocked on the FIFO");
  assert.deepEqual(facts, { originUrl: undefined, author: { name: undefined, email: undefined } });
});

test("worktree host git calls are time-capped (a FIFO HEAD can't wedge listWorktrees forever)", () => {
  assert.ok(HOST_GIT_TIMEOUT_MS > 0 && HOST_GIT_TIMEOUT_MS <= 120_000);
  const { repo } = fixture();
  assert.ok(listWorktrees({}, repo).length >= 2, "sanity: the capped helper still works");
});
