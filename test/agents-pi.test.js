import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// The pi agent adapter (#752) — pure-unit coverage (no real `pi` spawn): the `pi -p --mode json`
// argv, the JSONL parser over a recorded run (test/fixtures/pi-run.jsonl, a real
// `pi -p --mode json` capture, ids/paths anonymised, tool output trimmed), both pricing branches
// of the usage record, the `piConfigDir` read/validation, the unattended contract (the opencode
// one minus the post-compaction paragraph), the model-API egress hosts, and one end-to-end
// dispatch that proves the sandbox hook's `--append-system-prompt` flags splice in before `--`.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { buildPiArgs, resumePiArgs, createPiParser, buildPiUsageRecord, readPiConfigDir, piContract, piEgressHosts, pi } = await import("../src/agents/pi.js");
const { opencodeContract } = await import("../src/agents/opencode.js");
const { AGENTS } = await import("../src/agents/index.js");
const { isAgentRun, sandboxHarness } = await import("./_dispatch-sandbox-helpers.js");
const { runChecks } = await import("../src/commands/doctor.js");
const { cleanProfile, io } = await import("./_doctor-helpers.js");

const FIXTURE = fs.readFileSync(new URL("./fixtures/pi-run.jsonl", import.meta.url), "utf8");
const SID = "01a1f1e6-562d-7763-b543-3e641ba33b82";

/** Capture console.warn while fn runs. @param {() => void} fn */
function warns(fn) {
  /** @type {string[]} */
  const out = [];
  const orig = console.warn;
  console.warn = (m) => out.push(m);
  try {
    fn();
  } finally {
    console.warn = orig;
  }
  return out;
}

test("buildPiArgs: -p --mode json --offline, prompt last; no --model/--thinking unless asked", () => {
  assert.deepEqual(buildPiArgs({ prompt: "hi" }), ["-p", "--mode", "json", "--offline", "--", "hi"]);
  assert.deepEqual(buildPiArgs({ prompt: "hi", model: "ollama/qwen3.8:27b", effort: "high", fullAuto: true, maxMs: 60_000 }), [
    "-p",
    "--mode",
    "json",
    "--offline",
    "--model",
    "ollama/qwen3.8:27b",
    "--thinking",
    "high",
    "--",
    "hi",
  ]);
});

test("buildPiArgs: a dash-led prompt (bullet, YAML front-matter) sits behind -- so it is never read as flags", () => {
  for (const prompt of ["- hello", "---\ntitle: x\n---\nhello"]) {
    const args = buildPiArgs({ prompt, model: "m" });
    assert.deepEqual(args.slice(-2), ["--", prompt]);
  }
});

test("buildPiArgs: provider never reaches argv (folded into --model) and is warned about", () => {
  /** @type {string[]} */
  let args = [];
  const w = warns(() => (args = buildPiArgs({ prompt: "hi", provider: "ollama-launch" })));
  assert.deepEqual(args, ["-p", "--mode", "json", "--offline", "--", "hi"]);
  assert.equal(w.length, 1);
  assert.match(w[0], /provider "ollama-launch"/);
  assert.deepEqual(warns(() => buildPiArgs({ prompt: "hi", effort: "high" })), []);
});

test("buildPiArgs: an effort pi's --thinking doesn't accept is dropped with one warn", () => {
  /** @type {string[]} */
  let args = [];
  const w = warns(() => (args = buildPiArgs({ prompt: "hi", effort: "ultra" })));
  assert.deepEqual(args, ["-p", "--mode", "json", "--offline", "--", "hi"]);
  assert.equal(w.length, 1);
  assert.match(w[0], /effort "ultra"/);
  for (const lvl of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
    assert.deepEqual(warns(() => buildPiArgs({ prompt: "hi", effort: lvl })), []);
  }
});

test("resumePiArgs: --session <id> inserted right before the -- separator", () => {
  assert.deepEqual(resumePiArgs({ prompt: "hi", model: "m", effort: "high", sessionId: "ses_1" }), [
    "-p",
    "--mode",
    "json",
    "--offline",
    "--model",
    "m",
    "--thinking",
    "high",
    "--session",
    "ses_1",
    "--",
    "hi",
  ]);
  assert.equal(pi.resumeArgs, resumePiArgs);
});

test("parser: recorded run → tools + text + one compaction in the log, per-turn usage summed, session id", () => {
  const p = createPiParser();
  const log = p.push(FIXTURE) + p.flush();
  assert.equal(p.sessionId, SID);
  // pi's usage is per turn: summed over the 6 assistant turns + the compaction call.
  assert.deepEqual(p.tally, { input: 79847, output: 6166, cacheRead: 193632, cacheCreate: 0, compactions: 1, turns: 6, firstContext: 8219, peakContext: 113348, lastContext: 40805 });
  assert.deepEqual(p.result, { session_id: SID, tokens: p.tally, cost: 0 });
  // one 🗜 marker, from the compaction_end (tokensBefore/estimatedTokensAfter sit on .result)
  assert.match(log, /🗜 compaction \(ctx 116,152 → 25,274\)\n/);
  assert.equal((log.match(/🗜/g) ?? []).length, 1);
});

test("parser: renders tool calls (🔧) and assistant text; thinking items and turn_end repeat render nothing", () => {
  const p = createPiParser();
  const log = p.push(FIXTURE) + p.flush();
  assert.match(log, /🔧 bash cd \/work\/repo && git status && git log --oneline -5 && ls\n/);
  assert.match(log, /🔧 read \/work\/repo\/src\/worktree\.js\n/);
  assert.match(log, /🔧 edit \/work\/repo\/test\/doctor\.test\.js\n/);
  assert.match(log, /Now the doctor tests:\n/);
  // turn_end repeats each assistant message (with its usage) — counting it would double the tally,
  // so a fixture full of turn_end events still sums to the message_end numbers above.
  assert.equal((log.match(/🔧/g) ?? []).length, 7);
  // thinking items render nothing: none of the fixture's thinking text reaches the log.
  assert.doesNotMatch(log, /Let's start by examining the repository/);
  assert.doesNotMatch(log, /Verdict already written\. Just to be safe/);
});

test("parser: message_update / message_start / agent events carry no log text and no tokens", () => {
  const p = createPiParser();
  const out = p.push(
    JSON.stringify({ type: "session", id: SID }) +
      "\n" +
      JSON.stringify({ type: "agent_start" }) +
      "\n" +
      JSON.stringify({ type: "message_start", message: { role: "assistant" } }) +
      "\n" +
      JSON.stringify({ type: "message_update", message: { role: "assistant", content: [{ type: "thinking", text: "pondering" }] } }) +
      "\n" +
      JSON.stringify({ type: "turn_start" }) +
      "\n" +
      JSON.stringify({ type: "turn_end" }) +
      "\n" +
      JSON.stringify({ type: "agent_end" }) +
      "\n" +
      JSON.stringify({ type: "agent_settled" }) +
      "\n",
  ) +
    p.flush();
  assert.equal(out, "");
  assert.equal(p.sessionId, SID);
  // a session id alone yields a zero-tally result (a killed run still records its session)
  assert.deepEqual(p.result, { session_id: SID, tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, compactions: 0 }, cost: 0 });
});

test("parser: the fixture's own message_update lines (assistantMessageEvent deltas) render nothing", () => {
  const updates = FIXTURE.split("\n").filter((l) => l.includes('"type": "message_update"'));
  assert.ok(updates.length > 0, "the fixture has message_update lines");
  const p = createPiParser();
  assert.equal(p.push(updates.join("\n") + "\n") + p.flush(), "");
  assert.equal(p.result, null);
});

test("parser: unknown events and non-JSON lines are ignored, never throw", () => {
  const p = createPiParser();
  const out = p.push('not json\n{"type":"mystery","x":1}\n[1,2]\nnull\n{"type":"message_end","message":{"role":"user"}}\n{"type":"message_end","message":{"role":"assistant","usage":"x"}}\n');
  assert.equal(out + p.flush(), "");
  assert.equal(p.result, null);
});

test("parser: a compaction_end with no result still counts a compaction (renders 0 → 0)", () => {
  const p = createPiParser();
  assert.equal(p.push('{"type":"compaction_end"}\n'), "🗜 compaction (ctx 0 → 0)\n");
  assert.equal(p.tally.compactions, 1);
});

test("parser: a line split across chunks is buffered; one char at a time gives the same output", () => {
  const p = createPiParser();
  let log = "";
  for (const ch of FIXTURE) log += p.push(ch);
  log += p.flush();
  assert.equal(p.tally.output, 6166);
  assert.equal(p.sessionId, SID);
  assert.match(log, /🗜 compaction/);
});

test("usage record: zero cost (local/free model) → unpriced, no costUsd; bin tagged only when it overrides pi", () => {
  const p = createPiParser();
  p.push(FIXTURE);
  const ctx = { ref: "7", stepId: "code", startedAt: "s", endedAt: "e" };
  const rec = buildPiUsageRecord({ ...ctx, model: "ollama/qwen3.8:27b", result: p.result });
  assert.deepEqual(rec, {
    ref: "7",
    stepId: "code",
    model: "ollama/qwen3.8:27b",
    startedAt: "s",
    endedAt: "e",
    input: 79847,
    output: 6166,
    cacheRead: 193632,
    cacheCreate: 0,
    costUsd: undefined,
    sessionId: SID,
    unpriced: true,
  });
  assert.equal(buildPiUsageRecord({ ...ctx, result: p.result }).model, "pi");
  assert.equal(buildPiUsageRecord({ ...ctx, bin: "pi", result: p.result }).bin, undefined);
  assert.equal(buildPiUsageRecord({ ...ctx, bin: "/opt/pi", result: p.result }).bin, "/opt/pi");
  const none = pi.usageRecord(null, ctx);
  assert.deepEqual([none.input, none.output, none.costUsd, none.sessionId, none.unpriced], [0, 0, undefined, undefined, true]);
});

test("usage record: a non-zero summed cost → priced costUsd, no unpriced flag", () => {
  const rec = buildPiUsageRecord({ ref: "7", stepId: "code", startedAt: "s", endedAt: "e", result: { session_id: SID, tokens: { input: 1, output: 2, cacheRead: 3, cacheCreate: 0 }, cost: 0.75 } });
  assert.equal(rec.costUsd, 0.75);
  assert.equal("unpriced" in rec, false);
});

test("readPiConfigDir: reads models.json/settings.json when present, skips absent, throws on a bad path", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cfg-"));
  try {
    fs.writeFileSync(path.join(dir, "models.json"), JSON.stringify({ providers: { ollama: { baseUrl: "http://192.168.1.20:11434/v1" } } }));
    fs.writeFileSync(path.join(dir, "settings.json"), '{"theme":"dark"}');
    const files = readPiConfigDir(dir);
    assert.deepEqual(files.map((f) => f.name), ["models.json", "settings.json"]);
    assert.deepEqual(JSON.parse(files[0].content).providers.ollama.baseUrl, "http://192.168.1.20:11434/v1");

    const empty = path.join(dir, "sub");
    fs.mkdirSync(empty);
    assert.deepEqual(readPiConfigDir(empty), []);

    assert.throws(() => readPiConfigDir(path.join(dir, "nope")), /piConfigDir .*: /);
    assert.throws(() => readPiConfigDir(path.join(dir, "models.json")), /not a directory/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readPiConfigDir: a non-regular, oversized or invalid-JSON models.json throws `piConfigDir <path>: …`", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cfg-bad-"));
  try {
    const d = path.join(dir, "d");
    fs.mkdirSync(d);
    const big = path.join(d, "models.json");
    fs.writeFileSync(big, "x".repeat(256 * 1024 + 1));
    assert.throws(() => readPiConfigDir(d), /exceeds the .* cap/);
    fs.writeFileSync(big, "{not json");
    assert.throws(() => readPiConfigDir(d), /invalid JSON/);
    fs.rmSync(big);
    const asdir = path.join(d, "models.json");
    fs.mkdirSync(asdir);
    assert.throws(() => readPiConfigDir(d), /not a regular file/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("piContract: has the verdict section, drops the post-compaction paragraph opencode keeps", () => {
  const text = piContract("/verdict/run-752/verdict.json");
  assert.match(text, /\/verdict\/run-752\/verdict\.json/);
  assert.match(text, /AGENTHOOK_VERDICT_FILE/);
  assert.match(text, /never[\s\S]*end on a question/i);
  assert.doesNotMatch(text, /After a context compaction/i);
  assert.doesNotMatch(text, /Continue if you have/);
  // opencode's contract still carries that paragraph — pi's is the same file with only it removed
  assert.match(opencodeContract("/verdict/run-752/verdict.json"), /After a context compaction/);
});

test("piEgressHosts: the host:port of each providers.*.baseUrl in models.json; [] without a piConfigDir", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-egress-"));
  try {
    fs.writeFileSync(
      path.join(dir, "models.json"),
      JSON.stringify({ providers: { local: { baseUrl: "http://192.168.1.20:11434/v1" }, tls: { baseUrl: "https://api.example.com" }, bad: { baseUrl: "not a url" }, none: {} } }),
    );
    assert.deepEqual(piEgressHosts({}, { step: { piConfigDir: dir } }), ["192.168.1.20:11434", "api.example.com:443"]);
    assert.deepEqual(piEgressHosts({}, {}), []);
    assert.deepEqual(piEgressHosts({}, { step: {} }), []);
    assert.deepEqual(piEgressHosts({}, { step: { piConfigDir: path.join(dir, "nope") } }), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("adapter: describe (no policy), defaults, resume argv, no transcripts", () => {
  assert.deepEqual(pi.describe(), { name: "pi", stdout: "stream-json", policy: { allow: false, deny: false }, sandboxResume: false });
  assert.deepEqual(pi.defaults, { bin: "pi" });
  assert.equal(pi.sessions, null);
  assert.deepEqual(pi.resumeCommand?.("ses_1"), ["--session", "ses_1"]);
  assert.equal(AGENTS.pi, pi);
});

test("sandbox: piConfigDir files copied to <home>/.pi/agent, no verdictFile → files only, no contract/args", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sb-"));
  try {
    fs.writeFileSync(path.join(dir, "models.json"), '{"providers":{}}');
    const own = pi.sandbox({ step: /** @type {any} */ ({ id: "code", piConfigDir: dir }), home: "/home/agent" });
    assert.deepEqual(own.mounts, []);
    assert.deepEqual(own.files, [{ dst: "/home/agent/.pi/agent/models.json", content: '{"providers":{}}', mode: 0o600 }]);
    assert.equal(own.args, undefined);
    assert.equal(own.standingInInstructions, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("sandbox: verdictFile → contract file + one --append-system-prompt; standing ≤16KB adds a second", () => {
  const verdictFile = "/verdict/run-752/verdict.json";
  const own = pi.sandbox({ step: /** @type {any} */ ({ id: "code" }), home: "/home/agent", verdictFile });
  const contractDst = "/home/agent/.pi/agent/agenthook-unattended.md";
  const contract = own.files.find((f) => f.dst === contractDst);
  assert.ok(contract, "contract file present");
  assert.equal(contract.mode, 0o600);
  assert.match(contract.content, /\/verdict\/run-752\/verdict\.json/);
  assert.deepEqual(own.args, ["--append-system-prompt", contractDst]);

  const standing = "# Code step standing instructions\nDo the minimal change.";
  const withStanding = pi.sandbox({ step: /** @type {any} */ ({ id: "code" }), home: "/home/agent", verdictFile, standing });
  const standingDst = "/home/agent/.pi/agent/agenthook-standing.md";
  assert.deepEqual(withStanding.files.find((f) => f.dst === standingDst)?.content, standing);
  assert.deepEqual(withStanding.args, ["--append-system-prompt", contractDst, "--append-system-prompt", standingDst]);
  assert.equal(withStanding.standingInInstructions, true);
});

test("sandbox: piConfigDir + verdictFile + standing → all four files under <home>/.pi/agent, mode 0o600", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sb-all-"));
  try {
    fs.writeFileSync(path.join(dir, "models.json"), '{"providers":{}}');
    fs.writeFileSync(path.join(dir, "settings.json"), '{"theme":"dark"}');
    const standing = "# standing";
    const own = pi.sandbox({
      step: /** @type {any} */ ({ id: "code", piConfigDir: dir }),
      home: "/home/agent",
      verdictFile: "/verdict/run-752/verdict.json",
      standing,
    });
    const base = "/home/agent/.pi/agent/";
    const byDst = /** @type {Record<string, {content: string, mode: number}>} */ ({});
    for (const f of own.files) byDst[f.dst] = f;
    // all four files, each under <home>/.pi/agent with mode 0o600
    assert.deepEqual(own.files.map((f) => f.dst).sort(), [
      base + "agenthook-standing.md",
      base + "agenthook-unattended.md",
      base + "models.json",
      base + "settings.json",
    ]);
    assert.deepEqual(byDst[base + "models.json"].content, '{"providers":{}}');
    assert.deepEqual(byDst[base + "settings.json"].content, '{"theme":"dark"}');
    assert.deepEqual(byDst[base + "agenthook-standing.md"].content, standing);
    assert.match(byDst[base + "agenthook-unattended.md"].content, /\/verdict\/run-752\/verdict\.json/);
    for (const f of own.files) assert.equal(f.mode, 0o600, `mode of ${f.dst}`);
    // one --append-system-prompt per written prompt file (the contract and the standing), no config file
    assert.deepEqual(own.args, ["--append-system-prompt", base + "agenthook-unattended.md", "--append-system-prompt", base + "agenthook-standing.md"]);
    assert.equal(own.standingInInstructions, true);
    assert.deepEqual(own.mounts, []);
    assert.deepEqual(own.env, {});
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("sandbox: standing over 16KB → no standing file, one warn; empty standing → contract only", () => {
  const verdictFile = "/verdict/run-752/verdict.json";
  const w = warns(() => {
    const own = pi.sandbox({ step: /** @type {any} */ ({ id: "code" }), home: "/home/agent", verdictFile, standing: "x".repeat(16 * 1024 + 1) });
    assert.equal(own.files.length, 1);
    assert.equal(own.standingInInstructions, undefined);
  });
  assert.equal(w.length, 1);
  assert.match(w[0], /\[dispatch\] step code.*standing instructions are/);

  const empty = pi.sandbox({ step: /** @type {any} */ ({ id: "code" }), home: "/home/agent", verdictFile, standing: "" });
  assert.deepEqual(empty.args, ["--append-system-prompt", "/home/agent/.pi/agent/agenthook-unattended.md"]);
});

test("sandbox: a missing/non-directory piConfigDir throws → dispatch refuses, nothing spawns", () => {
  assert.throws(() => pi.sandbox({ step: /** @type {any} */ ({ id: "code", piConfigDir: "/no/such/dir" }), home: "/home/agent" }), /piConfigDir .*: /);
});

test("dispatch e2e: a sandboxed pi step runs through the runtime and its --append-system-prompt splices in before --", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-dispatch-"));
  fs.writeFileSync(path.join(dir, "models.json"), '{"providers":{}}');
  const h = sandboxHarness([{ id: "code", agent: "pi", createsWorktree: true, piConfigDir: dir }, { id: "done", manual: true }]);
  // The harness's claudeBin stub doubles as the pi binary here — the stub is agent-agnostic.
  h.cfg.pipeline[0].bin = h.cfg.claudeBin;
  try {
    await h.go("code");
    assert.equal(h.advanced[0]?.outcome, "advance", JSON.stringify(h.advanced));
    const run = h.calls().find(isAgentRun);
    assert.ok(run, "the runtime client was spawned");
    const sep = run.indexOf("--");
    assert.notEqual(sep, -1);
    const flag = run.lastIndexOf("--append-system-prompt", sep);
    assert.notEqual(flag, -1, "--append-system-prompt precedes the -- separator");
    assert.ok(flag < sep);
    assert.match(run[flag + 1], /agenthook-unattended\.md$/);
    assert.ok(run.includes("-p") && run.includes("--mode") && run.includes("json"), "the pi argv is intact");
  } finally {
    h.restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("dispatch e2e: a sandboxed pi run that prints the fixture but writes no verdict → verdict_missing hold, one run, pi usage record", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-noverdict-"));
  const h = sandboxHarness(
    [{ id: "code", agent: "pi", createsWorktree: true }, { id: "done", manual: true }],
    { inner: `#!/bin/sh\ncat ${JSON.stringify(new URL("./fixtures/pi-run.jsonl", import.meta.url).pathname)}\n` },
  );
  // The harness's claudeBin stub doubles as the pi binary here — the stub is agent-agnostic.
  h.cfg.pipeline[0].bin = h.cfg.claudeBin;
  try {
    await h.go("code");
    assert.equal(h.advanced[0]?.outcome, "hold", JSON.stringify(h.advanced));
    const vm = h.events.find((e) => e.event === "verdict_missing");
    assert.ok(vm, "verdict_missing was emitted");
    assert.match(vm.data.reason, /no valid verdict/);
    const held = h.store.getHeld("42");
    assert.ok(held && held.stepId === "code", JSON.stringify(held));
    assert.equal(h.events.find((e) => e.event === "verdict_repair"), undefined, "no repair turn (sandboxResume: false)");
    assert.equal(h.calls().filter(isAgentRun).length, 1, "exactly one agent run");
    // usage.jsonl got the pi record: the fixture's per-turn tallies, unpriced, with the turn stats
    const usageFile = path.join(h.state, "usage.jsonl");
    const recs = fs.readFileSync(usageFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(recs.length, 1);
    const r = recs[0];
    assert.deepEqual([r.ref, r.stepId, r.input, r.output, r.cacheRead, r.cacheCreate], ["42", "code", 79847, 6166, 193632, 0]);
    assert.equal(r.unpriced, true);
    assert.equal("costUsd" in r, false);
    assert.deepEqual([r.turns, r.firstContext, r.peakContext, r.lastContext, r.compactions], [6, 8219, 113348, 40805, 1]);
    assert.equal(r.sessionId, SID);
  } finally {
    h.restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("doctor: a pi step whose bin is on PATH shows its version; a missing bin gets the install hint", async () => {
  const { cfg } = cleanProfile();
  cfg.pipeline[0].agent = "pi";
  const find = (/** @type {any[]} */ checks, /** @type {string} */ bin) => checks.find((c) => c.label === `pi binary on PATH: ${bin} (steps: code)`);

  // present: the first `--version` stdout line (it prints a banner) is the note
  const seen = [];
  const onPath = io({
    onPath: () => true,
    run: async (/** @type {string} */ bin, /** @type {string[]} */ args) => {
      seen.push([bin, args]);
      return { code: 0, stdout: "pi coding agent 1.5.2\n(built for linux)\n", stderr: "" };
    },
  });
  const present = await runChecks(cfg, onPath);
  const c1 = find(present, "pi");
  assert.ok(c1 && c1.ok, JSON.stringify(c1));
  assert.equal(c1.note, "pi coding agent 1.5.2");
  assert.deepEqual(seen, [["pi", ["--version"]]]);

  // missing: an ✗ with the npm install hint, no `--version` spawned
  const run2 = async () => {
    throw new Error("should not run");
  };
  const off = io({ onPath: () => false, run: run2 });
  const absent = await runChecks(cfg, off);
  const c2 = find(absent, "pi");
  assert.ok(c2 && !c2.ok, JSON.stringify(c2));
  assert.equal(c2.note, "not found");
  assert.match(c2.fix?.manual ?? "", /npm i -g @earendil-works\/pi-coding-agent/);
});
