import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// Dispatch — block gate re-checked at dispatch time, epic gate, done signal (#585),
// multi-repo routing, lookupPr, descriptionHasHeadings/promptPathFor, and the lite-model
// resolveModelEffort variant.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { resolveModelEffort, descriptionHasHeadings, lookupPr, createDispatcher, promptPathFor } from "../src/dispatch.js";
import { createStore } from "../src/store.js";
import { tmpDir } from "./_dispatch-helpers.js";

// --- block gate re-checked at dispatch time (queued jobs skip the webhook-time gate) ---

/** @param {string[]} [blockers] @param {any} [adapterOverrides] */
function blockHarness(blockers, adapterOverrides) {
  const dir = tmpDir();
  const bin = path.join(dir, "fake-claude.sh");
  fs.writeFileSync(bin, `#!/bin/sh\nprintf '%s' '{"outcome":"advance"}' > "$AGENTHOOK_VERDICT_FILE"\n`, { mode: 0o755 });
  const cfg = /** @type {any} */ ({
    pipeline: [{ id: "code" }, { id: "done", manual: true, drainWorktree: true }],
    claudeBin: bin,
    repoPath: dir,
    worktreePrefix: path.join(dir, "wt"),
    dataDir: dir,
    logDir: dir,
    instructionsFile: path.join(dir, "none.md"),
  });
  const store = createStore(dir);
  /** @type {any[]} */
  const advanced = [];
  const adapter = /** @type {any} */ ({
    describe: () => ({ platform: "GitHub", taskNoun: "issue", trigger: "@agent", commentHowTo: "comment" }),
    fetchTask: async (/** @type {string} */ ref) => ({ ref, name: "t", description: "d", url: "u", completed: false, assignedToUs: true }),
    advance: async (/** @type {string} */ ref, /** @type {string} */ stepId, /** @type {any} */ verdict) => advanced.push([ref, stepId, verdict.outcome]),
    ...(blockers !== undefined ? { openBlockers: async () => blockers } : {}),
    ...adapterOverrides,
  });
  const run = createDispatcher(cfg, adapter, undefined, store);
  /** @param {string} stepId @param {string} [dedupKey] */
  const runStep = async (stepId, dedupKey) => {
    const log = console.log;
    console.log = () => {};
    try {
      return await run({ kind: "pipeline", ref: "42", stepId, dedupKey: dedupKey ?? `k:${stepId}` });
    } finally {
      console.log = log;
    }
  };
  return { store, advanced, runStep };
}

test("dispatch: openBlockers returns blockers -> rests, no spawn/advance/attempt bump/lock", async () => {
  const { store, advanced, runStep } = blockHarness(["#1"]);
  const result = await runStep("code");
  assert.deepEqual(result, { kind: "pipeline", ref: "42", name: "t", url: "u", code: 0 });
  assert.equal(advanced.length, 0);
  assert.equal(store.getAttempt("42", "code"), 0);
  assert.equal(store.getLock("42"), undefined);
});

test("dispatch: openBlockers returns [] -> runs normally", async () => {
  const { advanced, runStep } = blockHarness([]);
  await runStep("code");
  assert.deepEqual(advanced[0], ["42", "code", "advance"]);
});

test("dispatch: adapter with no openBlockers -> runs normally (Jira/Projects/local unaffected)", async () => {
  const { advanced, runStep } = blockHarness(undefined);
  await runStep("code");
  assert.deepEqual(advanced[0], ["42", "code", "advance"]);
});

test("dispatch: openBlockers throwing fails open -> runs normally, no crash", async () => {
  const { advanced, runStep } = blockHarness(undefined, {
    openBlockers: async () => {
      throw new Error("boom");
    },
  });
  await runStep("code");
  assert.deepEqual(advanced[0], ["42", "code", "advance"]);
});

test("dispatch: a trigger: resume job is never gated, even with open blockers", async () => {
  const { advanced, runStep } = blockHarness(["#1"]);
  await runStep("code", "trigger:xyz");
  assert.deepEqual(advanced[0], ["42", "code", "advance"]);
});

test("dispatch: a manual step is not gated — the manual branch returns before the gate runs", async () => {
  const { runStep } = blockHarness(["#1"]);
  const result = await runStep("done");
  assert.equal(result.code, 0);
});

// --- epic gate: fetchTask().isEpic skips before any state mutation, for every step kind ---

/** @param {any[]} steps @param {any} [adapterOverrides] */
function epicHarness(steps, adapterOverrides) {
  const dir = tmpDir();
  const bin = path.join(dir, "fake-claude.sh");
  fs.writeFileSync(bin, `#!/bin/sh\nprintf '%s' '{"outcome":"advance"}' > "$AGENTHOOK_VERDICT_FILE"\n`, { mode: 0o755 });
  const cfg = /** @type {any} */ ({
    pipeline: steps,
    claudeBin: bin,
    repoPath: dir,
    worktreePrefix: path.join(dir, "wt"),
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
    fetchTask: async (/** @type {string} */ ref) => ({ ref, name: "epic t", url: "u", completed: false, assignedToUs: true, isEpic: true }),
    advance: async (/** @type {string} */ ref, /** @type {string} */ stepId, /** @type {any} */ verdict) => advanced.push([ref, stepId, verdict.outcome]),
    ...adapterOverrides,
  });
  const emit = (/** @type {string} */ event, /** @type {string} */ ref, /** @type {string} */ step, /** @type {any} */ extra) =>
    events.push({ event, ref, step, ...extra });
  const run = createDispatcher(cfg, adapter, undefined, store, emit);
  /** @param {string} stepId @param {string} [dedupKey] */
  const runStep = async (stepId, dedupKey) => {
    const log = console.log;
    console.log = () => {};
    try {
      return await run({ kind: "pipeline", ref: "42", stepId, dedupKey: dedupKey ?? `k:${stepId}` });
    } finally {
      console.log = log;
    }
  };
  return { store, advanced, events, runStep };
}

test("dispatch: an epic skips an agent step — no spawn/advance/attempt, one epic_skipped event", async () => {
  const { store, advanced, events, runStep } = epicHarness([{ id: "code" }, { id: "done", manual: true, drainWorktree: true }]);
  const result = await runStep("code");
  assert.deepEqual(result, { kind: "pipeline", ref: "42", name: "epic t", url: "u", code: 0 });
  assert.equal(advanced.length, 0, "adapter.advance never called");
  assert.equal(store.getAttempt("42", "code"), 0, "attempts.json untouched");
  assert.equal(store.getHeld("42"), undefined, "held.json untouched");
  assert.equal(store.getRefMeta("42"), undefined, "refmeta untouched");
  assert.deepEqual(
    events.map((e) => e.event),
    ["epic_skipped"],
    "no run_start/run_end/pipeline_done",
  );
  assert.equal(events[0].ref, "42");
  assert.equal(events[0].step, "code");
  assert.equal(events[0].name, "epic t");
  assert.equal(events[0].url, "u");
});

test("dispatch: an epic skips a manual drainWorktree step — no drain, no pipeline_done", async () => {
  const { advanced, events, runStep } = epicHarness([{ id: "done", manual: true, drainWorktree: true }]);
  const result = await runStep("done");
  assert.equal(result.code, 0);
  assert.equal(advanced.length, 0);
  assert.deepEqual(
    events.map((e) => e.event),
    ["epic_skipped"],
  );
});

test("dispatch: an epic skips an @agent (trigger:) resume job too", async () => {
  const { advanced, events, runStep } = epicHarness([{ id: "code" }, { id: "done", manual: true, drainWorktree: true }]);
  await runStep("code", "trigger:xyz");
  assert.equal(advanced.length, 0);
  assert.deepEqual(
    events.map((e) => e.event),
    ["epic_skipped"],
  );
});

// --- done signal (#585): entering ANY manual step emits board_done (via "stage") ---

test("dispatch: a manual step without drainWorktree emits nothing (the terminal stage is not done, ADR 0008); nothing moves", async () => {
  const notEpic = { fetchTask: async (/** @type {string} */ ref) => ({ ref, name: "t", url: "u", completed: false, assignedToUs: true }) };
  const { advanced, events, runStep } = epicHarness([{ id: "code" }, { id: "done", manual: true }], notEpic);
  const result = await runStep("done");
  assert.equal(result.code, 0);
  assert.equal(advanced.length, 0);
  assert.deepEqual(events, []);
});

test("dispatch: a manual step whose ticket is already closed on the board emits board_done (via flag)", async () => {
  const closed = { fetchTask: async (/** @type {string} */ ref) => ({ ref, name: "t", url: "u", completed: true, assignedToUs: true }) };
  const { events, runStep } = epicHarness([{ id: "code" }, { id: "done", manual: true }], closed);
  await runStep("done");
  assert.deepEqual(events, [{ event: "board_done", ref: "42", step: "done", via: "flag", name: "t", url: "u" }]);
});

test("dispatch: a drainWorktree manual step emits pipeline_done unchanged and no board_done", async () => {
  const notEpic = { fetchTask: async (/** @type {string} */ ref) => ({ ref, name: "t", url: "u", completed: false, assignedToUs: true }) };
  const { events, runStep } = epicHarness([{ id: "code" }, { id: "done", manual: true, drainWorktree: true }], notEpic);
  await runStep("done");
  assert.deepEqual(events, [
    { event: "pipeline_done", ref: "42", step: "done", name: "t", url: "u" },
  ]);
});

test("dispatch: pipeline_done carries awaitingMerge while auto-merge is on and the PR has not merged", async () => {
  const notEpic = { fetchTask: async (/** @type {string} */ ref) => ({ ref, name: "t", url: "u", completed: false, assignedToUs: true }) };
  const pending = epicHarness([{ id: "code" }, { id: "done", manual: true, drainWorktree: true }], notEpic);
  pending.store.setRefMeta("42", { autoMerge: { sha: "abc", pr: 9, step: "review", at: "2026-01-01T00:00:00.000Z" } });
  await pending.runStep("done");
  assert.deepEqual(pending.events, [{ event: "pipeline_done", ref: "42", step: "done", name: "t", url: "u", awaitingMerge: true, pr: 9 }]);
  const merged = epicHarness([{ id: "code" }, { id: "done", manual: true, drainWorktree: true }], notEpic);
  merged.store.setRefMeta("42", { autoMerge: { sha: "abc", pr: 9, step: "review", at: "2026-01-01T00:00:00.000Z" }, prState: "merged" });
  await merged.runStep("done");
  assert.deepEqual(merged.events, [{ event: "pipeline_done", ref: "42", step: "done", name: "t", url: "u" }], "the merge bridge's done move is a real finish");
});

// --- multi-repo routing: resolve → sticky → hold on ambiguity (no spawn) ---
// A fake `claude` records its cwd + prompt; steps create no worktree, so cwd = repo.path.

function routeHarness() {
  const dir = tmpDir();
  const mono = path.join(dir, "mono");
  const ios = path.join(dir, "ios");
  const android = path.join(dir, "android");
  for (const d of [mono, ios, android]) fs.mkdirSync(d);
  const iosInstr = path.join(dir, "IOS.md");
  fs.writeFileSync(iosInstr, "IOS REPO CONTEXT");
  const bin = path.join(dir, "fake-claude.sh");
  const out = path.join(dir, "out.txt");
  fs.writeFileSync(bin, `#!/bin/sh\npwd > "${out}"\nprintf '%s' "$2" >> "${out}"\nprintf '%s' '{"outcome":"advance"}' > "$AGENTHOOK_VERDICT_FILE"\n`, { mode: 0o755 });
  const cfg = /** @type {any} */ ({
    pipeline: [{ id: "code" }, { id: "review" }, { id: "done", manual: true, drainWorktree: true }],
    claudeBin: bin,
    repoPath: mono,
    multiRepo: true,
    repos: [
      { id: "mono", path: mono, match: ["backend"] },
      { id: "ios", path: ios, match: ["ios"], instructionsFile: iosInstr },
      { id: "android", path: android, match: ["android"] },
    ],
    dataDir: dir,
    logDir: dir,
    instructionsFile: path.join(dir, "none.md"),
  });
  const store = createStore(dir);
  /** @type {any[]} */
  const advanced = [];
  /** @type {any[]} */
  const events = [];
  /** @type {{routeKeys?: string[]}} */
  const task = {};
  const adapter = /** @type {any} */ ({
    describe: () => ({ platform: "GitHub", taskNoun: "issue", trigger: "@agent", commentHowTo: "comment", usesPR: false }),
    fetchTask: async (/** @type {string} */ ref) => ({ ref, name: "t", description: "d", url: "u", completed: false, assignedToUs: true, routeKeys: task.routeKeys }),
    advance: async (/** @type {string} */ ref, /** @type {string} */ stepId, /** @type {any} */ verdict) => advanced.push([ref, stepId, verdict.outcome]),
  });
  const emit = (/** @type {string} */ event, /** @type {string} */ ref, /** @type {string} */ step, /** @type {any} */ extra) => events.push({ event, ref, step, ...extra });
  const run = createDispatcher(cfg, adapter, undefined, store, emit);
  /** @param {string} stepId @param {string[]|undefined} routeKeys */
  const runStep = async (stepId, routeKeys) => {
    task.routeKeys = routeKeys;
    fs.rmSync(out, { force: true });
    const log = console.log;
    console.log = () => {};
    try {
      await run({ kind: "pipeline", ref: "42", stepId, dedupKey: `k:${stepId}` });
    } finally {
      console.log = log;
    }
    if (!fs.existsSync(out)) return null; // no agent spawned
    const [cwd, ...prompt] = fs.readFileSync(out, "utf8").split("\n");
    return { cwd, prompt: prompt.join("\n") };
  };
  return { store, advanced, events, runStep, ios, mono };
}

test("dispatch routing: a conflicting task holds (advance hold, blocked, setHeld) and never spawns", async () => {
  const { store, advanced, events, runStep } = routeHarness();
  const spawned = await runStep("code", ["iOS", "backend"]);
  assert.equal(spawned, null, "no agent spawned");
  assert.deepEqual(advanced, [["42", "code", "hold"]]);
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "blocked");
  assert.match(events[0].reason, /more than one repo \(mono, ios\)/);
  assert.equal(store.getHeld("42")?.stepId, "code", "held so an @agent reply re-runs the step");
  assert.equal(store.getAttempt("42", "code"), 0, "no attempt counted");
  assert.equal(store.getRepo("42"), undefined, "nothing stuck");
});

test("dispatch routing: an unroutable task (no key, no default) holds", async () => {
  const { advanced, events, runStep } = routeHarness();
  assert.equal(await runStep("code", undefined), null);
  assert.deepEqual(advanced, [["42", "code", "hold"]]);
  assert.match(events[0].reason, /match no repo and none is default/);
});

test("dispatch routing: a routed task sticks; a later step with changed routeKeys keeps the repo", async () => {
  const { store, advanced, runStep, ios } = routeHarness();
  const first = await runStep("code", ["iOS"]);
  assert.equal(first?.cwd, fs.realpathSync(ios), "agent runs in the routed repo");
  assert.equal(store.getRepo("42"), "ios", "sticky repo persisted");
  assert.match(first?.prompt ?? "", /^IOS REPO CONTEXT\n\n[\s\S]*=== TICKET ===/, "repo instructions lead the prompt");
  assert.match(first?.prompt ?? "", new RegExp(`Repo: ios \\(${ios.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)`));
  assert.match(first?.prompt ?? "", /<<<UNTRUSTED TICKET_DESCRIPTION [0-9a-f]{12}>>>/, "description is fenced with a fresh nonce");

  const second = await runStep("review", ["android"]);
  assert.equal(second?.cwd, fs.realpathSync(ios), "sticky repo wins over the new route keys");
  assert.deepEqual(advanced, [["42", "code", "advance"], ["42", "review", "advance"]]);

  // the drain step ends the flow and drops the sticky record
  await runStep("done", ["android"]);
  assert.equal(store.getRepo("42"), undefined);
});

test("dispatch routing: a sticky repo id no longer in config holds instead of guessing", async () => {
  const { store, advanced, events, runStep } = routeHarness();
  store.setRepo("42", "web");
  assert.equal(await runStep("code", ["ios"]), null);
  assert.deepEqual(advanced, [["42", "code", "hold"]]);
  assert.match(events[0].reason, /sticky repo "web" is no longer configured/);
});

// --- lookupPr: best-effort `gh pr list --head agent/<ref>`; never throws ---

test("lookupPr queries the ref's branch and parses the number", async () => {
  /** @type {any[]} */
  const calls = [];
  const pr = await lookupPr("/repo", "94", async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return "123\n";
  });
  assert.equal(pr, 123);
  assert.equal(calls[0].cmd, "gh");
  assert.deepEqual(calls[0].args.slice(0, 4), ["pr", "list", "--head", "agent/94"]);
  assert.equal(calls[0].opts.cwd, "/repo");
  assert.ok(calls[0].opts.timeout > 0, "bounded by a timeout");
});

test("lookupPr: empty output, garbage, or a failing gh → undefined", async () => {
  assert.equal(await lookupPr("/r", "1", async () => ""), undefined);
  assert.equal(await lookupPr("/r", "1", async () => "null"), undefined);
  assert.equal(await lookupPr("/r", "1", async () => { throw new Error("ENOENT gh"); }), undefined);
});

test("lookupPr: an explicit branchPrefix looks up that branch instead of agent/ (#674)", async () => {
  /** @type {any[]} */
  const calls = [];
  await lookupPr("/repo", "94", async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return "123\n";
  }, "local/");
  assert.deepEqual(calls[0].args.slice(0, 4), ["pr", "list", "--head", "local/94"]);
});

test("descriptionHasHeadings: markers, case, whitespace", () => {
  const d = "intro\n  ## technical notes\nh2. Acceptance Criteria\n**Extra**";
  assert.equal(descriptionHasHeadings(d, ["Technical Notes", "ACCEPTANCE criteria", "extra"]), true);
});

test("descriptionHasHeadings: missing, mid-line, empty -> false", () => {
  assert.equal(descriptionHasHeadings("## Technical Notes", ["Technical Notes", "Acceptance Criteria"]), false);
  assert.equal(descriptionHasHeadings("see Technical Notes here", ["Technical Notes"]), false);
  assert.equal(descriptionHasHeadings("", ["A"]), false);
  assert.equal(descriptionHasHeadings(undefined, ["A"]), false);
});

test("promptPathFor: trailing .log -> .prompt.md; mid-name .log untouched", () => {
  assert.equal(
    promptPathFor("/x/logs/2026-10-08T15-31-28-123Z-step-code-152.log"),
    "/x/logs/2026-10-08T15-31-28-123Z-step-code-152.prompt.md",
  );
  assert.equal(
    promptPathFor("/x/logs/2026-10-08T15-31-28-123Z-step-code-my.log.ref.log"),
    "/x/logs/2026-10-08T15-31-28-123Z-step-code-my.log.ref.prompt.md",
  );
});

test("resolveModelEffort: lite applies with fallback; escalate wins", () => {
  const step = { id: "t", model: "m", effort: "high", lite: { descriptionHeadings: ["Spec"], effort: "low" }, escalate: { hard: { effort: "max" } } };
  assert.deepEqual(resolveModelEffort(step, undefined, "## Spec"), { model: "m", effort: "low" });
  assert.deepEqual(resolveModelEffort(step, undefined, "nothing"), { model: "m", effort: "high" });
  assert.deepEqual(resolveModelEffort(step, "hard", "## Spec"), { model: "m", effort: "max" });
});

