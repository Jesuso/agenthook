import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// Named harnesses (#619) in dispatch: resolveHarness (the effective step a run spawns with) and a
// run driven through the real dispatcher with a fake agent bin (no network).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveHarness, harnessesOf } from "../src/dispatch/harness.js";
import { resolveModelEffort, createDispatcher } from "../src/dispatch.js";
import { agentFor } from "../src/agents/index.js";
import { createStore } from "../src/store.js";

const HARNESSES = {
  qwen: { agent: "claude", model: "qwen3-coder", bin: "claude-local", env: { ANTHROPIC_BASE_URL: "http://localhost:11434", SHARED: "harness" }, maxConcurrent: 1 },
  deepseek: { agent: "opencode", model: "deepseek/deepseek-v3", provider: "openrouter", toolsets: ["terminal"], sandbox: { image: "agent-opencode:1" } },
  bare: {},
};

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
    `#!/bin/sh\nprintf '%s\\n' "$@" > "${out}.argv"\nprintf 'BASE=%s\\nSHARED=%s\\n' "\${ANTHROPIC_BASE_URL-unset}" "\${SHARED-unset}" > "${out}"\nn=0; while [ ! -f "${path.join(dir, "running.json")}" ] && [ $n -lt 100 ]; do sleep 0.05; n=$((n+1)); done\ncp "${path.join(dir, "running.json")}" "${out}.running"\nprintf '%s' '{"outcome":"advance"}' > "$AGENTHOOK_VERDICT_FILE"\n`,
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
});

test("dispatch: a profile without harnesses keeps run_start/run_end free of a harness field", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthook-dispatch-harness-"));
  const bin = path.join(dir, "fake-claude.sh");
  fs.writeFileSync(bin, `#!/bin/sh\nprintf '%s' '{"outcome":"advance"}' > "$AGENTHOOK_VERDICT_FILE"\n`, { mode: 0o755 });
  const cfg = /** @type {any} */ ({ pipeline: [{ id: "code" }], claudeBin: bin, repoPath: dir, worktreePrefix: path.join(dir, "wt"), dataDir: dir, logDir: dir, instructionsFile: path.join(dir, "none.md") });
  /** @type {any[]} */ const events = [];
  const adapter = /** @type {any} */ ({
    describe: () => ({ platform: "GitHub", taskNoun: "issue", trigger: "@agent", commentHowTo: "comment" }),
    fetchTask: async (/** @type {string} */ ref) => ({ ref, name: "t", description: "d", url: "u", completed: false, assignedToUs: true }),
    advance: async () => {},
  });
  const run = createDispatcher(cfg, adapter, undefined, createStore(dir), (/** @type {string} */ event, /** @type {string} */ _r, /** @type {string} */ _s, /** @type {any} */ extra) => events.push({ event, ...extra }));
  const log = console.log;
  console.log = () => {};
  try {
    await run({ kind: "pipeline", ref: "42", stepId: "code", dedupKey: "k:code", harness: "stale" });
  } finally {
    console.log = log;
  }
  for (const e of events.filter((x) => x.event === "run_start" || x.event === "run_end")) assert.equal(Object.hasOwn(e, "harness"), false, e.event);
});
