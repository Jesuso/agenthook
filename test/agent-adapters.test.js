import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// Agent adapters (src/agents/): the registry, the Claude adapter's interface wrappers, and a
// fake adapter driven end to end through createDispatcher with a real `spawn` of a node script —
// its argv reaches the child, its parser's log text lands in the run log, its usage record is
// stored and its defaults (bin, requireVerdict) apply. No network, no `claude`.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AGENTS, getAgent, agentFor } from "../src/agents/index.js";
import { AGENT_NAMES, DEFAULT_AGENT } from "../src/agents/names.js";
import { claude, buildClaudeArgs } from "../src/agents/claude.js";
import { claudeProjectDir } from "../src/paths.js";
import { createDispatcher } from "../src/dispatch.js";
import { createStore } from "../src/store.js";

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "agenthook-agents-"));

test("registry: keys equal the import-free AGENT_NAMES; claude is the default", () => {
  assert.deepEqual(Object.keys(AGENTS), [...AGENT_NAMES]);
  assert.equal(DEFAULT_AGENT, "claude");
  assert.equal(getAgent("claude"), claude);
  assert.equal(getAgent(), claude);
});

test("getAgent: an unknown name throws (prototype keys too)", () => {
  assert.throws(() => getAgent("nope"), /unknown agent "nope". Known: claude/);
  assert.throws(() => getAgent("constructor"), /unknown agent "constructor"/);
  assert.throws(() => getAgent("__proto__"), /unknown agent "__proto__"/);
});

test("agentFor: the step's agent, else the profile's, else claude", () => {
  assert.equal(agentFor({}), claude);
  assert.equal(agentFor({ agent: "claude" }, { agent: undefined }), claude);
  assert.throws(() => agentFor({ agent: "claude" }, { agent: "nope" }), /unknown agent "nope"/);
  assert.throws(() => agentFor({ agent: "nope" }, {}), /unknown agent "nope"/);
});

test("claude adapter: describe, buildArgs, sessions, defaults", () => {
  assert.deepEqual(claude.describe(), { name: "claude", stdout: "stream-json" });
  const o = { prompt: "hi", model: "opus", effort: "high", fullAuto: true };
  assert.deepEqual(claude.buildArgs(o), buildClaudeArgs(o));
  assert.equal(claude.sessions?.transcriptDir("/x/y"), claudeProjectDir("/x/y"));
  assert.deepEqual(claude.sessions?.resumeCommand("abc"), ["-r", "abc"]);
  assert.deepEqual(claude.defaults, {});
});

test("claude adapter: the parser exposes the result's session id", () => {
  const p = claude.createParser();
  assert.equal(p.sessionId, undefined);
  p.push(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hey" }], usage: { output_tokens: 3 } } }) + "\n");
  assert.equal(p.tally.output, 3);
  assert.equal(p.flush(), "");
  p.push(JSON.stringify({ type: "result", session_id: "sess-9", usage: { output_tokens: 4 } }));
  assert.equal(p.flush(), "");
  assert.equal(p.sessionId, "sess-9");
  assert.equal(p.result.session_id, "sess-9");
  assert.equal(p.tally.output, 4);
});

test("claude adapter: usageRecord with no result keeps run_end's unpriced (zero tokens, no cost)", () => {
  const ctx = { ref: "1", stepId: "code", claudeBin: "claude", startedAt: "a", endedAt: "b" };
  const priced = claude.usageRecord(null, ctx);
  assert.deepEqual([priced.input, priced.output, priced.cacheRead, priced.cacheCreate], [0, 0, 0, 0]);
  assert.equal(priced.costUsd, undefined);
  assert.equal("unpriced" in priced, false);
  assert.equal(claude.usageRecord(null, { ...ctx, bin: "claude-local" }).unpriced, true);
  assert.equal(claude.usageRecord(null, { ...ctx, model: "qwen3-coder" }).unpriced, true);
  assert.equal(claude.usageRecord({ total_cost_usd: 0.25, usage: {} }, ctx).costUsd, 0.25);
});

// --- a fake adapter through the real dispatcher ---

/** A node "agent" that prints its argv and a result line, writes no verdict file. @param {string} dir */
function fakeScript(dir) {
  const file = path.join(dir, "fake-agent.mjs");
  fs.writeFileSync(
    file,
    `process.stdout.write("ARGS " + JSON.stringify(process.argv.slice(2)) + "\\n");\n` +
      `process.stdout.write("noise that the parser drops\\n");\n` +
      `process.stdout.write("RESULT " + JSON.stringify({ tokens: 7, session: "fake-sess" }));\n`,
  );
  return file;
}

/** @param {string} script @returns {import('../src/types.js').AgentAdapter} */
function fakeAdapter(script) {
  return {
    describe: () => ({ name: "fake", stdout: "lines" }),
    buildArgs: ({ prompt, model }) => [script, "--model", model ?? "none", "--prompt-chars", String(prompt.length)],
    createParser() {
      let buf = "";
      /** @type {any} */
      let result = null;
      /** @param {string} line */
      const line = (line) => {
        if (line.startsWith("ARGS ")) return `fake-log ${line.slice(5)}\n`;
        if (line.startsWith("RESULT ")) result = JSON.parse(line.slice(7));
        return "";
      };
      return {
        push(chunk) {
          buf += chunk;
          let out = "";
          let nl;
          while ((nl = buf.indexOf("\n")) !== -1) {
            out += line(buf.slice(0, nl));
            buf = buf.slice(nl + 1);
          }
          return out;
        },
        flush() {
          const t = buf;
          buf = "";
          return t ? line(t) : "";
        },
        tally: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
        get result() {
          return result;
        },
        get sessionId() {
          return result?.session;
        },
      };
    },
    usageRecord: (result, ctx) => ({
      ref: ctx.ref,
      stepId: ctx.stepId,
      model: ctx.model,
      startedAt: ctx.startedAt,
      endedAt: ctx.endedAt,
      input: result?.tokens ?? 0,
      output: 0,
      cacheRead: 0,
      cacheCreate: 0,
      costUsd: 1.5,
      sessionId: result?.session,
      unpriced: true,
    }),
    sessions: null,
    defaults: { bin: process.execPath, requireVerdict: true },
  };
}

test("dispatch: a fake agent adapter drives a real spawn — args, log text, unpriced usage, requireVerdict default", async (t) => {
  const dir = tmpDir();
  AGENTS.fake = fakeAdapter(fakeScript(dir));
  t.after(() => {
    delete AGENTS.fake;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const cfg = /** @type {any} */ ({
    pipeline: [{ id: "code", agent: "fake", model: "m1" }, { id: "done", manual: true }],
    claudeBin: path.join(dir, "no-such-claude"), // never spawned: the adapter's defaults.bin wins
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
    fetchTask: async (/** @type {string} */ ref) => ({ ref, name: "t", description: "d", url: "u", completed: false, assignedToUs: true }),
    advance: async (/** @type {string} */ ref, /** @type {string} */ stepId, /** @type {any} */ verdict) => advanced.push([ref, stepId, verdict.outcome]),
  });
  const emit = (/** @type {string} */ event, /** @type {string} */ ref, /** @type {string} */ step, /** @type {any} */ extra) => events.push({ event, ref, step, ...extra });
  const run = createDispatcher(cfg, adapter, undefined, store, emit);
  const log = console.log;
  console.log = () => {};
  try {
    await run({ kind: "pipeline", ref: "42", stepId: "code", dedupKey: "k:code" });
  } finally {
    console.log = log;
  }

  const runLog = fs.readdirSync(dir).find((f) => /-step-code-42\.log$/.test(f));
  assert.ok(runLog, "a run log was written");
  const text = fs.readFileSync(path.join(dir, String(runLog)), "utf8");
  const m = /^fake-log (.*)$/m.exec(text);
  assert.ok(m, `parser log text in the run log:\n${text}`);
  const argv = JSON.parse(m[1]);
  assert.deepEqual(argv.slice(0, 3), ["--model", "m1", "--prompt-chars"], "the adapter's args reached the child");
  assert.doesNotMatch(text, /noise|RESULT/, "unparsed stdout stays out of the log");

  const usage = store.readUsage();
  assert.equal(usage.length, 1);
  assert.equal(usage[0].unpriced, true);
  assert.equal(usage[0].input, 7);
  assert.equal(usage[0].sessionId, "fake-sess");
  assert.equal(usage[0].stepId, "code");

  const end = events.find((e) => e.event === "run_end");
  assert.equal(end?.unpriced, true);
  assert.equal("costUsd" in end, false, "an unpriced run's cost never reaches run_end");
  assert.equal(end?.outcome, "hold");
  assert.deepEqual(advanced, [["42", "code", "hold"]]);
  assert.equal(store.getHeld("42")?.reason, "no valid verdict (requireVerdict)");
});

test("dispatch: a step's requireVerdict:false beats the adapter's default", async (t) => {
  const dir = tmpDir();
  AGENTS.fake = fakeAdapter(fakeScript(dir));
  t.after(() => {
    delete AGENTS.fake;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const cfg = /** @type {any} */ ({
    pipeline: [{ id: "code", agent: "fake", requireVerdict: false }, { id: "done", manual: true }],
    claudeBin: "claude",
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
    advance: async (/** @type {string} */ ref, /** @type {string} */ stepId, /** @type {any} */ verdict) => advanced.push([ref, stepId, verdict.outcome]),
  });
  const run = createDispatcher(cfg, adapter, undefined, createStore(dir));
  const log = console.log;
  console.log = () => {};
  try {
    await run({ kind: "pipeline", ref: "42", stepId: "code", dedupKey: "k:code" });
  } finally {
    console.log = log;
  }
  assert.deepEqual(advanced, [["42", "code", "advance"]]);
});

// --- a promptFile (hermes-like) adapter through the real dispatcher ---

/** A node "agent" that takes its prompt from a file (its last argv), echoes it to stdout
 * and its session id to stderr — optionally dribbling stderr-only output first (to probe
 * the idle timer) and writing a verdict file. @param {string} dir
 * @param {{writeVerdict?: boolean, idleStderr?: boolean}} [opts] */
function fakeHermesScript(dir, { writeVerdict = false, idleStderr = false } = {}) {
  const file = path.join(dir, `fake-hermes-${writeVerdict}-${idleStderr}.mjs`);
  const lines = [
    `const fs = await import("node:fs");`,
    `const promptFile = process.argv[process.argv.length - 1];`,
    `const content = fs.readFileSync(promptFile, "utf8");`,
  ];
  if (idleStderr) {
    lines.push(`for (let i = 0; i < 4; i++) {`, `  await new Promise((r) => setTimeout(r, 60));`, `  process.stderr.write("tick " + i + "\\n");`, `}`);
  }
  lines.push(`process.stderr.write("session_id: hermes-sess-1\\n");`, `process.stdout.write("got " + content.length + " chars\\n");`);
  if (writeVerdict) lines.push(`fs.writeFileSync(process.env.AGENTHOOK_VERDICT_FILE, JSON.stringify({ outcome: "advance" }));`);
  fs.writeFileSync(file, lines.join("\n") + "\n");
  return file;
}

/** @param {string} script @returns {import('../src/types.js').AgentAdapter} */
function fakeHermesAdapter(script) {
  return {
    describe: () => ({ name: "fakehermes", stdout: "text", promptFile: true }),
    buildArgs: ({ promptFile }) => {
      if (!promptFile) throw new Error("fakehermes requires promptFile");
      return [script, promptFile];
    },
    createParser() {
      let errBuf = "";
      /** @type {string|undefined} */
      let sessionId;
      return {
        push(chunk) {
          return chunk;
        },
        flush() {
          return "";
        },
        pushStderr(chunk) {
          errBuf += chunk;
          const m = /session_id:\s*(\S+)/.exec(errBuf);
          if (m && sessionId === undefined) sessionId = m[1];
        },
        tally: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
        get result() {
          return sessionId === undefined ? null : { session_id: sessionId };
        },
        get sessionId() {
          return sessionId;
        },
      };
    },
    usageRecord: (result, ctx) => ({
      ref: ctx.ref,
      stepId: ctx.stepId,
      model: ctx.model || "fakehermes",
      startedAt: ctx.startedAt,
      endedAt: ctx.endedAt,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheCreate: 0,
      costUsd: undefined,
      sessionId: result?.session_id,
      unpriced: true,
    }),
    sessions: null,
    defaults: { bin: process.execPath, requireVerdict: true },
  };
}

test("dispatch: a promptFile agent — prompt delivered via file + cleaned up, stderr reaches the log and arms idle, no outTok, requireVerdict advance", async (t) => {
  const dir = tmpDir();
  const script = fakeHermesScript(dir, { writeVerdict: true, idleStderr: true });
  AGENTS.fakehermes = fakeHermesAdapter(script);
  t.after(() => {
    delete AGENTS.fakehermes;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const cfg = /** @type {any} */ ({
    pipeline: [{ id: "code", agent: "fakehermes", idleMinutes: 0.0025 }, { id: "done", manual: true }],
    claudeBin: path.join(dir, "no-such-claude"),
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
  });
  const run = createDispatcher(cfg, adapter, undefined, store);

  const promptFile = path.join(dir, "prompts", "42-code.md");
  let sawPromptFile = false;
  let sawOutputField = false;
  const poll = (async () => {
    for (let i = 0; i < 60; i++) {
      if (fs.existsSync(promptFile)) sawPromptFile = true;
      await new Promise((res) => setTimeout(res, 10));
    }
  })();

  const setRunning = store.setRunning.bind(store);
  store.setRunning = (/** @type {string} */ ref, /** @type {any} */ rec) => {
    if (rec && "output" in rec) sawOutputField = true;
    return setRunning(ref, rec);
  };

  const log = console.log;
  console.log = () => {};
  try {
    await Promise.all([run({ kind: "pipeline", ref: "42", stepId: "code", dedupKey: "k:code" }), poll]);
  } finally {
    console.log = log;
    store.setRunning = setRunning;
  }

  assert.ok(sawPromptFile, "the prompt file existed while the run was in flight");
  assert.equal(fs.existsSync(promptFile), false, "the prompt file is removed after the run");
  assert.equal(sawOutputField, false, "a text-only run's running record never gets an output field");

  const runLog = fs.readdirSync(dir).find((f) => /-step-code-42\.log$/.test(f));
  assert.ok(runLog, "a run log was written");
  const text = fs.readFileSync(path.join(dir, String(runLog)), "utf8");
  assert.match(text, /got \d+ chars/, "the prompt reached the child through --query-file");
  assert.match(text, /session_id: hermes-sess-1/, "stderr lands in the run log");
  assert.doesNotMatch(text, /killed:/, "stderr-only output armed the idle timer — never killed");

  const usage = store.readUsage();
  assert.equal(usage.length, 1);
  assert.equal(usage[0].unpriced, true);
  assert.equal(usage[0].sessionId, "hermes-sess-1");

  assert.deepEqual(advanced, [["42", "code", "advance"]]);
});

test("dispatch: a promptFile agent with no verdict file holds via requireVerdict", async (t) => {
  const dir = tmpDir();
  const script = fakeHermesScript(dir, {});
  AGENTS.fakehermes = fakeHermesAdapter(script);
  t.after(() => {
    delete AGENTS.fakehermes;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const cfg = /** @type {any} */ ({
    pipeline: [{ id: "code", agent: "fakehermes" }, { id: "done", manual: true }],
    claudeBin: path.join(dir, "no-such-claude"),
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
  });
  const run = createDispatcher(cfg, adapter, undefined, store);
  const log = console.log;
  console.log = () => {};
  try {
    await run({ kind: "pipeline", ref: "42", stepId: "code", dedupKey: "k:code" });
  } finally {
    console.log = log;
  }
  assert.deepEqual(advanced, [["42", "code", "hold"]]);
  assert.equal(store.getHeld("42")?.reason, "no valid verdict (requireVerdict)");
  assert.equal(fs.existsSync(path.join(dir, "prompts", "42-code.md")), false, "prompt file cleaned up even on a hold");
});

// --- a token-streaming (claude-like) adapter, to prove the lastOut:0 fix didn't break live tally ---

/** A node "agent" that writes two stdout chunks a beat apart, each bumping a token count. @param {string} dir */
function fakeStreamScript(dir) {
  const file = path.join(dir, "fake-stream-agent.mjs");
  fs.writeFileSync(
    file,
    `process.stdout.write("tok\\n");\n` +
      `await new Promise((r) => setTimeout(r, 60));\n` +
      `process.stdout.write("tok\\n");\n`,
  );
  return file;
}

/** @param {string} script @returns {import('../src/types.js').AgentAdapter} */
function fakeStreamAdapter(script) {
  return {
    describe: () => ({ name: "fakestream", stdout: "lines" }),
    buildArgs: () => [script],
    createParser() {
      let output = 0;
      return {
        push(chunk) {
          output += (chunk.match(/tok/g) || []).length * 5;
          return chunk;
        },
        flush() {
          return "";
        },
        tally: { input: 0, get output() { return output; }, cacheRead: 0, cacheCreate: 0 },
        result: null,
        sessionId: undefined,
      };
    },
    usageRecord: (_result, ctx) => ({
      ref: ctx.ref,
      stepId: ctx.stepId,
      model: ctx.model,
      startedAt: ctx.startedAt,
      endedAt: ctx.endedAt,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheCreate: 0,
      costUsd: undefined,
      sessionId: undefined,
      unpriced: true,
    }),
    sessions: null,
    defaults: { bin: process.execPath, requireVerdict: false },
  };
}

test("dispatch: a token-streaming agent's live tally still updates the running record (lastOut:0 didn't break it)", async (t) => {
  const dir = tmpDir();
  AGENTS.fakestream = fakeStreamAdapter(fakeStreamScript(dir));
  t.after(() => {
    delete AGENTS.fakestream;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const cfg = /** @type {any} */ ({
    pipeline: [{ id: "code", agent: "fakestream" }, { id: "done", manual: true }],
    claudeBin: path.join(dir, "no-such-claude"),
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
  const run = createDispatcher(cfg, adapter, undefined, store);
  let sawPositiveOutput = false;
  const poll = (async () => {
    for (let i = 0; i < 60; i++) {
      const r = store.listRunning()["42"];
      if (r && r.output > 0) sawPositiveOutput = true;
      await new Promise((res) => setTimeout(res, 10));
    }
  })();
  const log = console.log;
  console.log = () => {};
  try {
    await Promise.all([run({ kind: "pipeline", ref: "42", stepId: "code", dedupKey: "k:code" }), poll]);
  } finally {
    console.log = log;
  }
  assert.ok(sawPositiveOutput, "a claude-style stream still writes a positive output onto the running record while in flight");
});
