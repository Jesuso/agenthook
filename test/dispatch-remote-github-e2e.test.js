import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// #826, phase 5b end-to-end: a REMOTE (ssh) run under the REAL github tracker — the worker
// holds no tracker/forge credentials, so the prompt embeds the ticket's comments (fetched on
// the hub by the adapter's fetchComments), the agent commits and writes the outbox, and the
// hub publishes with its own credentials (fake forge records the calls) and mints NO per-run
// credentials. Mirrors the harnesses in test/dispatch-executor-ssh-pipeline.test.js and
// test/dispatch-publish-e2e.test.js (fake ssh double, real dispatcher).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { withFakeSsh, initGitRepo } from "./_ssh-helpers.js";
import { adapter, pipeline } from "./_github-helpers.js";
import { stubFetch } from "./_forge-helpers.js";
import { createDispatcher } from "../src/dispatch.js";
import { createStore } from "../src/store.js";

const REF = "55";

/** The fake worker agent: captures the prompt (stdin), commits a file, writes the outbox
 * (pr.json next to the verdict, where the worker's done() copies it back) and the verdict. */
function agentScript(promptCap) {
  return [
    "#!/bin/sh",
    `cat > ${JSON.stringify(promptCap)}`,
    `printf '{"type":"result","session_id":"s1","result":"ok"}\\n'`,
    "git config user.email t@t.t",
    "git config user.name t",
    'echo "the fix" > fix.txt',
    "git add fix.txt",
    "git commit -q -m \"the fix\"",
    `d="$(dirname "$AGENTHOOK_VERDICT_FILE")"`,
    `mkdir -p "$d/outbox"`,
    `printf %s '{"title":"Fix the flaky test","body":"**GitHub:** https://github.com/o/r/issues/55\\n\\ndid it"}' > "$d/outbox/pr.json"`,
    `printf %s '{"outcome":"advance","reason":"done","summary":{"plain":"done"}}' > "$AGENTHOOK_VERDICT_FILE"`,
    "exit 0",
    ``,
  ].join("\n");
}

function harness({ status = 200, json, headers } = { status: 200, json: [], headers: {} }) {
  const ssh = withFakeSsh();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-remote-gh-"));
  const repoDir = path.join(dir, "repo");
  const workDir = path.join(dir, "work");
  fs.mkdirSync(workDir, { recursive: true });
  initGitRepo(repoDir);
  const promptCap = path.join(dir, "prompt.md");
  const agentScriptPath = path.join(workDir, "agent.sh");
  const cfg = /** @type {any} */ ({
    pipeline: [
      { id: "code", harness: "worker", createsWorktree: true, sourceLabel: "agent:code", successLabel: "agent:review" },
      { id: "done", manual: true },
    ],
    repoPath: repoDir,
    worktreePrefix: path.join(dir, "wt"),
    stateKey: "p",
    stateDir: dir,
    dataDir: dir,
    logDir: dir,
    instructionsFile: path.join(dir, "none.md"),
    harnesses: { worker: { remote: { host: "worker.test", workDir, bin: agentScriptPath } } },
  });
  const store = createStore(dir);
  /** @type {any[]} */
  const advanced = [];
  /** @type {any[]} */
  const events = [];
  /** @type {any[][]} */
  const pushedArgs = [];
  /** @type {any[][]} */
  const prArgs = [];
  /** @type {any[][]} */
  const credCalls = [];
  // The REAL github adapter (fetchComments included) against a stubbed REST API.
  const gh = /** @type {any} */ (adapter({ assigneeLogin: "octo" }));
  const realAdvance = gh.advance.bind(gh);
  gh.advance = async (/** @type {string} */ ref, /** @type {string} */ stepId, /** @type {any} */ verdict) => {
    advanced.push({ ref, stepId, ...verdict });
    return realAdvance(ref, stepId, verdict);
  };
  const stub = stubFetch({
    [`GET /repos/o/r/issues/${REF}`]: {
      status: 200,
      json: {
        number: Number(REF),
        title: "Fix the flaky test",
        body: "make it stop",
        state: "open",
        html_url: `https://github.com/o/r/issues/${REF}`,
        labels: [{ name: "agent:code" }],
        user: { login: "alice" },
        assignee: null,
      },
    },
    [`GET /repos/o/r/issues/${REF}/comments?per_page=100`]: { status, json, headers },
    [`POST /repos/o/r/issues/${REF}/labels`]: { status: 200, json: [] },
    [`DELETE /repos/o/r/issues/${REF}/labels/agent:code`]: { status: 404 },
  });
  const forge = /** @type {any} */ ({
    describe: () => ({ name: "github" }),
    runCredentials: async (/** @type {any} */ o) => { credCalls.push(["forge", o?.ref]); return { label: "forge-cred" }; },
    publishBranch: async (/** @type {any} */ a) => { pushedArgs.push(a); return { pushed: [`origin/agent/${REF}`] }; },
    openPr: async (/** @type {any} */ a) => { prArgs.push(a); return { number: 31, created: true }; },
  });
  const run = createDispatcher(cfg, gh, undefined, store, (event, ref, step, extra) => events.push({ event, ref, step, ...extra }), forge);
  const runStep = async () => {
    fs.writeFileSync(agentScriptPath, agentScript(promptCap), { mode: 0o755 });
    const log = console.log;
    console.log = () => {};
    try {
      await run({ kind: "pipeline", ref: REF, stepId: "code", dedupKey: `k:code`, harness: "worker" });
    } finally {
      console.log = log;
    }
  };
  return { ssh, stub, store, advanced, events, pushedArgs, prArgs, credCalls, promptCap, runStep, dir };
}

const COMMENTS = [
  { user: { login: "octo" }, body: "use the new helper", created_at: "2025-01-02T10:00:00Z" },
  { user: { login: "alice" }, body: "sounds good", created_at: "2025-01-03T11:00:00Z" },
];

test("remote (ssh) run under the github tracker: the prompt embeds the ticket's comments (newest first, owner-flagged), the hub publishes the outbox with its own credentials and mints none for the run", async () => {
  const h = harness({ json: COMMENTS });
  try {
    await h.runStep();
    const p = fs.readFileSync(h.promptCap, "utf8");
    // The embedded thread: fenced, newest first, owner-flagged.
    assert.match(p, /<<<UNTRUSTED TICKET_COMMENTS /);
    assert.ok(p.indexOf("sounds good") < p.indexOf("use the new helper"), "newest first");
    assert.match(p, /@octo  2025-01-02T10:00:00Z  OWNER/);
    assert.match(p, /@alice  2025-01-03T11:00:00Z  not owner/);
    // The worker is told off gh/push — outbox contract instead.
    assert.doesNotMatch(p, /gh issue view/);
    assert.doesNotMatch(p, /gh issue comment/);
    assert.match(p, /=== RUN CONSTRAINTS/);
    assert.match(p, /outbox\/pr\.json/);
    assert.match(p, /\*\*GitHub:\*\* https:\/\/github.com\/o\/r\/issues\/55/);
    // The hub published the outbox with its own credentials and advanced the issue.
    assert.equal(h.pushedArgs.length, 1, "the hub pushed the worker's commit");
    assert.equal(h.pushedArgs[0].branch, `agent/${REF}`);
    assert.equal(h.prArgs.length, 1, "the hub opened the PR from the outbox");
    assert.equal(h.prArgs[0].title, "Fix the flaky test");
    assert.match(h.prArgs[0].body, /\*\*GitHub:\*\* https:\/\/github.com\/o\/r\/issues\/55/);
    assert.deepEqual(h.advanced.map((a) => a.outcome), ["advance"]);
    // The label move went out over the (stubbed) API — the real adapter's advance ran.
    const labelPost = h.stub.calls.find((c) => c.url.endsWith(`/issues/${REF}/labels`) && c.method === "POST");
    assert.ok(labelPost, "the success label was added");
    assert.deepEqual(labelPost.body, { labels: ["agent:review"] });
    // No per-run credentials minted — the worker holds no tracker/forge access.
    assert.equal(h.credCalls.length, 0, `no runCredentials for a remote run: ${JSON.stringify(h.credCalls)}`);
    const codeLogs = fs.readdirSync(h.dir).filter((f) => /step-code-55\.log$/.test(f));
    assert.ok(codeLogs.length > 0);
    assert.match(fs.readFileSync(path.join(h.dir, codeLogs[codeLogs.length - 1]), "utf8"), /no per-run credentials minted/);
  } finally {
    h.stub.restore();
    h.ssh.restore();
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});

test("remote (ssh) run: a comment fetch FAILURE lands as a notice in the prompt — the run still goes ahead and publishes", async () => {
  const h = harness({ status: 500, json: { message: "boom" } });
  try {
    await h.runStep();
    const p = fs.readFileSync(h.promptCap, "utf8");
    // The failure lands as a notice inside the TICKET_COMMENTS block — not a run failure.
    assert.match(p, /<<<UNTRUSTED TICKET_COMMENTS [0-9a-f]+>>>\ncomments could not be loaded; hold if you need them\n<<<END UNTRUSTED TICKET_COMMENTS [0-9a-f]+>>>/);
    assert.doesNotMatch(p, /@\S+  20\d\d-\d\d-\d\dT\d\d:\d\d/); // no comment entries rendered
    assert.equal(h.pushedArgs.length, 1, "the run still publishes its outbox");
    assert.deepEqual(h.advanced.map((a) => a.outcome), ["advance"]);
  } finally {
    h.stub.restore();
    h.ssh.restore();
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});
