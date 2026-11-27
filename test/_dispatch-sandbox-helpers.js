// Shared fixtures for the dispatch-sandbox-*.test.js files (split from the former
// dispatch-sandbox.test.js so no single test file costs ~40K tokens to read — see #717). Not
// matched by the `test/*.test.js` glob `npm test` runs, so it is never itself executed as a test file.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createDispatcher } from "../src/dispatch/index.js";
import { createStore } from "../src/store/index.js";
import { createSandbox } from "../src/sandbox/index.js";

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
/** @param {string} cwd @param {string[]} args */
export const g = (cwd, args) => execFileSync("git", args, { cwd, env: ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** A real `git worktree add`, used by the pure sandbox.js tests and the e2e harness alike. */
export function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ah-dsbx-")));
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  g(repo, ["init", "-q", "-b", "master"]);
  fs.writeFileSync(path.join(repo, "a"), "1");
  g(repo, ["add", "."]);
  g(repo, ["commit", "-qm", "one"]);
  const wt = path.join(root, "wts", "42");
  g(repo, ["worktree", "add", "-q", "-b", "agent/42", wt]);
  return { root, repo, wt };
}

// --- end to end through the real dispatcher, with $DOCKER pointing at a fake client ---
// The fake records its argv, and for `run` execs the inner `<bin> <args>` on the host in
// --workdir with only the `-e` names it was given (values from its own env) — like a runtime.

const FAKE_DOCKER = `#!/usr/bin/env node
import fs from "node:fs";
import { spawn } from "node:child_process";
const args = process.argv.slice(2);
fs.appendFileSync(process.env.DOCKER_FAKE_LOG, JSON.stringify(args) + "\\n");
if (args[0] !== "run") process.exit(0);
if (args[1] === "-d") {
  // The egress proxy: come up at once (ready), with any denials the test asked for.
  const m = args.find((a) => a.endsWith(",dst=/egress"));
  const dir = m && m.slice("type=bind,src=".length, -",dst=/egress".length);
  if (dir) {
    fs.writeFileSync(dir + "/ready", "3128");
    if (process.env.DOCKER_FAKE_DENY) fs.writeFileSync(dir + "/denied.jsonl", process.env.DOCKER_FAKE_DENY);
  }
  process.exit(0);
}
const valued = new Set(["--pull", "--name", "--label", "--cap-drop", "--security-opt", "--pids-limit", "--memory", "--cpus", "--user", "--mount", "--network"]);
const names = [];
let workdir;
let i = 1;
for (; i < args.length; i++) {
  const a = args[i];
  if (a === "-e") names.push(args[++i]);
  else if (a === "--workdir") workdir = args[++i];
  else if (valued.has(a)) i++;
  else if (!a.startsWith("-")) break;
}
const [, bin, ...rest] = args.slice(i);
const env = { PATH: process.env.PATH };
for (const n of names) {
  const eq = n.indexOf("=");
  if (eq > 0) env[n.slice(0, eq)] = n.slice(eq + 1);
  else if (process.env[n] !== undefined) env[n] = process.env[n];
}
const child = spawn(bin, rest, { cwd: workdir, env, stdio: "inherit" });
process.on("SIGTERM", () => child.kill("SIGTERM"));
child.on("exit", (code) => process.exit(code ?? 1));
`;

/** The agent's `run` (not the egress proxy's `run -d`). @param {string[]} c */
export const isAgentRun = (c) => c[0] === "run" && c[1] !== "-d";

/** @param {any[]} steps @param {{inner?: string, forge?: any, sandbox?: any, runCredentials?: (o: any) => Promise<any>, agentEnvPassthrough?: string[]}} [o] */
export function sandboxHarness(steps, { inner, forge = null, sandbox = { type: "docker", image: "img:1" }, runCredentials, agentEnvPassthrough } = {}) {
  const { root, repo } = fixture();
  const state = path.join(root, "state");
  fs.mkdirSync(state);
  const docker = path.join(root, "fake-docker.mjs");
  fs.writeFileSync(docker, FAKE_DOCKER, { mode: 0o755 });
  const claude = path.join(root, "fake-claude.sh");
  const out = path.join(root, "inner.out");
  fs.writeFileSync(
    claude,
    inner ??
      `#!/bin/sh\nprintf 'VF=%s\\nSSH=%s\\nTOKEN=%s\\nPWD=%s\\nNOAUTO=%s\\nGITCOUNT=%s\\nGHCFG=%s\\nGHTOK=%s\\n' "$AGENTHOOK_VERDICT_FILE" "\${SSH_AUTH_SOCK-unset}" "\${CLAUDE_CODE_OAUTH_TOKEN-unset}" "$(pwd)" "\${DISABLE_AUTOUPDATER-unset}" "\${GIT_CONFIG_COUNT-unset}" "\${GH_CONFIG_DIR-unset}" "\${GITHUB_TOKEN-unset}" > "${out}"\nprintf '%s' '{"outcome":"advance","reason":"ok"}' > "$AGENTHOOK_VERDICT_FILE"\n`,
    { mode: 0o755 },
  );
  const log = path.join(root, "docker.log");
  const cfg = /** @type {any} */ ({
    pipeline: steps, claudeBin: claude, repoPath: repo, worktreePrefix: path.join(root, "wts"),
    stateKey: "p", stateDir: state, dataDir: state, logDir: state, instructionsFile: path.join(root, "none.md"),
    sandbox,
    ...(agentEnvPassthrough ? { agentEnvPassthrough } : {}),
  });
  /** @type {any[]} */
  const advanced = [];
  const adapter = /** @type {any} */ ({
    describe: () => ({ platform: "GitHub", taskNoun: "issue", trigger: "@agent", commentHowTo: "comment", egressHosts: ["api.tracker.test"] }),
    fetchTask: async (/** @type {string} */ ref) => ({ ref, name: "t", description: "d", url: "u", completed: false, assignedToUs: true }),
    advance: async (/** @type {string} */ ref, /** @type {string} */ step, /** @type {any} */ v) => void advanced.push({ ref, step, ...v }),
    ...(runCredentials ? { runCredentials } : {}),
  });
  const saved = { DOCKER: process.env.DOCKER, DOCKER_FAKE_LOG: process.env.DOCKER_FAKE_LOG, DOCKER_FAKE_DENY: process.env.DOCKER_FAKE_DENY, HOME: process.env.HOME, SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK };
  process.env.DOCKER = docker;
  process.env.DOCKER_FAKE_LOG = log;
  process.env.HOME = path.join(root, "home"); // claude's transcript dir is created under it
  process.env.SSH_AUTH_SOCK = "/tmp/host-agent.sock";
  const restore = () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  const store = createStore(state);
  /** @type {{event: string, ref: string, stepId: string, data: any}[]} */
  const events = [];
  const emit = (/** @type {string} */ event, /** @type {string} */ ref, /** @type {string} */ stepId, /** @type {any} */ data) => void events.push({ event, ref, stepId, data });
  const run = createDispatcher(cfg, adapter, undefined, store, emit, forge, undefined, { killGraceMs: 200, sandbox: createSandbox(cfg) });
  /** @param {string} stepId @param {Partial<import('../src/types/index.js').Job>} [extra] */
  const go = async (stepId, extra) => {
    const l = console.log;
    console.log = () => {};
    try {
      await run({ kind: "pipeline", ref: "42", stepId, dedupKey: `k:${stepId}`, ...extra });
    } finally {
      console.log = l;
    }
  };
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
  const innerOut = () => (fs.existsSync(out) ? Object.fromEntries(fs.readFileSync(out, "utf8").trim().split("\n").map((l) => /** @type {[string, string]} */ (l.split(/=(.*)/s).slice(0, 2)))) : null);
  return { root, repo, state, cfg, run, go, store, advanced, calls, innerOut, restore, events };
}
