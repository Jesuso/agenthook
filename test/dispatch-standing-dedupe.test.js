import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// #731: a sandboxed opencode run writes the step's standing instructions to an `instructions`
// file (agenthook-standing.md) that survives compaction — dispatch must then drop the same text
// from the run prompt, or the model sees it twice. This exercises the real dispatcher end to
// end with a fake `Sandbox` (no docker) so the args/files `wrap()` actually receives are visible.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createDispatcher } from "../src/dispatch.js";
import { createStore } from "../src/store.js";
import { promptPathFor } from "../src/dispatch/prompt.js";

function gitRepo() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ah-standing-")));
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  const g = (/** @type {string[]} */ args) => execFileSync("git", args, { cwd: repo, env, stdio: ["ignore", "pipe", "pipe"] });
  g(["init", "-q", "-b", "master"]);
  fs.writeFileSync(path.join(repo, "a"), "1");
  g(["add", "."]);
  g(["commit", "-qm", "one"]);
  return { root, repo };
}

/** A fake opencode CLI: writes its own argv + the AGENTHOOK_VERDICT_FILE verdict. No network. */
const FAKE_OPENCODE = `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
fs.writeFileSync(process.env.CAPTURE_ARGS, JSON.stringify(args));
fs.writeFileSync(process.env.AGENTHOOK_VERDICT_FILE, JSON.stringify({ outcome: "advance" }));
`;

/** @param {{instructionsText?: string, sandboxed?: boolean}} [o] */
function fixture({ instructionsText, sandboxed = true } = {}) {
  const { root, repo } = gitRepo();
  const state = path.join(root, "state");
  fs.mkdirSync(state);
  const opencodeBin = path.join(root, "opencode.mjs");
  fs.writeFileSync(opencodeBin, FAKE_OPENCODE, { mode: 0o755 });
  const instructionsFile = path.join(root, "standing.md");
  fs.writeFileSync(instructionsFile, instructionsText ?? "STANDING-TEXT-MARKER: do the minimal change.\n");
  const cfg = /** @type {any} */ ({
    pipeline: [{ id: "code", bin: opencodeBin }, { id: "done", manual: true }],
    agent: "opencode",
    ...(sandboxed ? { sandbox: { type: "docker" } } : {}),
    repoPath: repo,
    worktreePrefix: path.join(root, "wts"),
    stateKey: "p",
    dataDir: state,
    logDir: state,
    instructionsFile,
    agentEnvPassthrough: ["CAPTURE_ARGS"],
  });
  /** @type {any[]} */
  const wrapCalls = [];
  const fakeSandbox = {
    describe: () => ({ name: "fake", home: "/home/agent" }),
    check: async () => ({ ok: true }),
    wrap: async (/** @type {any} */ o) => {
      wrapCalls.push(o);
      return { bin: o.bin, args: o.args, env: o.env, id: "", kill: async () => {}, done: async () => ({}) };
    },
    reap: async () => ({ containers: [], networks: [], runs: [] }),
  };
  const adapter = /** @type {any} */ ({
    describe: () => ({ platform: "GitHub", taskNoun: "issue", trigger: "@agent", commentHowTo: "comment" }),
    fetchTask: async (/** @type {string} */ ref) => ({ ref, name: "t", description: "d", url: "u", completed: false, assignedToUs: true }),
    advance: async () => {},
  });
  const store = createStore(state);
  const run = createDispatcher(cfg, adapter, undefined, store, () => {}, null, undefined, sandboxed ? { sandbox: fakeSandbox } : {});
  const captureFile = path.join(root, "args.json");
  /** @param {string} ref */
  const go = async (ref) => {
    process.env.CAPTURE_ARGS = captureFile;
    const log = console.log;
    console.log = () => {};
    try {
      return await run({ kind: "pipeline", ref, stepId: "code", dedupKey: `k:${ref}` });
    } finally {
      console.log = log;
      delete process.env.CAPTURE_ARGS;
    }
  };
  const readArgs = () => JSON.parse(fs.readFileSync(captureFile, "utf8"));
  /** @param {string} ref */
  const readPromptSidecar = (/** @type {string} */ ref) => {
    const logFile = fs.readdirSync(state).find((f) => f.endsWith(`-${ref}.log`));
    return fs.readFileSync(promptPathFor(path.join(state, logFile)), "utf8");
  };
  return { root, state, go, readArgs, readPromptSidecar, wrapCalls, instructionsFile };
}

test("sandboxed opencode run: standing goes to the instructions file, not the run prompt — dropped from argv, kept in the UI sidecar", async () => {
  const h = fixture();
  await h.go("one");
  const [call] = h.wrapCalls;
  assert.equal(call.files.some((/** @type {any} */ f) => f.dst.endsWith("agenthook-standing.md") && f.content.includes("STANDING-TEXT-MARKER")), true, "standing written as an instructions file");

  const args = h.readArgs();
  const prompt = args.at(-1);
  assert.doesNotMatch(prompt, /STANDING-TEXT-MARKER/, "standing text dropped from the run prompt");
  assert.match(prompt, /=== TICKET ===/, "the === TICKET === marker survives the dedupe");

  const sidecar = h.readPromptSidecar("one");
  assert.match(sidecar, /STANDING-TEXT-MARKER/, "the UI sidecar keeps the full standing + marker + ticket form");
  assert.match(sidecar, /=== TICKET ===/);

  // Acceptance: a sandboxed run's total bytes (prompt + instruction files) drop by the standing
  // length compared with sending it in both places. Measured against the UI sidecar, which still
  // holds the full `standing + "\n\n" + marker + ticket` form — not the already-deduped prompt,
  // which would make this an identity. Reverting the dedupe in step.js makes this fail.
  const standing = fs.readFileSync(h.instructionsFile, "utf8").trim();
  const filesBytes = call.files.reduce((/** @type {number} */ n, /** @type {any} */ f) => n + Buffer.byteLength(f.content, "utf8"), 0);
  const sentBytes = Buffer.byteLength(prompt, "utf8") + filesBytes;
  assert.equal(Buffer.byteLength(sidecar, "utf8") + filesBytes - sentBytes, Buffer.byteLength(standing + "\n\n", "utf8"), "deduped run sends exactly one standing-length fewer bytes than the doubled form");
});

test("sandboxed opencode run: standing over 16 KB stays only in the run prompt (no file, no dedupe)", async () => {
  const h = fixture({ instructionsText: "STANDING-TEXT-MARKER: " + "x".repeat(16 * 1024) });
  await h.go("two");
  const [call] = h.wrapCalls;
  assert.equal(call.files.some((/** @type {any} */ f) => f.dst.endsWith("agenthook-standing.md")), false, "no standing file over the cap");
  const args = h.readArgs();
  const prompt = args.at(-1);
  assert.match(prompt, /STANDING-TEXT-MARKER/, "standing text stays in the run prompt when it's over the cap");
  assert.match(prompt, /=== TICKET ===/);
});

test("host (unsandboxed) opencode run: standing stays in the run prompt, no instructions file", async () => {
  const h = fixture({ sandboxed: false });
  await h.go("three");
  assert.equal(h.wrapCalls.length, 0, "a host run never goes through the sandbox wrap");
  const args = h.readArgs();
  const prompt = args.at(-1);
  assert.match(prompt, /STANDING-TEXT-MARKER/, "standing text stays in the host run prompt");
  assert.match(prompt, /=== TICKET ===/);
});
