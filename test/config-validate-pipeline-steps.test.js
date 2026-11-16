import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// validateRawConfig — per-step knob checks (maxConcurrent, verdictRepairs, deduceVerdict, gate,
// bin/env, opencodeConfig, contextTokens, agent/provider, agentEnvPassthrough, toolsets/isolated,
// allow/deny, ui, pricing, energy): each knob's valid shape, bad shapes, and the "has no effect
// on a manual step" rule where it applies.
import test from "node:test";
import assert from "node:assert/strict";
import { validateRawConfig } from "../src/config.js";
import { raw } from "./_config-validate-helpers.js";

test("pipeline step maxConcurrent: a positive integer passes; 0, -1, 1.5, \"2\" and a manual step fail", () => {
  assert.deepEqual(validateRawConfig(raw({}, [{ id: "triage", maxConcurrent: 1 }, { id: "code", maxConcurrent: 99 }])), { ok: true });
  for (const v of [0, -1, 1.5, "2"]) {
    const r = validateRawConfig(raw({}, [{ id: "triage", maxConcurrent: v }]));
    assert.deepEqual(!r.ok && r.errors, [`config: pipeline step "triage" maxConcurrent must be a positive integer.`], `maxConcurrent ${JSON.stringify(v)}`);
  }
  const m = validateRawConfig(raw({}, [{ id: "code" }, { id: "done", manual: true, maxConcurrent: 1 }]));
  assert.deepEqual(!m.ok && m.errors, [`config: pipeline step "done" maxConcurrent has no effect on a manual step (no agent runs).`]);
});

test("pipeline step verdictRepairs: a non-negative integer passes; -1, 1.5, \"2\" and a manual step fail", () => {
  assert.deepEqual(validateRawConfig(raw({}, [{ id: "triage", verdictRepairs: 0 }, { id: "code", verdictRepairs: 3 }])), { ok: true });
  for (const v of [-1, 1.5, "2"]) {
    const r = validateRawConfig(raw({}, [{ id: "triage", verdictRepairs: v }]));
    assert.deepEqual(!r.ok && r.errors, [`config: pipeline step "triage" verdictRepairs must be an integer >= 0.`], `verdictRepairs ${JSON.stringify(v)}`);
  }
  const m = validateRawConfig(raw({}, [{ id: "code" }, { id: "done", manual: true, verdictRepairs: 1 }]));
  assert.deepEqual(!m.ok && m.errors, [`config: pipeline step "done" verdictRepairs has no effect on a manual step (no agent runs).`]);
});

test("pipeline step deduceVerdict: a boolean passes; a non-boolean and a manual step fail", () => {
  assert.deepEqual(validateRawConfig(raw({}, [{ id: "triage", deduceVerdict: true }, { id: "code", deduceVerdict: false }])), { ok: true });
  for (const v of [0, 1, "true"]) {
    const r = validateRawConfig(raw({}, [{ id: "triage", deduceVerdict: v }]));
    assert.deepEqual(!r.ok && r.errors, [`config: pipeline step "triage" deduceVerdict must be a boolean.`], `deduceVerdict ${JSON.stringify(v)}`);
  }
  const m = validateRawConfig(raw({}, [{ id: "code" }, { id: "done", manual: true, deduceVerdict: false }]));
  assert.deepEqual(!m.ok && m.errors, [`config: pipeline step "done" deduceVerdict has no effect on a manual step (no agent runs).`]);
});

test("pipeline step gate: a non-empty string or array passes; empty/wrong shapes and a manual step fail", () => {
  assert.deepEqual(validateRawConfig(raw({}, [{ id: "triage", gate: "npm test" }, { id: "code", gate: ["sh", "-c", "npm test"] }])), { ok: true });
  for (const v of ["", [], [""], [5], 5]) {
    const r = validateRawConfig(raw({}, [{ id: "triage", gate: v }]));
    assert.deepEqual(!r.ok && r.errors, [`config: pipeline step "triage" gate must be a non-empty string or a non-empty array of strings.`], `gate ${JSON.stringify(v)}`);
  }
  const m = validateRawConfig(raw({}, [{ id: "code" }, { id: "done", manual: true, gate: "npm test" }]));
  assert.deepEqual(!m.ok && m.errors, [`config: pipeline step "done" gate has no effect on a manual step (no agent runs).`]);
});

test("pipeline step gateTimeoutMinutes: a positive number passes; 0/-1/non-number fail, and it needs a \"gate\"", () => {
  assert.deepEqual(validateRawConfig(raw({}, [{ id: "triage", gate: "npm test", gateTimeoutMinutes: 5 }])), { ok: true });
  for (const v of [0, -1, "5"]) {
    const r = validateRawConfig(raw({}, [{ id: "triage", gate: "npm test", gateTimeoutMinutes: v }]));
    assert.deepEqual(!r.ok && r.errors, [`config: pipeline step "triage" gateTimeoutMinutes must be a number > 0.`], `gateTimeoutMinutes ${JSON.stringify(v)}`);
  }
  const m = validateRawConfig(raw({}, [{ id: "triage", gateTimeoutMinutes: 5 }]));
  assert.deepEqual(!m.ok && m.errors, [`config: pipeline step "triage" gateTimeoutMinutes has no effect without a "gate".`]);
});

test("pipeline step bin/env: a valid pair and ${VAR} values pass; bad shapes, names and the reserved key fail", () => {
  const ok = validateRawConfig(raw({}, [{ id: "code", bin: "claude-local", env: { CLAUDE_CONFIG_DIR: "/home/x/.claude-alt", API_KEY: "${ALT_KEY}", _x1: "" } }]));
  assert.deepEqual(ok, { ok: true });
  /** @param {any} step */
  const errs = (step) => /** @type {any} */ (validateRawConfig(raw({}, [{ id: "code", ...step }]))).errors;
  assert.deepEqual(errs({ bin: "" }), [`config: pipeline step "code" bin must be a non-empty string (a name on PATH or an absolute path).`]);
  assert.deepEqual(errs({ bin: "  " }), [`config: pipeline step "code" bin must be a non-empty string (a name on PATH or an absolute path).`]);
  assert.deepEqual(errs({ bin: 5 }), [`config: pipeline step "code" bin must be a non-empty string (a name on PATH or an absolute path).`]);
  assert.deepEqual(errs({ env: [] }), [`config: pipeline step "code" env must be an object of NAME: "value" strings.`]);
  assert.deepEqual(errs({ env: "A=1" }), [`config: pipeline step "code" env must be an object of NAME: "value" strings.`]);
  assert.deepEqual(errs({ env: { A: 1 } }), [`config: pipeline step "code" env.A must be a string.`]);
  assert.deepEqual(errs({ env: { "1BAD": "x" } }), [`config: pipeline step "code" env key "1BAD" is not a valid variable name.`]);
  assert.deepEqual(errs({ env: { "A-B": "x" } }), [`config: pipeline step "code" env key "A-B" is not a valid variable name.`]);
  assert.deepEqual(errs({ env: { AGENTHOOK_VERDICT_FILE: "x" } }), [`config: pipeline step "code" env key AGENTHOOK_VERDICT_FILE is reserved (the receiver sets it).`]);
  // null = unset (the editor's clear), like every other optional step key
  assert.deepEqual(validateRawConfig(raw({}, [{ id: "code", bin: null, env: null }])), { ok: true });
});

test("pipeline step opencodeConfig: a non-empty string passes; an empty one or a non-string fails", () => {
  assert.deepEqual(validateRawConfig(raw({}, [{ id: "code", opencodeConfig: "~/.config/opencode/opencode.json" }])), { ok: true });
  /** @param {any} step */
  const errs = (step) => /** @type {any} */ (validateRawConfig(raw({}, [{ id: "code", ...step }]))).errors;
  assert.deepEqual(errs({ opencodeConfig: "" }), [`config: pipeline step "code" opencodeConfig must be a non-empty string.`]);
  assert.deepEqual(errs({ opencodeConfig: 5 }), [`config: pipeline step "code" opencodeConfig must be a non-empty string.`]);
  assert.deepEqual(validateRawConfig(raw({}, [{ id: "code", opencodeConfig: null }])), { ok: true });
});

test("pipeline step contextTokens: a positive integer passes; 0, negative, non-integer or a string fails", () => {
  assert.deepEqual(validateRawConfig(raw({}, [{ id: "code", contextTokens: 64000 }])), { ok: true });
  /** @param {any} step */
  const errs = (step) => /** @type {any} */ (validateRawConfig(raw({}, [{ id: "code", ...step }]))).errors;
  for (const v of [0, -1, 1.5, "64000"]) assert.deepEqual(errs({ contextTokens: v }), [`config: pipeline step "code" contextTokens must be a positive integer.`], JSON.stringify(v));
  assert.deepEqual(validateRawConfig(raw({}, [{ id: "code", contextTokens: null }])), { ok: true });
});

test("agent: unset or \"claude\" passes at the top level and on a step; unknown names and manual steps fail", () => {
  assert.deepEqual(validateRawConfig(raw({ agent: "claude" }, [{ id: "code", agent: "claude" }])), { ok: true });
  assert.deepEqual(validateRawConfig(raw({ agent: undefined }, [{ id: "code", agent: null }])), { ok: true });
  assert.deepEqual(validateRawConfig(raw({ agent: "opencode" }, [{ id: "code", agent: "opencode", model: "ollama/qwen3.8:27b-64k" }])), { ok: true });
  /** @param {any} r */
  const errs = (r) => /** @type {any} */ (validateRawConfig(r)).errors;
  assert.deepEqual(errs(raw({ agent: "nope" })), [`config: "agent" "nope" is not a known agent (claude, cursor, hermes, opencode).`]);
  assert.deepEqual(errs(raw({ agent: 5 })), [`config: "agent" 5 is not a known agent (claude, cursor, hermes, opencode).`]);
  assert.deepEqual(errs(raw({}, [{ id: "code", agent: "nope" }])), [`config: pipeline step "code" agent "nope" is not a known agent (claude, cursor, hermes, opencode).`]);
  assert.deepEqual(errs(raw({}, [{ id: "code", agent: "constructor" }])), [`config: pipeline step "code" agent "constructor" is not a known agent (claude, cursor, hermes, opencode).`]);
  assert.deepEqual(errs(raw({}, [{ id: "code" }, { id: "done", manual: true, agent: "claude" }])), [
    `config: pipeline step "done" agent has no effect on a manual step (no agent runs).`,
  ]);
});

test("provider: unset or a non-empty string passes at the top level (agentProvider) and on a step; bad shapes and manual steps fail", () => {
  assert.deepEqual(validateRawConfig(raw({ agentProvider: "openai-codex" }, [{ id: "code", provider: "ollama-launch" }])), { ok: true });
  assert.deepEqual(validateRawConfig(raw({ agentProvider: undefined }, [{ id: "code", provider: null }])), { ok: true });
  /** @param {any} r */
  const errs = (r) => /** @type {any} */ (validateRawConfig(r)).errors;
  assert.deepEqual(errs(raw({ agentProvider: "" })), [`config: "agentProvider" must be a non-empty string.`]);
  assert.deepEqual(errs(raw({ agentProvider: "  " })), [`config: "agentProvider" must be a non-empty string.`]);
  assert.deepEqual(errs(raw({ agentProvider: 5 })), [`config: "agentProvider" must be a non-empty string.`]);
  assert.deepEqual(errs(raw({}, [{ id: "code", provider: "" }])), [`config: pipeline step "code" provider must be a non-empty string.`]);
  assert.deepEqual(errs(raw({}, [{ id: "code", provider: 5 }])), [`config: pipeline step "code" provider must be a non-empty string.`]);
  assert.deepEqual(errs(raw({}, [{ id: "code" }, { id: "done", manual: true, provider: "ollama-launch" }])), [
    `config: pipeline step "done" provider has no effect on a manual step (no agent runs).`,
  ]);
});

test("agentEnvPassthrough: names, PREFIX* and \"*\" pass; a non-array and bad entries fail", () => {
  assert.deepEqual(validateRawConfig(raw({ agentEnvPassthrough: ["AWS_*", "OPENAI_API_KEY"] })), { ok: true });
  assert.deepEqual(validateRawConfig(raw({ agentEnvPassthrough: ["*"] })), { ok: true });
  assert.deepEqual(validateRawConfig(raw({ agentEnvPassthrough: [] })), { ok: true });
  /** @param {any} r */
  const errs = (r) => /** @type {any} */ (validateRawConfig(r)).errors;
  assert.deepEqual(errs(raw({ agentEnvPassthrough: "AWS_*" })), [`config: "agentEnvPassthrough" must be an array of variable names, PREFIX*, or "*".`]);
  for (const bad of ["A B", "*X", "X**", 5]) {
    assert.deepEqual(errs(raw({ agentEnvPassthrough: [bad] })), [`config: "agentEnvPassthrough" entry ${JSON.stringify(bad)} must be a variable name, a PREFIX*, or "*".`], String(bad));
  }
});

test("toolsets / isolated: valid shapes pass on a step; bad shapes and manual steps fail", () => {
  assert.deepEqual(validateRawConfig(raw({}, [{ id: "code", toolsets: ["terminal", "file"], isolated: false }])), { ok: true });
  assert.deepEqual(validateRawConfig(raw({}, [{ id: "code", toolsets: null, isolated: true }])), { ok: true });
  /** @param {any} r */
  const errs = (r) => /** @type {any} */ (validateRawConfig(r)).errors;
  const bad = `config: pipeline step "code" toolsets must be a non-empty array of non-empty strings.`;
  assert.deepEqual(errs(raw({}, [{ id: "code", toolsets: "terminal" }])), [bad]);
  assert.deepEqual(errs(raw({}, [{ id: "code", toolsets: [] }])), [bad]);
  assert.deepEqual(errs(raw({}, [{ id: "code", toolsets: ["terminal", 5] }])), [bad]);
  assert.deepEqual(errs(raw({}, [{ id: "code", toolsets: [" "] }])), [bad]);
  assert.deepEqual(errs(raw({}, [{ id: "code", isolated: "yes" }])), [`config: pipeline step "code" isolated must be true or false.`]);
  assert.deepEqual(errs(raw({}, [{ id: "code" }, { id: "done", manual: true, toolsets: ["file"], isolated: false }])), [
    `config: pipeline step "done" toolsets has no effect on a manual step (no agent runs).`,
    `config: pipeline step "done" isolated has no effect on a manual step (no agent runs).`,
  ]);
});

test("allow / deny: valid policies pass; bad shapes, unsafe entries and manual steps fail", () => {
  const ok = { allow: { commands: ["git", "npm test"], paths: ["src/**", "test/**"] }, deny: { commands: ["curl"], paths: [".github/workflows/**", ".env*"] } };
  assert.deepEqual(validateRawConfig(raw({}, [{ id: "code", ...ok }])), { ok: true });
  assert.deepEqual(validateRawConfig(raw({}, [{ id: "review", allow: { commands: ["gh pr"] } }])), { ok: true });
  /** @param {any} step */
  const errs = (step) => /** @type {any} */ (validateRawConfig(raw({}, [{ id: "code", ...step }]))).errors;
  /** @param {any} step @param {RegExp} re */
  const rejects = (step, re) => {
    const e = errs(step);
    assert.equal(e?.length, 1, JSON.stringify(step));
    assert.match(e[0], /^config: pipeline step "code" (allow|deny)/);
    assert.match(e[0], re);
  };
  rejects({ allow: { commands: ["git"], files: ["x"] } }, /unknown key\(s\) "files"/);
  rejects({ deny: {} }, /must set "commands" or "paths"/);
  rejects({ allow: ["git"] }, /must be an object/);
  rejects({ allow: { commands: [] } }, /allow\.commands must be a non-empty array/);
  rejects({ allow: { paths: [5] } }, /allow\.paths entry 5/);
  rejects({ allow: { commands: [" git"] } }, /trimmed/);
  rejects({ allow: { paths: ["/etc/**"] } }, /relative to the run's cwd/);
  rejects({ deny: { paths: ["~/.ssh/**"] } }, /relative to the run's cwd/);
  rejects({ allow: { paths: ["C:/x"] } }, /relative to the run's cwd/);
  rejects({ allow: { paths: ["src/../../etc"] } }, /relative to the run's cwd/);
  rejects({ deny: { commands: ["curl)"] } }, /no newline, "\(", "\)" or ","/);
  rejects({ allow: { commands: ["git\nrm"] } }, /no newline/);
  assert.deepEqual(/** @type {any} */ (validateRawConfig(raw({}, [{ id: "code" }, { id: "done", manual: true, ...ok }]))).errors, [
    `config: pipeline step "done" allow has no effect on a manual step (no agent runs).`,
    `config: pipeline step "done" deny has no effect on a manual step (no agent runs).`,
  ]);
});

test("ui identity block: valid values pass, unknown colour / emoji / shape are errors", () => {
  assert.deepEqual(validateRawConfig(raw({ ui: { color: "teal", emoji: "🚀" } })), { ok: true });
  assert.deepEqual(validateRawConfig(raw({ ui: {} })), { ok: true });
  const bad = (/** @type {any} */ ui) => /** @type {any} */ (validateRawConfig(raw({ ui }))).errors;
  assert.match(bad({ color: "red" })[0], /ui\.color must be one of/);
  assert.match(bad({ emoji: "zz" })[0], /ui\.emoji must be one of/);
  assert.match(bad("teal")[0], /"ui" must be an object/);
});

test("pricing: invalid rates fail validation with a clear message; a valid block passes", () => {
  assert.deepEqual(validateRawConfig(raw({ pricing: { "qwen3.8*": { input: 2, output: 10, cacheRead: 0.2 } } })), { ok: true });
  const v = validateRawConfig(raw({ pricing: { "qwen*": { input: -1 } } }));
  assert.equal(v.ok, false);
  assert.ok(!v.ok && v.errors.some((e) => /pricing\["qwen\*"\]\.input must be a finite number ≥ 0/.test(e)), JSON.stringify(v));
  assert.ok(!v.ok && v.errors.some((e) => /pricing\["qwen\*"\]\.output is required/.test(e)));
});

test("energy: a valid block + step opt-in pass; bad step values, a missing block, a manual step and bad shapes fail", () => {
  const energy = { usdPerKwh: 0.15, source: { type: "hwmon" } };
  assert.deepEqual(validateRawConfig(raw({ energy }, [{ id: "code", energy: true }])), { ok: true });
  assert.deepEqual(validateRawConfig(raw({ energy }, [{ id: "code", energy: false }])), { ok: true });
  assert.deepEqual(validateRawConfig(raw({}, [{ id: "code", energy: false }])), { ok: true }, "energy:false needs no block");
  /** @param {any} r */
  const errs = (r) => /** @type {any} */ (validateRawConfig(r)).errors;
  assert.deepEqual(errs(raw({ energy }, [{ id: "code", energy: "yes" }])), [`config: pipeline step "code" energy must be true or false.`]);
  assert.deepEqual(errs(raw({}, [{ id: "code", energy: true }])), [`config: pipeline step "code" energy:true needs a profile "energy" block ({usdPerKwh, source}).`]);
  assert.deepEqual(errs(raw({ energy }, [{ id: "code" }, { id: "done", manual: true, energy: true }])), [
    `config: pipeline step "done" energy has no effect on a manual step (no agent runs).`,
  ]);
  assert.match(errs(raw({ energy: { usdPerKwh: -1, source: { type: "hwmon" } } }))[0], /energy\.usdPerKwh must be a finite number ≥ 0/);
  assert.match(errs(raw({ energy: { usdPerKwh: 0.15, source: { type: "rapl" } } }))[0], /energy\.source\.type must be one of hwmon, command, watts/);
  assert.match(errs(raw({ energy: { usdPerKwh: 0.15, source: { type: "command" } } }))[0], /energy\.source\.cmd is required/);
  assert.match(errs(raw({ energy: { usdPerKwh: 0.15, source: { type: "watts" } } }))[0], /energy\.source\.watts is required/);
});
