import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// validateRawConfig / literalSecrets — the pure, env-free config checks the v3 UI config editor
// runs on raw JSON (docs/web-ui.md § v3). Neither may touch fs or process.env, so the env vars
// the example config references are deleted up front: a `${VAR}` must stay an opaque value.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, validateRawConfig, literalSecrets, SECRET_FIELDS, registryDir } from "../src/config.js";
import { isEnvRef } from "../src/ui/sensitive.js";

for (const v of ["ASANA_TOKEN", "GITHUB_TOKEN", "NGROK_AUTHTOKEN", "AH_UNSET_VAR"]) delete process.env[v];
// A case loadConfig wrongly accepts would create this state dir; never leave it behind.
test.after(() => fs.rmSync(path.join(registryDir, "ah-validate-test"), { recursive: true, force: true }));

/** Minimal valid raw config; `over` replaces top-level keys (undefined deletes).
 * @param {any} [over] @param {any[]} [pipeline] @returns {any} */
function raw(over = {}, pipeline = [{ id: "code" }]) {
  /** @type {any} */
  const cfg = { name: "ah-validate-test", repoPath: "/tmp/repo", tracker: { type: "asana", pipeline }, ...over };
  for (const k of Object.keys(cfg)) if (cfg[k] === undefined) delete cfg[k];
  return cfg;
}

/** The message loadConfig throws for a raw config (written to a temp file). @param {any} cfg */
function loadError(cfg) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-cfg-validate-"));
  const file = path.join(dir, "agenthook.config.json");
  fs.writeFileSync(file, JSON.stringify(cfg));
  try {
    loadConfig({ configPath: file });
  } catch (e) {
    return e.message;
  }
  assert.fail(`loadConfig accepted ${JSON.stringify(cfg)}`);
}

test("the example config (raw, ${VAR}s intact, env unset) validates", () => {
  const example = JSON.parse(fs.readFileSync(new URL("../agenthook.config.example.json", import.meta.url), "utf8"));
  assert.deepEqual(validateRawConfig(example), { ok: true });
});

test("every loadConfig error case: errors[0] is byte-identical to what loadConfig throws", () => {
  const repos = (/** @type {any} */ r) => raw({ repoPath: undefined, repos: r });
  const cases = [
    raw({ name: undefined }),
    raw({ name: "bad name!" }),
    raw({ tracker: { pipeline: [{ id: "code" }] } }),
    raw({ repoPath: undefined }),
    repos([]),
    repos({ id: "x" }),
    repos([null]),
    repos([{ path: "./a" }]),
    repos([{ id: "bad id!", path: "./a" }]),
    repos([{ id: "a" }]),
    repos([{ id: "a", path: "./a" }, { id: "a", path: "./b" }]),
    repos([{ id: "a", path: "./a", match: ["iOS"] }, { id: "b", path: "./b", match: [" ios"] }]),
    repos([{ id: "a", path: "./a", default: true }, { id: "b", path: "./b", default: true }]),
    repos([{ id: "a", path: "./a", match: [7] }]),
    repos([{ id: "a", path: "./a", match: "ios" }]),
    repos([{ id: "a", path: "./a", default: "yes" }]),
    repos([{ id: "a", path: "./a", instructionsFile: 5 }]),
    repos([{ id: "a", path: "./a", worktreePrefix: 5 }]),
    raw({ overlapGuard: "yes" }),
    raw({}, []),
    raw({ tracker: { type: "asana" } }),
    raw({}, [{ kind: "x" }]),
    raw({}, [{ id: "code" }, { id: "code" }]),
    raw({}, [{ id: "code", maxAttempts: 0 }]),
    raw({}, [{ id: "code", maxConcurrent: 0 }]),
    raw({}, [{ id: "code", maxMinutes: -1 }]),
    raw({}, [{ id: "code", idleMinutes: 0 }]),
    raw({}, [{ id: "code", lite: { descriptionHeadings: [] } }]),
    raw({}, [{ id: "code", completeOnMerge: true }]),
    raw({}, [{ id: "done", manual: true, queueLabel: "q" }]),
    raw({}, [{ id: "code", sourceSectionGid: "S1", queueSectionGid: "S1" }]),
    raw({}, [{ id: "code", sourceStatus: "In Progress", queueStatus: "in progress " }]),
    raw({}, [{ id: "a", manual: true, completeOnMerge: true }, { id: "b", manual: true, completeOnMerge: true }]),
    raw({ sinks: {} }),
    raw({ sinks: [{ type: "email" }] }),
    raw({ sinks: [{ type: "telegram", botToken: "${AH_UNSET_VAR}" }] }),
    raw({ sinks: [{ type: "slack", url: "u", events: "run_end" }] }),
    raw({ forge: { repository: "o/r" } }),
    raw({ forge: { type: "github", ciTarget: "nope" } }),
    raw({ forge: { type: "github", ciTarget: "done" } }, [{ id: "code" }, { id: "done", manual: true }]),
  ];
  for (const cfg of cases) {
    // loadConfig interpolates first; give the one ${VAR} case a value so it reaches the checks.
    process.env.AH_UNSET_VAR = "x";
    let expected;
    try {
      expected = loadError(cfg);
    } finally {
      delete process.env.AH_UNSET_VAR;
    }
    const got = validateRawConfig(cfg);
    assert.equal(got.ok, false, JSON.stringify(cfg));
    assert.equal(!got.ok && got.errors[0], expected, JSON.stringify(cfg));
  }
});

test("the two resolution-dependent repos checks stay in loadConfig only", () => {
  const shared = raw({ repoPath: undefined, repos: [{ id: "a", path: "./x" }, { id: "b", path: "x/" }] });
  assert.deepEqual(validateRawConfig(shared), { ok: true });
  assert.match(loadError(shared), /"b" and "a" share the path/);
  const elsewhere = raw({ repoPath: "./elsewhere", repos: [{ id: "mono", path: "./mono" }] });
  assert.deepEqual(validateRawConfig(elsewhere), { ok: true });
  assert.match(loadError(elsewhere), /not one of the declared repos/);
});

test("independent errors are all reported, in check order", () => {
  const cfg = raw({ name: "bad name!", sinks: [{ type: "slack" }] }, [{ id: "code" }, { id: "code", maxAttempts: 0 }]);
  const got = validateRawConfig(cfg);
  assert.equal(got.ok, false);
  assert.deepEqual(!got.ok && got.errors, [
    `config: "name" is required and must match [A-Za-z0-9._-]+ (it keys the state dir).`,
    `config: duplicate pipeline step id "code".`,
    `config: pipeline step "code" maxAttempts must be a positive integer.`,
    `config: sinks[0] (slack) requires "url".`,
  ]);
});

test("${VAR} refs are opaque: never interpolated, never required to resolve", () => {
  const cfg = raw({
    name: "${AH_UNSET_VAR}",
    repoPath: "${AH_UNSET_VAR}",
    forge: { type: "github", token: "${AH_UNSET_VAR}", ciTarget: "${AH_UNSET_VAR}" },
    sinks: [{ type: "telegram", botToken: "${AH_UNSET_VAR}", chatId: "${AH_UNSET_VAR}" }],
  }, [{ id: "${AH_UNSET_VAR}" }]);
  cfg.tracker.token = "${AH_UNSET_VAR}";
  // name fails its own regex (the `$`, `{`, `}`), never for being unset; the rest validate.
  const got = validateRawConfig(cfg);
  assert.deepEqual(!got.ok && got.errors, [`config: "name" is required and must match [A-Za-z0-9._-]+ (it keys the state dir).`]);
  assert.deepEqual(validateRawConfig({ ...cfg, name: "ok" }), { ok: true });
  assert.equal(process.env.AH_UNSET_VAR, undefined);
});

test("//-prefixed comment keys are ignored at every level", () => {
  const cfg = raw({ "//": "top", "//forge": { type: 5 } }, [{ id: "code", "//maxAttempts": "nope" }]);
  cfg.tracker["//pipeline"] = "comment";
  assert.deepEqual(validateRawConfig(cfg), { ok: true });
});

test("garbage inputs fail closed without throwing", () => {
  for (const g of [null, undefined, [], "x", 5, true, { tracker: 5 }, { tracker: "asana" }, raw({}, [null]), raw({}, [5, "s"]), raw({ sinks: [null, 5, { type: "constructor" }] }), raw({ repos: [null, 5] }), raw({ forge: 5 })]) {
    const got = validateRawConfig(g);
    assert.equal(got.ok, false, JSON.stringify(g));
    assert.ok(!got.ok && got.errors.length && got.errors.every((e) => typeof e === "string"));
  }
  // Values whose String() throws (toString not callable) must not escape as a TypeError.
  const bad = { toString: 1 };
  for (const g of [
    raw({}, [{ id: bad, maxAttempts: 0 }]),
    raw({ forge: { type: "github", ciTarget: bad } }, [{ id: "a" }]),
    raw({}, [{ id: "a", completeOnMerge: true, manual: true }, { id: bad, completeOnMerge: true, manual: true }]),
    raw({}, [{ id: "a", sourceLabel: bad, queueLabel: bad }]),
  ]) {
    const got = validateRawConfig(g);
    assert.equal(got.ok, false, JSON.stringify(g));
    assert.ok(!got.ok && got.errors.every((e) => typeof e === "string"));
  }
  const badId = validateRawConfig(raw({}, [{ id: bad, maxAttempts: 0 }]));
  assert.deepEqual(!badId.ok && badId.errors, [`config: pipeline step "{"toString":1}" maxAttempts must be a positive integer.`]);
  const nullStep = validateRawConfig(raw({}, [null, { id: "code" }]));
  assert.deepEqual(!nullStep.ok && nullStep.errors, [`config: tracker.pipeline[0] must be an object.`]);
});

test("forge.ciTarget is not looked up against a missing pipeline", () => {
  const got = validateRawConfig(raw({ forge: { type: "github", ciTarget: "code" } }, []));
  assert.deepEqual(!got.ok && got.errors, [`config: "tracker.pipeline" is required (a non-empty array of steps).`]);
});

test("SECRET_FIELDS names every secret-bearing config path", () => {
  assert.deepEqual([...SECRET_FIELDS], [
    "tracker.token", "tracker.webhookSecret", "tracker.auth.privateKey", "forge.token", "forge.webhookSecret", "forge.auth.privateKey", "ingress.authtoken", "sinks[*].url", "sinks[*].botToken",
  ]);
});

test("isEnvRef (the browser-shared predicate literalSecrets uses): exactly one ${VAR} ref", () => {
  for (const v of ["${A}", "${GITHUB_TOKEN}", "${X_1}"]) assert.equal(isEnvRef(v), true, v);
  for (const v of ["", "a-${X}", "${x}", "${A}${B}", "$A", "${A", false, null, undefined, 1]) assert.equal(isEnvRef(v), false, String(v));
});

test("literalSecrets: only non-empty strings that are not exactly one ${VAR} ref", () => {
  const refs = raw({
    forge: { type: "github", token: "${GITHUB_TOKEN}", webhookSecret: "${FORGE_SECRET}" },
    ingress: { type: "ngrok", authtoken: "${NGROK_AUTHTOKEN}" },
    sinks: [{ type: "slack", url: "${SLACK_URL}" }],
  });
  refs.tracker.token = "${ASANA_TOKEN}";
  assert.deepEqual(literalSecrets(refs), []);

  const literal = raw();
  literal.tracker.token = "1/12345:abcdef";
  assert.deepEqual(literalSecrets(literal), ["tracker.token"]);

  const tg = raw({ sinks: [{ type: "slack", url: "${SLACK_URL}" }, { type: "telegram", botToken: "123:abc", chatId: "1" }] });
  assert.deepEqual(literalSecrets(tg), ["sinks[1].botToken"]);

  const optOut = raw({ forge: { type: "github", webhookSecret: "" } });
  optOut.tracker.webhookSecret = false;
  assert.deepEqual(literalSecrets(optOut), []);

  const prefixed = raw({ ingress: { type: "ngrok", authtoken: "a-${X}" } });
  assert.deepEqual(literalSecrets(prefixed), ["ingress.authtoken"]);

  for (const g of [null, undefined, "x", [], { tracker: 5, sinks: [null, 5] }, { sinks: "x" }]) assert.deepEqual(literalSecrets(g), []);
});

test("the example config holds no literal secrets", () => {
  const example = JSON.parse(fs.readFileSync(new URL("../agenthook.config.example.json", import.meta.url), "utf8"));
  assert.deepEqual(literalSecrets(example), []);
});

test("pipeline step maxConcurrent: a positive integer passes; 0, -1, 1.5, \"2\" and a manual step fail", () => {
  assert.deepEqual(validateRawConfig(raw({}, [{ id: "triage", maxConcurrent: 1 }, { id: "code", maxConcurrent: 99 }])), { ok: true });
  for (const v of [0, -1, 1.5, "2"]) {
    const r = validateRawConfig(raw({}, [{ id: "triage", maxConcurrent: v }]));
    assert.deepEqual(!r.ok && r.errors, [`config: pipeline step "triage" maxConcurrent must be a positive integer.`], `maxConcurrent ${JSON.stringify(v)}`);
  }
  const m = validateRawConfig(raw({}, [{ id: "code" }, { id: "done", manual: true, maxConcurrent: 1 }]));
  assert.deepEqual(!m.ok && m.errors, [`config: pipeline step "done" maxConcurrent has no effect on a manual step (no agent runs).`]);
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

// --- GitHub App auth (tracker.auth / forge.auth) ---

const APP = { type: "app", appId: "101", installationId: "202", privateKey: "${GITHUB_APP_PRIVATE_KEY}" };

test("GitHub App auth: a complete tracker + forge auth block with assigneeLogin validates", () => {
  const cfg = raw({ tracker: { type: "github", repository: "o/r", auth: APP, assigneeLogin: "alice", pipeline: [{ id: "code" }] }, forge: { type: "github", repository: "o/r", auth: APP } });
  assert.deepEqual(validateRawConfig(cfg), { ok: true });
});

test("GitHub App auth without tracker.assigneeLogin fails closed (never derived from the App token)", () => {
  for (const type of ["github", "github-projects"]) {
    const got = validateRawConfig(raw({ tracker: { type, auth: APP, pipeline: [{ id: "code" }] } }));
    assert.equal(got.ok, false);
    assert.match(!got.ok ? got.errors[0] : "", /GitHub App auth needs "tracker\.assigneeLogin"/);
  }
});

test("GitHub App auth: type, appId, installationId and exactly one of privateKey / privateKeyPath are checked; other trackers/forges reject auth", () => {
  /** @param {any} tracker @param {any} [forge] */
  const errs = (tracker, forge) => {
    const got = validateRawConfig(raw({ tracker: { type: "github", assigneeLogin: "alice", pipeline: [{ id: "code" }], ...tracker }, ...(forge ? { forge } : {}) }));
    return got.ok ? [] : got.errors;
  };
  assert.match(errs({ auth: { ...APP, type: "token" } })[0], /"tracker\.auth\.type" must be "app"/);
  assert.match(errs({ auth: { ...APP, appId: "" } })[0], /"tracker\.auth\.appId" is required/);
  assert.match(errs({ auth: { ...APP, installationId: undefined } })[0], /"tracker\.auth\.installationId" is required/);
  assert.match(errs({ auth: { ...APP, privateKey: undefined } })[0], /exactly one of "privateKey"/);
  assert.match(errs({ auth: { ...APP, privateKeyPath: "./app.pem" } })[0], /exactly one of "privateKey"/);
  assert.deepEqual(errs({ auth: { ...APP, appId: 101, installationId: 202, privateKey: undefined, privateKeyPath: "./app.pem" } }), []);
  assert.match(errs({ type: "asana", auth: APP })[0], /"tracker\.auth" is only supported on the github and github-projects trackers/);
  assert.match(errs({}, { type: "gitlab", project: "g/p", auth: APP })[0], /"forge\.auth" is only supported on the github forge/);
  assert.match(errs({}, { type: "github", auth: { ...APP, appId: "" } })[0], /"forge\.auth\.appId" is required/);
});

test("loadConfig: auth.privateKeyPath is read (relative to the config file) into privateKey; an unreadable one throws", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-cfg-app-"));
  fs.writeFileSync(path.join(dir, "app.pem"), "-----BEGIN RSA PRIVATE KEY-----\nx\n-----END RSA PRIVATE KEY-----\n");
  const file = path.join(dir, "agenthook.config.json");
  const auth = { type: "app", appId: "1", installationId: "2", privateKeyPath: "./app.pem" };
  fs.writeFileSync(file, JSON.stringify(raw({ tracker: { type: "github", repository: "o/r", assigneeLogin: "alice", auth, pipeline: [{ id: "code" }] } })));
  const cfg = loadConfig({ configPath: file });
  assert.equal(cfg.providerConfig.auth?.privateKeyPath, path.join(dir, "app.pem"));
  assert.match(String(cfg.providerConfig.auth?.privateKey), /BEGIN RSA PRIVATE KEY/);
  assert.match(loadError(raw({ tracker: { type: "github", repository: "o/r", assigneeLogin: "alice", auth: { ...auth, privateKeyPath: "./missing.pem" }, pipeline: [{ id: "code" }] } })), /cannot read "tracker\.auth\.privateKeyPath"/);
});

test("literalSecrets flags a literal PEM in tracker.auth.privateKey / forge.auth.privateKey", () => {
  const cfg = raw({ tracker: { type: "github", assigneeLogin: "alice", auth: { ...APP, privateKey: "-----BEGIN…" }, pipeline: [{ id: "code" }] }, forge: { type: "github", auth: { ...APP, privateKey: "-----BEGIN…" } } });
  assert.deepEqual(literalSecrets(cfg), ["tracker.auth.privateKey", "forge.auth.privateKey"]);
  assert.deepEqual(literalSecrets(raw({ tracker: { type: "github", assigneeLogin: "alice", auth: APP, pipeline: [{ id: "code" }] } })), []);
});
