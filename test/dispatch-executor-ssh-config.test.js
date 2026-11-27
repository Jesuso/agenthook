import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// The ssh executor (#689, experimental): shQuote/framePayload/remoteEnvAllowlist unit coverage,
// remoteProbeArgv (doctor, #691), executorFor/createExecutors wiring, and the config refusals.
// Split from dispatch-executor-ssh.test.js (see #717-style splits) — these are the pieces that
// don't need the fake-ssh/fake-agent end-to-end fixtures.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { shQuote, framePayload, remoteEnvAllowlist, remoteProbeArgv } from "../src/dispatch/executor-ssh.js";
import { createExecutors, executorFor, reapAll } from "../src/dispatch/executor.js";
import { validateRawConfig, REMOTE_TRACKERS } from "../src/config/index.js";
import { createGithubAdapter } from "../src/trackers/github.js";
import { createGithubProjectsAdapter } from "../src/trackers/github-projects.js";

// --- shQuote ---

test("shQuote: round-trips spaces, quotes, $, backticks, newlines and empty strings through a real shell", () => {
  for (const s of ["", "a b", "it's", "$HOME", "`cmd`", "line1\nline2", "a'b'c", "  leading/trailing  "]) {
    const out = execFileSync("sh", ["-c", `printf %s ${shQuote(s)}`], { encoding: "utf8" });
    assert.equal(out, s, `roundtrip failed for ${JSON.stringify(s)}`);
  }
});

// --- remoteEnvAllowlist ---

test("remoteEnvAllowlist: keeps AGENTHOOK_* and drops every forbidden family", () => {
  const env = {
    AGENTHOOK_VERDICT_FILE: "/x/verdict.json",
    AGENTHOOK_RUN_ID: "42-code",
    GH_TOKEN: "tracker-token",
    GITHUB_TOKEN: "forge-token",
    // the per-run GitHub App token family (github/run-token.js runGitEnv()/GH_CONFIG_DIR) — real
    // key names, real values, so a prefix match against "AGENTHOOK_" can't accidentally pass.
    GH_CONFIG_DIR: "/tmp/run-gh-config",
    GIT_CONFIG_COUNT: "4",
    GIT_CONFIG_KEY_0: "credential.https://github.com.helper",
    GIT_CONFIG_VALUE_0: "!gh auth git-credential",
    GIT_TERMINAL_PROMPT: "0",
    ANTHROPIC_API_KEY: "sk-leak",
    ANTHROPIC_BASE_URL: "https://leak.test",
    CLAUDE_CODE_OAUTH_TOKEN: "leak",
    SSH_AUTH_SOCK: "/tmp/agent.sock",
    SOME_HARNESS_ENV_KEY: "not-on-the-list",
  };
  const out = remoteEnvAllowlist(env);
  assert.equal(out.AGENTHOOK_VERDICT_FILE, "/x/verdict.json");
  assert.equal(out.AGENTHOOK_RUN_ID, "42-code");
  for (const forbidden of [
    "GH_TOKEN", "GITHUB_TOKEN", "GH_CONFIG_DIR", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0",
    "GIT_TERMINAL_PROMPT", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_OAUTH_TOKEN", "SSH_AUTH_SOCK", "SOME_HARNESS_ENV_KEY",
  ]) {
    assert.ok(!(forbidden in out), `${forbidden} should have been dropped`);
  }
});

test("remoteEnvAllowlist: the App-auth credential family (GH_TOKEN/GITHUB_TOKEN/GH_CONFIG_DIR) never crosses to the worker payload, even when the hub has it in the spawn env (#826)", () => {
  // A hub under GitHub App auth builds a spawn env with the per-run token family; the frame the
  // worker receives is allowlisted — prove none of the family is in the payload itself.
  const spawnEnv = {
    GH_TOKEN: "ghp_app-tracker",
    GITHUB_TOKEN: "ghp_app-forge",
    GH_CONFIG_DIR: "/tmp/run-gh-config",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "credential.https://github.com.helper",
    GIT_CONFIG_VALUE_0: "!gh auth git-credential",
    AGENTHOOK_VERDICT_FILE: "/w/state/verdicts/run-1-code/verdict.json",
  };
  const payload = framePayload(remoteEnvAllowlist(spawnEnv), "prompt");
  for (const k of ["GH_TOKEN", "GITHUB_TOKEN", "GH_CONFIG_DIR", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"]) {
    assert.ok(!payload.includes(`${k}=`), `${k} crossed the allowlist into the payload`);
  }
  assert.ok(payload.includes(`AGENTHOOK_VERDICT_FILE=${spawnEnv.AGENTHOOK_VERDICT_FILE}`), "the verdict path crosses");
});

test("remoteEnvAllowlist: TERM/LANG/CI come from the receiver's own env, not the input", () => {
  const saved = { TERM: process.env.TERM, LANG: process.env.LANG, CI: process.env.CI };
  process.env.TERM = "xterm-ssh-test";
  process.env.LANG = "en_US.UTF-8";
  process.env.CI = "true";
  try {
    const out = remoteEnvAllowlist({ TERM: "ignored-input-value" });
    assert.equal(out.TERM, "xterm-ssh-test");
    assert.equal(out.LANG, "en_US.UTF-8");
    assert.equal(out.CI, "true");
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

// --- framePayload ---

test("framePayload: a byte-length-prefixed prompt round-trips arbitrary bytes (quotes, $, backticks, newlines, unicode)", () => {
  const prompt = "ticket: it's a $weird `prompt`\nwith a newline and emoji 🎉 and a trailing '";
  const payload = framePayload({ AGENTHOOK_VERDICT_FILE: "/x/v.json" }, prompt);
  const [header, rest] = [payload.split("\n")[0], payload.slice(payload.indexOf("\n") + 1)];
  assert.equal(header, "1");
  assert.ok(rest.startsWith("AGENTHOOK_VERDICT_FILE=/x/v.json\n"));
  const afterEnv = rest.slice("AGENTHOOK_VERDICT_FILE=/x/v.json\n".length);
  const plen = Number(afterEnv.split("\n")[0]);
  assert.equal(plen, Buffer.byteLength(prompt, "utf8"));
  const promptBytes = afterEnv.slice(afterEnv.indexOf("\n") + 1);
  assert.equal(promptBytes, prompt);
});

// --- reapAll ---

test("reapAll: one executor throwing doesn't block reaping the rest", async () => {
  const calls = [];
  const bad = { name: "ssh", reap: async () => { throw new Error("unreachable"); } };
  const good = { name: "ssh", reap: async () => (calls.push("good"), { containers: [], networks: [], runs: ["ok"] }) };
  const result = await reapAll({ ssh: { bad, good } });
  assert.deepEqual(calls, ["good"]);
  assert.deepEqual(result.runs, ["ok"]);
});

// --- executorFor ---

test("executorFor: a remote harness's ssh executor wins over the profile's sandbox", () => {
  const sshExec = { name: "ssh", paths: () => ({}), launch: async () => ({}) };
  const executors = { host: { name: "host" }, sandbox: { name: "sandbox" }, ssh: { remote1: sshExec } };
  assert.equal(executorFor({ sandbox: { type: "docker" } }, { id: "code" }, "remote1", executors), sshExec);
  assert.equal(executorFor({ sandbox: { type: "docker" } }, { id: "code" }, "other", executors).name, "sandbox");
  assert.equal(executorFor({}, { id: "code" }, "remote1", { host: { name: "host" } }).name, "host", "no ssh executor built -> host");
});

test("createExecutors: builds one ssh executor per harness with a remote block; none without any", () => {
  const spawnPaths = { verdictPathFor: () => "/v", sandboxVerdictPathFor: () => "/sv" };
  const cfg = { stateKey: "p", harnesses: { a: { remote: { host: "h", workDir: "/w" } }, b: {} } };
  const executors = createExecutors({ cfg, sandbox: null, spawnPaths });
  assert.deepEqual(Object.keys(executors.ssh), ["a"]);
  const noneRemote = createExecutors({ cfg: { stateKey: "p", harnesses: { b: {} } }, sandbox: null, spawnPaths });
  assert.equal(noneRemote.ssh, undefined);
});

// --- config refusals ---

function baseConfig(overrides = {}) {
  return {
    name: "p",
    tracker: { type: "local", pipeline: [{ id: "code", harness: "worker" }] },
    repoPath: "/repo",
    harnesses: { worker: { remote: { host: "h", workDir: "/w" } } },
    ...overrides,
  };
}

// #826: the remote tracker set — a worker can work from a tracker whose adapter serves the
// ticket's comments to the hub (the worker holds none of its own credentials). Any step kind
// is fine; a remote entry in a routing list is fine.
const APP_AUTH = { type: "app", appId: "1", installationId: "2", privateKey: "x" };

for (const trackerType of ["github", "github-projects"]) {
  for (const kind of ["triage", "implement", "review"]) {
    test(`config: a ${trackerType} tracker with a remote harness validates on a ${kind} step (#826)`, () => {
      const v = validateRawConfig(baseConfig({ tracker: { type: trackerType, pipeline: [{ id: kind, kind, harness: "worker" }] } }));
      assert.equal(v.ok, true, v.ok ? "" : v.errors.join("\n"));
    });
  }
}

test("config: GitHub App auth (tracker or forge) with a remote harness validates — no per-run token is minted for the worker (#826)", () => {
  for (const where of ["tracker", "forge"]) {
    const tracker = { type: "github", pipeline: [{ id: "code", harness: "worker" }], assigneeLogin: "octo" };
    const cfg = where === "tracker"
      ? baseConfig({ tracker: { ...tracker, auth: APP_AUTH } })
      : baseConfig({ tracker, forge: APP_AUTH });
    const v = validateRawConfig(cfg);
    assert.equal(v.ok, true, `${where} app auth: ${v.ok ? "" : v.errors.join("\n")}`);
    assert.ok(!(v.errors ?? []).some((e) => e.includes("per-run")), 'the old per-run refusal is gone');
  }
});

test("config: a remote entry in a first-free routing list still validates (#826)", () => {
  const cfg = baseConfig({
    tracker: { type: "github", pipeline: [{ id: "code", harness: ["worker", "host1"], routing: "first-free" }] },
    harnesses: { worker: { remote: { host: "h", workDir: "/w" } }, host1: {} },
  });
  const v = validateRawConfig(cfg);
  assert.equal(v.ok, true, v.ok ? "" : v.errors.join("\n"));
});

test("config refusal: a remote harness used by a sandboxed step", () => {
  const cfg = baseConfig({ sandbox: { type: "docker" } });
  const v = validateRawConfig(cfg);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes("remote harness") && e.includes("sandboxed")), v.errors.join("\n"));
});

test("config refusal: a remote harness resolving to a non-claude agent", () => {
  const cfg = baseConfig({ harnesses: { worker: { agent: "cursor", remote: { host: "h", workDir: "/w" } } } });
  const v = validateRawConfig(cfg);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes('resolves to agent "cursor"')), v.errors.join("\n"));
});

test("config: a remote harness on a tracker type the set doesn't cover is refused, naming the missing comment capability (#826)", () => {
  const cfg = baseConfig({ tracker: { type: "jira", pipeline: [{ id: "code", harness: "worker" }] } });
  const v = validateRawConfig(cfg);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes('"tracker.type" is "jira"') && e.includes("fetchComments")), v.errors.join("\n"));
});

// Consistency (ticket #826): every REMOTE_TRACKERS entry other than "local" must name a tracker
// whose factory actually ships fetchComments — the set is what makes a remote run's prompt
// carry the ticket's comments, so a member that can't serve them is a broken promise.
test("REMOTE_TRACKERS: every non-local entry has an adapter with fetchComments", () => {
  /** @type {Record<string, any>} */
  const factories = {
    github: createGithubAdapter({ trigger: "@agent", pipeline: [], providerConfig: { type: "github", token: "t", repository: "o/r", assigneeFilter: false } }, /** @type {any} */ ({ hasSeen: () => false })),
    "github-projects": createGithubProjectsAdapter({ trigger: "@agent", pipeline: [], providerConfig: { type: "github-projects", token: "t", project: "o/1", assigneeFilter: false } }, /** @type {any} */ ({ hasSeen: () => false })),
  };
  for (const t of REMOTE_TRACKERS) {
    if (t === "local") continue;
    assert.ok(factories[t], `no factory in the test for REMOTE_TRACKERS entry ${t}`);
    assert.equal(typeof factories[t].fetchComments, "function", `${t} adapter has fetchComments`);
  }
});

test("config: a remote harness on an unsandboxed, non-App-auth, claude, local-tracker step is accepted", () => {
  const v = validateRawConfig(baseConfig());
  assert.equal(v.ok, true, v.ok ? "" : v.errors.join("\n"));
});

// --- doctor: remoteProbeArgv (#691) ---

test("remoteProbeArgv: BatchMode=yes always present, never -A, carries port/identityFile/user, and shQuotes the remote script", () => {
  const remote = { host: "worker.test", port: 2222, identityFile: "/home/me/.ssh/k", user: "agenthook", workDir: "/w" };
  const argv = remoteProbeArgv(remote, "echo hi");
  assert.ok(!argv.includes("-A"));
  const oIdx = argv.indexOf("-o");
  assert.equal(argv[oIdx + 1], "BatchMode=yes");
  const pIdx = argv.indexOf("-p");
  assert.equal(argv[pIdx + 1], "2222");
  const iIdx = argv.indexOf("-i");
  assert.equal(argv[iIdx + 1], "/home/me/.ssh/k");
  const lIdx = argv.indexOf("-l");
  assert.equal(argv[lIdx + 1], "agenthook");
  assert.equal(argv.at(-1), shQuote("echo hi"));
  assert.equal(argv.at(-2), shQuote("-c"));
  assert.equal(argv.at(-3), shQuote("sh"));
});
