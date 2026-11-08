import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// Named harnesses (#619) in dispatch: resolveHarness (the effective step a run spawns with) and a
// run driven through the real dispatcher with a fake agent bin (no network).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveHarness, harnessesOf, healthTrip, cooldownFor, modelApiFailure } from "../src/dispatch/harness.js";
import { createSpawn } from "../src/dispatch/spawn.js";
import { resolveModelEffort, createDispatcher } from "../src/dispatch.js";
import { agentFor } from "../src/agents/index.js";
import { createStore } from "../src/store.js";

const HARNESSES = {
  qwen: { agent: "claude", model: "qwen3-coder", bin: "claude-local", env: { ANTHROPIC_BASE_URL: "http://localhost:11434", SHARED: "harness" }, maxConcurrent: 1 },
  deepseek: { agent: "opencode", model: "deepseek/deepseek-v3", provider: "openrouter", toolsets: ["terminal"], sandbox: { image: "agent-opencode:1" } },
  bare: {},
};

/** A claude stream-json result line, so the run writes a usage record. */
const RESULT_LINE = JSON.stringify({ type: "result", total_cost_usd: 0.5, usage: { input_tokens: 10, output_tokens: 5 } });

test("harnessesOf: a string is a one-element list, a list is copied, none is []", () => {
  assert.deepEqual(harnessesOf({ harness: "qwen" }), ["qwen"]);
  assert.deepEqual(harnessesOf({ harness: ["qwen", "deepseek"] }), ["qwen", "deepseek"]);
  assert.deepEqual(harnessesOf({}), []);
});

test("resolveHarness: the harness fills knobs the step leaves unset", () => {
  const step = { id: "code", effort: /** @type {const} */ ("high") };
  const r = resolveHarness({ harnesses: HARNESSES }, step, "deepseek");
  assert.equal(r.harness, "deepseek");
  assert.equal(r.sandboxImage, "agent-opencode:1");
  assert.deepEqual(r.step, { id: "code", effort: "high", agent: "opencode", model: "deepseek/deepseek-v3", provider: "openrouter", toolsets: ["terminal"] });
  assert.deepEqual(step, { id: "code", effort: "high" }, "the real step is not mutated");
});

test("resolveHarness precedence: step inline > harness > profile > adapter default", () => {
  const cfg = { harnesses: HARNESSES, agent: "hermes", agentProvider: "profile-prov" };
  // step inline wins
  const inline = resolveHarness(cfg, { id: "code", agent: "cursor", model: "m-step", bin: "b-step", provider: "p-step" }, "deepseek").step;
  assert.deepEqual([inline.agent, inline.model, inline.bin, inline.provider], ["cursor", "m-step", "b-step", "p-step"]);
  // harness next
  const viaHarness = resolveHarness(cfg, { id: "code" }, "deepseek").step;
  assert.equal(agentFor(cfg, viaHarness).describe().name, "opencode");
  assert.equal(viaHarness.provider ?? cfg.agentProvider, "openrouter");
  // a harness that sets nothing leaves the profile defaults in charge, then the adapter's
  const viaProfile = resolveHarness(cfg, { id: "code" }, "bare").step;
  assert.equal(agentFor(cfg, viaProfile).describe().name, "hermes");
  assert.equal(viaProfile.provider ?? cfg.agentProvider, "profile-prov");
  assert.equal(agentFor({}, resolveHarness({ harnesses: HARNESSES }, { id: "code" }, "bare").step).describe().name, "claude");
  assert.equal(viaProfile.model, undefined, "no model → the agent CLI's default");
});

test("resolveHarness: env merges harness under step (step keys win); both empty → no env", () => {
  const r = resolveHarness({ harnesses: HARNESSES }, { id: "code", env: { SHARED: "step", STEP_ONLY: "1" } }, "qwen");
  assert.deepEqual(r.step.env, { ANTHROPIC_BASE_URL: "http://localhost:11434", SHARED: "step", STEP_ONLY: "1" });
  assert.equal(Object.hasOwn(resolveHarness({ harnesses: HARNESSES }, { id: "code" }, "bare").step, "env"), false);
});

test("resolveHarness: escalate/lite still override a harness model", () => {
  const step = /** @type {any} */ ({ id: "code", escalate: { hard: { model: "claude-opus-5-5" } }, lite: { descriptionHeadings: ["Spec"], model: "lite-model" } });
  const eff = resolveHarness({ harnesses: HARNESSES }, step, "qwen").step;
  assert.deepEqual(resolveModelEffort(eff, undefined, "x"), { model: "qwen3-coder", effort: undefined });
  assert.deepEqual(resolveModelEffort(eff, "hard", "x"), { model: "claude-opus-5-5", effort: undefined });
  assert.deepEqual(resolveModelEffort(eff, undefined, "## Spec\nbody"), { model: "lite-model", effort: undefined });
});

test("resolveHarness: a null or unknown harness returns the step unchanged", () => {
  const step = { id: "code", model: "m" };
  for (const name of [null, undefined, "gone", "toString"]) {
    const r = resolveHarness({ harnesses: HARNESSES }, step, name);
    assert.equal(r.step, step);
    assert.equal(r.harness, null);
    assert.equal(r.sandboxImage, undefined);
  }
  assert.equal(resolveHarness({}, step, "qwen").step, step, "no harnesses block");
});

test("dispatch: a run with job.harness spawns with the harness's bin/model/env and records harness in running.json, run_start and run_end", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthook-dispatch-harness-"));
  const bin = path.join(dir, "claude-local.sh");
  const out = path.join(dir, "out.txt");
  // Records argv, two env vars and running.json as the run sees it, then writes the verdict.
  // running.json is written in onPid, after the spawn: wait for it (up to 5s) instead of racing it.
  fs.writeFileSync(
    bin,
    `#!/bin/sh\nprintf '%s\\n' "$@" > "${out}.argv"\nprintf 'BASE=%s\\nSHARED=%s\\n' "\${ANTHROPIC_BASE_URL-unset}" "\${SHARED-unset}" > "${out}"\nn=0; while [ ! -f "${path.join(dir, "running.json")}" ] && [ $n -lt 100 ]; do sleep 0.05; n=$((n+1)); done\ncp "${path.join(dir, "running.json")}" "${out}.running"\nprintf '%s\\n' '${RESULT_LINE}'\nprintf '%s' '{"outcome":"advance"}' > "$AGENTHOOK_VERDICT_FILE"\n`,
    { mode: 0o755 },
  );
  const cfg = /** @type {any} */ ({
    harnesses: { local: { bin, model: "qwen3-coder", env: { ANTHROPIC_BASE_URL: "http://localhost:11434", SHARED: "harness" }, maxConcurrent: 1 } },
    pipeline: [{ id: "code", harness: ["local"], env: { SHARED: "step" } }, { id: "done", manual: true }],
    claudeBin: path.join(dir, "not-this-one"),
    repoPath: dir,
    worktreePrefix: path.join(dir, "wt"),
    dataDir: dir,
    logDir: dir,
    instructionsFile: path.join(dir, "none.md"),
  });
  const store = createStore(dir);
  /** @type {any[]} */ const events = [];
  /** @type {any[]} */ const advanced = [];
  const adapter = /** @type {any} */ ({
    describe: () => ({ platform: "GitHub", taskNoun: "issue", trigger: "@agent", commentHowTo: "comment" }),
    fetchTask: async (/** @type {string} */ ref) => ({ ref, name: "t", description: "d", url: "u", completed: false, assignedToUs: true }),
    advance: async (/** @type {string} */ ref, /** @type {string} */ stepId, /** @type {any} */ v) => advanced.push([ref, stepId, v.outcome]),
  });
  const emit = (/** @type {string} */ event, /** @type {string} */ _ref, /** @type {string} */ _step, /** @type {any} */ extra) => events.push({ event, ...extra });
  const run = createDispatcher(cfg, adapter, undefined, store, emit);
  const log = console.log;
  console.log = () => {};
  try {
    await run({ kind: "pipeline", ref: "42", stepId: "code", dedupKey: "k:code", harness: "local" });
  } finally {
    console.log = log;
  }
  const argv = fs.readFileSync(`${out}.argv`, "utf8").trim().split("\n");
  assert.equal(argv[argv.indexOf("--model") + 1], "qwen3-coder", "the harness's model");
  assert.deepEqual(fs.readFileSync(out, "utf8").trim().split("\n"), ["BASE=http://localhost:11434", "SHARED=step"], "harness env under the step's");
  const running = JSON.parse(fs.readFileSync(`${out}.running`, "utf8"))["42"];
  assert.equal(running.harness, "local");
  assert.equal(running.agent, "claude");
  assert.equal(running.model, "qwen3-coder");
  assert.equal(events.find((e) => e.event === "run_start")?.harness, "local");
  assert.equal(events.find((e) => e.event === "run_end")?.harness, "local");
  assert.deepEqual(advanced, [["42", "code", "advance"]]);
  assert.equal(store.readUsage()[0]?.harness, "local", "the usage record names the harness");
});

test("dispatch: a profile without harnesses keeps run_start/run_end free of a harness field", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthook-dispatch-harness-"));
  const bin = path.join(dir, "fake-claude.sh");
  fs.writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' '${RESULT_LINE}'\nprintf '%s' '{"outcome":"advance"}' > "$AGENTHOOK_VERDICT_FILE"\n`, { mode: 0o755 });
  const cfg = /** @type {any} */ ({ pipeline: [{ id: "code" }], claudeBin: bin, repoPath: dir, worktreePrefix: path.join(dir, "wt"), dataDir: dir, logDir: dir, instructionsFile: path.join(dir, "none.md") });
  /** @type {any[]} */ const events = [];
  const adapter = /** @type {any} */ ({
    describe: () => ({ platform: "GitHub", taskNoun: "issue", trigger: "@agent", commentHowTo: "comment" }),
    fetchTask: async (/** @type {string} */ ref) => ({ ref, name: "t", description: "d", url: "u", completed: false, assignedToUs: true }),
    advance: async () => {},
  });
  const store = createStore(dir);
  const run = createDispatcher(cfg, adapter, undefined, store, (/** @type {string} */ event, /** @type {string} */ _r, /** @type {string} */ _s, /** @type {any} */ extra) => events.push({ event, ...extra }));
  const log = console.log;
  console.log = () => {};
  try {
    await run({ kind: "pipeline", ref: "42", stepId: "code", dedupKey: "k:code", harness: "stale" });
  } finally {
    console.log = log;
  }
  for (const e of events.filter((x) => x.event === "run_start" || x.event === "run_end")) assert.equal(Object.hasOwn(e, "harness"), false, e.event);
  const usage = store.readUsage();
  assert.equal(usage.length, 1);
  assert.equal(Object.hasOwn(usage[0], "harness"), false, "a non-harness run's usage record has no harness");
});

// --- harness health breaker (#621): which runs trip, the ENOENT fix, requeue vs fail ---

test("healthTrip: preflight and spawn errors trip; a fast no-output non-zero exit trips; output, timeout, cancel or a slow exit don't", () => {
  const base = { code: 1, cancelled: false, noOutput: true, wallMs: 2000 };
  assert.equal(healthTrip({ ...base, code: 0, preflight: "hermes preflight failed: no home" }), "hermes preflight failed: no home");
  assert.equal(healthTrip({ ...base, spawnError: "spawn qwen ENOENT" }), "spawn failed: spawn qwen ENOENT");
  assert.equal(healthTrip(base), "exited 1 with no output after 2s");
  assert.equal(healthTrip({ ...base, noOutput: false }), undefined, "it produced output, then failed");
  assert.equal(healthTrip({ ...base, timedOut: "idle" }), undefined);
  assert.equal(healthTrip({ ...base, cancelled: true }), undefined);
  assert.equal(healthTrip({ ...base, code: 0 }), undefined);
  assert.equal(healthTrip({ ...base, wallMs: 30000 }), undefined, "past the default 30s grace");
  assert.equal(healthTrip({ ...base, wallMs: 30000, downGraceSeconds: 60 }), "exited 1 with no output after 30s");
});

test("modelApiFailure: ECONNREFUSED/ENOTFOUND/EHOSTUNREACH/ETIMEDOUT/ECONNRESET, both egress-proxy failure forms, cannot-resolve and 502/503/504 match; 4xx never does, even alongside a matching token", () => {
  for (const token of ["ECONNREFUSED", "ENOTFOUND", "EHOSTUNREACH", "ETIMEDOUT", "ECONNRESET"]) {
    assert.equal(modelApiFailure(`connect ${token} 10.0.0.1:443`), `connect ${token} 10.0.0.1:443`);
  }
  assert.equal(modelApiFailure("agenthook egress: upstream 127.0.0.1:11434 failed: connect ECONNREFUSED 127.0.0.1:11434"), "agenthook egress: upstream 127.0.0.1:11434 failed: connect ECONNREFUSED 127.0.0.1:11434");
  assert.equal(modelApiFailure("agenthook egress: 127.0.0.1:11434 failed: connect ECONNREFUSED 127.0.0.1:11434"), "agenthook egress: 127.0.0.1:11434 failed: connect ECONNREFUSED 127.0.0.1:11434");
  assert.equal(modelApiFailure("agenthook egress: cannot resolve ollama.local: ENOTFOUND"), "agenthook egress: cannot resolve ollama.local: ENOTFOUND");
  for (const code of ["502", "503", "504"]) assert.equal(modelApiFailure(`API Error: ${code} backend down`), `API Error: ${code} backend down`);
  for (const code of ["400", "401", "403", "404", "429"]) {
    assert.equal(modelApiFailure(`API Error: ${code} bad request`), undefined);
    assert.equal(modelApiFailure(`API Error: ${code} bad request ECONNRESET`), undefined, "a 4xx line never matches, even with another token");
  }
  assert.equal(modelApiFailure("some normal output\nnothing here"), undefined);
  assert.equal(modelApiFailure(undefined), undefined);
  // first matching line, clipped
  const long = "x".repeat(250) + " ECONNRESET";
  assert.equal(modelApiFailure(`fine\n${long}\nECONNREFUSED too`), long.slice(0, 200));
  assert.equal(modelApiFailure("fine\nECONNRESET\nECONNREFUSED too"), "ECONNRESET");
});

test("healthTrip: a connection-level model-API failure trips at any wall time (no-output, non-zero, not timeout/cancel)", () => {
  const base = { code: 1, cancelled: false, noOutput: true, wallMs: 180000 }; // well past the default grace
  for (const token of ["ECONNREFUSED", "ENOTFOUND", "EHOSTUNREACH", "ETIMEDOUT", "ECONNRESET"]) {
    assert.equal(healthTrip({ ...base, apiDown: `connect ${token} x` }), `model API unreachable: connect ${token} x`);
  }
  assert.equal(healthTrip({ ...base, apiDown: "agenthook egress: upstream 1.2.3.4:443 failed: x" }), "model API unreachable: agenthook egress: upstream 1.2.3.4:443 failed: x");
  assert.equal(healthTrip({ ...base, apiDown: "agenthook egress: 1.2.3.4:443 failed: x" }), "model API unreachable: agenthook egress: 1.2.3.4:443 failed: x");
  assert.equal(healthTrip({ ...base, apiDown: "agenthook egress: cannot resolve h: ENOTFOUND" }), "model API unreachable: agenthook egress: cannot resolve h: ENOTFOUND");
  assert.equal(healthTrip({ ...base, apiDown: "API Error: 502 down" }), "model API unreachable: API Error: 502 down");

  assert.equal(healthTrip({ ...base, noOutput: false, apiDown: "ECONNREFUSED" }), undefined, "output was produced");
  assert.equal(healthTrip({ ...base, code: 0, apiDown: "ECONNREFUSED" }), undefined, "clean exit");
  assert.equal(healthTrip({ ...base, timedOut: "idle", apiDown: "ECONNREFUSED" }), undefined, "a timeout never trips");
  assert.equal(healthTrip({ ...base, cancelled: true, apiDown: "ECONNREFUSED" }), undefined, "a cancel never trips");

  const upstreamFailures = [{ host: "192.168.68.2", port: 11434, error: "connect ECONNREFUSED" }];
  assert.equal(
    healthTrip({ ...base, upstreamFailures, baseUrl: "http://192.168.68.2:11434" }),
    "model API unreachable: 192.168.68.2:11434 connect ECONNREFUSED",
    "an upstream-failures entry for the base-URL host trips",
  );
  assert.equal(
    healthTrip({ ...base, upstreamFailures: [{ host: "10.0.0.9", port: 11434, error: "x" }], baseUrl: "http://192.168.68.2:11434" }),
    undefined,
    "an entry for a different host does not trip (and there is no apiDown here)",
  );
  assert.equal(
    healthTrip({ ...base, upstreamFailures, baseUrl: "http://192.168.68.2:11434", apiDown: "ECONNRESET elsewhere" }),
    "model API unreachable: 192.168.68.2:11434 connect ECONNREFUSED",
    "the structured upstream-failures source wins over apiDown when both are present",
  );
  // the existing fast-exit cases are unchanged (still governed by downGraceSeconds)
  assert.equal(healthTrip({ code: 1, cancelled: false, noOutput: true, wallMs: 2000, apiDown: "irrelevant, inside grace" }), "exited 1 with no output after 2s");
});

test("cooldownFor: the base cooldown, doubled per strike, capped at 60", () => {
  assert.deepEqual([1, 2, 3, 4].map((s) => cooldownFor(10, s)), [10, 20, 40, 60]);
  assert.equal(cooldownFor(60, 1), 60);
});

test("agentPreflight: only the agent's own preflight is a health signal — policy and sandbox refusals are not", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthook-preflight-"));
  const logPath = path.join(dir, "run.log");
  const { agentPreflight } = createSpawn(/** @type {any} */ ({ cfg: {} }));
  /** @param {any} [o] */
  const agent = (o = {}) => /** @type {any} */ ({ describe: () => ({ name: "fake", policy: o.policy }), ...o });
  const step = /** @type {any} */ ({ id: "code" });
  assert.deepEqual(agentPreflight(agent({ preflight: () => "backend unreachable" }), step, undefined, logPath), { reason: "backend unreachable", health: true });
  const threw = agentPreflight(agent({ preflight: () => { throw new Error("boom"); } }), step, undefined, logPath);
  assert.deepEqual(threw, { reason: "fake preflight failed: boom", health: true });
  const policy = agentPreflight(agent({ preflight: () => "never reached" }), { ...step, allow: { bash: ["ls"] } }, undefined, logPath);
  assert.equal(policy?.health, undefined);
  assert.match(String(policy?.reason), /cannot enforce step "code" allow policy/);
  const sandbox = agentPreflight(agent(), step, undefined, logPath, { sandboxed: true });
  assert.equal(sandbox?.health, undefined);
  assert.match(String(sandbox?.reason), /does not support the sandbox/);
  assert.equal(agentPreflight(agent({ preflight: () => undefined }), step, undefined, logPath), undefined);
});

/**
 * One pipeline run through the real dispatcher with the given cfg overrides; returns the settle
 * info, the events and the advances. @param {string} dir @param {any} over @param {any} [job]
 */
async function dispatchOnce(dir, over, job = {}) {
  const cfg = /** @type {any} */ ({ repoPath: dir, worktreePrefix: path.join(dir, "wt"), dataDir: dir, logDir: dir, instructionsFile: path.join(dir, "none.md"), ...over });
  const store = createStore(dir);
  /** @type {any[]} */ const events = [];
  /** @type {any[]} */ const advanced = [];
  const adapter = /** @type {any} */ ({
    describe: () => ({ platform: "GitHub", taskNoun: "issue", trigger: "@agent", commentHowTo: "comment" }),
    fetchTask: async (/** @type {string} */ ref) => ({ ref, name: "t", description: "d", url: "u", completed: false, assignedToUs: true }),
    advance: async (/** @type {string} */ ref, /** @type {string} */ stepId, /** @type {any} */ v) => advanced.push([ref, stepId, v.outcome, v.reason]),
  });
  const emit = (/** @type {string} */ event, /** @type {string} */ _r, /** @type {string} */ _s, /** @type {any} */ extra) => events.push({ event, ...extra });
  const run = createDispatcher(cfg, adapter, undefined, store, emit);
  const log = console.log;
  console.log = () => {};
  try {
    const info = await run({ kind: "pipeline", ref: "42", stepId: "code", dedupKey: "k:code", ...job });
    return { info: /** @type {any} */ (info), events, advanced, store };
  } finally {
    console.log = log;
  }
}

test("ENOENT: a missing agent bin fails the run (spawn failed) instead of crashing the receiver — no harnesses", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthook-enoent-"));
  const { info, events, advanced } = await dispatchOnce(dir, { pipeline: [{ id: "code" }], claudeBin: path.join(dir, "no-such-bin") });
  assert.equal(advanced.length, 1);
  assert.equal(advanced[0][2], "fail");
  assert.match(advanced[0][3], /^spawn failed: .*ENOENT/);
  assert.equal(info.health, undefined, "no breaker without harnesses");
  assert.equal(events.find((e) => e.event === "run_end")?.outcome, "fail");
  const logFile = fs.readdirSync(dir).find((f) => f.endsWith(".log"));
  assert.match(fs.readFileSync(path.join(dir, String(logFile)), "utf8"), /\[agenthook\] spawn failed: .*ENOENT/);
});

test("breaker: a harnessed run whose bin is missing is requeued (run_end requeued, no move) under the attempt cap", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthook-trip-"));
  const harnesses = { local: { bin: path.join(dir, "no-such-bin") }, cloud: {} };
  const { info, events, advanced, store } = await dispatchOnce(dir, { harnesses, pipeline: [{ id: "code", harness: ["local", "cloud"] }] }, { harness: "local" });
  assert.deepEqual(advanced, [], "the ticket is not moved");
  assert.equal(info.health.harness, "local");
  assert.equal(info.health.requeue, true);
  assert.match(info.health.reason, /^spawn failed: .*ENOENT/);
  const end = events.find((e) => e.event === "run_end");
  assert.equal(end.outcome, "requeued");
  assert.equal(end.harness, "local");
  assert.equal(end.reason, info.health.reason);
  assert.equal(events.some((e) => e.event === "failed"), false);
  assert.deepEqual(store.listRunning(), {}, "the running record is cleared");
  assert.equal(store.getAttempt("42", "code"), 1, "the attempt still counts");
});

test("breaker: at the attempt cap a tripping run fails as before, and still reports health (requeue false)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthook-trip-cap-"));
  const store = createStore(dir);
  store.bumpAttempt("42", "code"); // this run is the 2nd: the cap is 2
  const harnesses = { local: { bin: path.join(dir, "no-such-bin") } };
  const { info, events, advanced } = await dispatchOnce(dir, { harnesses, pipeline: [{ id: "code", harness: "local", maxAttempts: 2 }] }, { harness: "local" });
  assert.equal(advanced.length, 1);
  assert.equal(advanced[0][2], "fail");
  assert.match(advanced[0][3], /^spawn failed: .*ENOENT/);
  assert.equal(info.health.requeue, false);
  assert.equal(info.health.harness, "local");
  assert.equal(events.find((e) => e.event === "run_end")?.outcome, "fail");
});

test("breaker: a fast non-zero exit with no output trips its harness; a clean run reports no health", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthook-trip-exit-"));
  const bad = path.join(dir, "bad.sh");
  fs.writeFileSync(bad, "#!/bin/sh\necho 'connection refused' >&2\nexit 3\n", { mode: 0o755 });
  const good = path.join(dir, "good.sh");
  fs.writeFileSync(good, `#!/bin/sh\nprintf '%s' '{"outcome":"advance"}' > "$AGENTHOOK_VERDICT_FILE"\n`, { mode: 0o755 });
  const harnesses = { local: { bin: bad }, cloud: { bin: good } };
  const pipeline = [{ id: "code", harness: ["local", "cloud"] }, { id: "done", manual: true }];
  const tripped = await dispatchOnce(dir, { harnesses, pipeline }, { harness: "local" });
  assert.match(String(tripped.info.health?.reason), /^exited 3 with no output after \d+s$/);
  assert.equal(tripped.info.health?.requeue, true);
  const ok = await dispatchOnce(dir, { harnesses, pipeline }, { harness: "cloud" });
  assert.equal(ok.info.health, undefined);
  assert.equal(ok.advanced[0][2], "advance");
});

/** A fake claude bin emitting one `API Error: <code> …` line as rendered assistant text (so the
 * dispatcher's bounded scan sees it exactly as a real Claude Code run would), then sleeping past
 * `downGraceSeconds` before a no-output non-zero exit. @param {string} line */
const apiErrorBin = (line) =>
  `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: line }] } })}'\nsleep 1.2\nexit 1\n`;

test("breaker: a no-output exit past downGraceSeconds trips when its output names a connection-level model-API failure (#639)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthook-trip-apidown-"));
  const bin = path.join(dir, "down.sh");
  fs.writeFileSync(bin, apiErrorBin("API Error: 502 agenthook egress: upstream 127.0.0.1:11434 failed: connect ECONNREFUSED 127.0.0.1:11434"), { mode: 0o755 });
  const harnesses = { local: { bin, downGraceSeconds: 1 } };
  const { info, events, advanced } = await dispatchOnce(dir, { harnesses, pipeline: [{ id: "code", harness: ["local"] }] }, { harness: "local" });
  assert.deepEqual(advanced, [], "the ticket is not moved");
  assert.equal(info.health.harness, "local");
  assert.equal(info.health.requeue, true);
  assert.match(info.health.reason, /^model API unreachable: /);
  const end = events.find((e) => e.event === "run_end");
  assert.equal(end.outcome, "requeued");
  assert.equal(events.some((e) => e.event === "failed"), false);
});

test("breaker: the same shape with a 4xx API Error line never trips — plain fail, no health", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthook-no-trip-4xx-"));
  const bin = path.join(dir, "down.sh");
  fs.writeFileSync(bin, apiErrorBin("API Error: 401 unauthorized"), { mode: 0o755 });
  const harnesses = { local: { bin, downGraceSeconds: 1 } };
  const { info, events, advanced } = await dispatchOnce(dir, { harnesses, pipeline: [{ id: "code", harness: ["local"] }] }, { harness: "local" });
  assert.equal(info.health, undefined, "a 4xx line never trips the breaker");
  assert.equal(advanced[0][2], "fail");
  assert.equal(events.find((e) => e.event === "run_end")?.outcome, "fail");
  assert.equal(events.some((e) => e.event === "harness_down"), false);
});
