import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// validateRawConfig / literalSecrets — GitHub App auth (tracker.auth / forge.auth), the sandbox
// block (type/image/memory/cpus, egress, services #529), named harnesses (#619) and branchPrefix
// (#674). A case loadConfig wrongly accepts would create registryDir/ah-validate-test; clean it up.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config/load.js";
import { validateRawConfig, literalSecrets } from "../src/config/validate/index.js";
import { registryDir } from "../src/config/locations.js";
import { EGRESS_PROXY_ENV_KEYS } from "../src/sandbox/names.js";
import { raw, loadError } from "./_config-validate-helpers.js";

test.after(() => fs.rmSync(path.join(registryDir, "ah-validate-test"), { recursive: true, force: true }));

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

test("sandbox: a valid block passes; type required and known; image/memory/cpus checked; step sandbox boolean and agent-only", () => {
  const ok = (/** @type {any} */ c) => validateRawConfig(c);
  assert.equal(ok(raw({ sandbox: { type: "podman", image: "mine:1", memory: "4g", cpus: 1.5 } }, [{ id: "code", sandbox: false }, { id: "done", manual: true }])).ok, true);
  /** @param {any} c */
  const errs = (c) => {
    const v = validateRawConfig(c);
    return v.ok ? [] : v.errors;
  };
  assert.deepEqual(errs(raw({ sandbox: { type: "lxc" } })), [`config: "sandbox.type" "lxc" is not a known sandbox (docker, podman).`]);
  assert.deepEqual(errs(raw({ sandbox: {} })), [`config: "sandbox.type" is required when a sandbox block is set (docker or podman).`]);
  assert.deepEqual(errs(raw({ sandbox: { type: "docker", cpus: 0 } })), [`config: "sandbox.cpus" must be a number > 0.`]);
  assert.deepEqual(errs(raw({ sandbox: { type: "docker", memory: "lots" } })), [`config: "sandbox.memory" must be a size like "4g", "512m" or bytes.`]);
  assert.deepEqual(errs(raw({ sandbox: { type: "docker", image: " " } })), [`config: "sandbox.image" must be a non-empty string.`]);
  assert.deepEqual(errs(raw({ sandbox: "docker" })), [`config: "sandbox" must be an object ({ "type": "docker" | "podman", … }).`]);
  assert.deepEqual(errs(raw({ sandbox: { type: "docker" } }, [{ id: "code" }, { id: "done", manual: true, sandbox: false }])), [`config: pipeline step "done" sandbox has no effect on a manual step (no agent runs).`]);
  assert.deepEqual(errs(raw({}, [{ id: "code", sandbox: "no" }])), [`config: pipeline step "code" sandbox must be true or false.`]);
  assert.equal(loadError(raw({ sandbox: { type: "lxc" } })), `config: "sandbox.type" "lxc" is not a known sandbox (docker, podman).`);
});

test("sandbox.egress / step egress: valid rules and presets pass; bad rule, unknown preset, bad mode and misplaced step egress are errors", () => {
  /** @param {any} c */
  const errs = (c) => {
    const v = validateRawConfig(c);
    return v.ok ? [] : v.errors;
  };
  const sb = { type: "podman", egress: { mode: "allowlist", allow: ["@npm", "registry.internal:8443", "*.corp.example", "10.0.0.5:3128!private"], deny: ["api.github.com"] } };
  assert.deepEqual(errs(raw({ sandbox: sb }, [{ id: "code", egress: { mode: "none", allow: ["@pypi"] } }, { id: "done", manual: true }])), []);
  assert.deepEqual(errs(raw({ sandbox: { type: "docker", egress: { mode: "wide" } } })), [`config: "sandbox.egress" mode "wide" must be one of allowlist, open, none.`]);
  const bad = errs(raw({ sandbox: { type: "docker", egress: { allow: ["http://x.com/path"] } } }));
  assert.equal(bad.length, 1);
  assert.match(bad[0], /^config: "sandbox\.egress" allow entry "http:\/\/x\.com\/path": invalid egress rule/);
  assert.deepEqual(errs(raw({ sandbox: { type: "docker", egress: { deny: ["@cpan"] } } })), [`config: "sandbox.egress" deny entry "@cpan": unknown preset "@cpan" (known: @npm @yarn @pypi @crates @go @rubygems @maven).`]);
  assert.deepEqual(errs(raw({ sandbox: { type: "docker", egress: { allow: "@npm" } } })), [`config: "sandbox.egress" allow must be a list of host rules or @presets.`]);
  assert.deepEqual(errs(raw({}, [{ id: "code", egress: { allow: ["@npm"] } }])), [`config: pipeline step "code" egress needs a profile "sandbox" (egress is enforced by the sandbox's network).`]);
  assert.deepEqual(errs(raw({ sandbox: { type: "docker" } }, [{ id: "code" }, { id: "done", manual: true, egress: { mode: "none" } }])), [`config: pipeline step "done" egress has no effect on a manual step (no agent runs).`]);
  assert.deepEqual(errs(raw({ sandbox: { type: "docker" } }, [{ id: "code", sandbox: false, egress: { mode: "none" } }])), [`config: pipeline step "code" egress has no effect: the step runs on the host ("sandbox": false).`]);
  assert.deepEqual(errs(raw({ sandbox: { type: "docker" } }, [{ id: "code", egress: { allow: ["bad host"] } }])).length, 1);
});

test("sandbox.services / step services (#529): a valid catalog passes; each structural error is reported", () => {
  /** @param {any} c */
  const errs = (c) => {
    const v = validateRawConfig(c);
    return v.ok ? [] : v.errors;
  };
  /** @param {any} services @param {any[]} [pipeline] */
  const withSvc = (services, pipeline = [{ id: "code", services: ["db"] }]) => raw({ sandbox: { type: "podman", services } }, pipeline);
  const db = { image: "postgres:16.4", env: { POSTGRES_PASSWORD: "test" }, wait: { cmd: ["pg_isready", "-U", "postgres"], timeoutS: 60 }, agentEnv: { DATABASE_URL: "postgres://postgres:test@db:5432/postgres" }, memory: "1g", cpus: 1 };
  const cache = { image: "registry.local:5000/redis@sha256:0123abcd" };
  assert.deepEqual(errs(withSvc({ db, cache }, [{ id: "code", services: ["db", "cache"] }, { id: "review", services: [] }, { id: "done", manual: true }])), []);
  assert.deepEqual(errs(withSvc({ db: { image: "localhost:5000/postgres:16" } })), [], "a registry port plus a tag is pinned");

  // The catalog
  assert.deepEqual(errs(withSvc([], [{ id: "code" }])), [`config: "sandbox.services" must be an object of name: { "image", … }.`]);
  assert.deepEqual(errs(withSvc({ DB: db }, [{ id: "code" }])), [`config: sandbox service name "DB" must be a DNS label (a-z, 0-9, -; starts with a letter; at most 31 chars).`]);
  assert.deepEqual(errs(withSvc({ ["a".repeat(32)]: db }, [{ id: "code" }])).length, 1);
  assert.deepEqual(errs(withSvc({ proxy: db }, [{ id: "code" }])), [`config: sandbox service name "proxy" is reserved (the egress proxy).`]);
  assert.deepEqual(errs(withSvc({ db: "postgres:16" })), [`config: "sandbox.services.db" must be an object ({ "image", … }).`]);
  assert.deepEqual(errs(withSvc({ db: {} })), [`config: "sandbox.services.db" image is required (a non-empty string with an explicit tag or digest).`]);
  assert.deepEqual(errs(withSvc({ db: { image: "postgres" } })), [`config: "sandbox.services.db" image "postgres" has no tag — pin a tag or digest (e.g. "postgres:16.4"); service images are never pulled.`]);
  assert.deepEqual(errs(withSvc({ db: { image: "postgres:latest" } })), [`config: "sandbox.services.db" image "postgres:latest" is :latest — pin a tag or digest (e.g. "postgres:16.4"); service images are never pulled.`]);
  assert.match(errs(withSvc({ db: { image: "host:5000/postgres" } }))[0] ?? "", /image "host:5000\/postgres" has no tag/, "a registry port is not a tag");
  assert.deepEqual(errs(withSvc({ db: { image: "postgres:16", env: { POSTGRES_PASSWORD: 1 } } })), [`config: "sandbox.services.db" env.POSTGRES_PASSWORD must be a literal string.`]);
  assert.deepEqual(errs(withSvc({ db: { image: "postgres:16", env: ["A=1"] } })), [`config: "sandbox.services.db" env must be an object of NAME: "value" strings.`]);
  assert.deepEqual(errs(withSvc({ db: { image: "postgres:16", agentEnv: { "BAD-NAME": "x" } } })), [`config: "sandbox.services.db" agentEnv key "BAD-NAME" is not a valid variable name.`]);
  assert.deepEqual(errs(withSvc({ db: { image: "postgres:16", agentEnv: { AGENTHOOK_VERDICT_FILE: "/x" } } })), [`config: "sandbox.services.db" agentEnv key AGENTHOOK_VERDICT_FILE is reserved (the receiver sets it).`]);
  for (const mode of [undefined, "allowlist", "open", "none"]) {
    const sandbox = mode == null ? { type: "podman", services: { db: { image: "postgres:16", agentEnv: { HTTPS_PROXY: "http://evil" } } } } : { type: "podman", egress: { mode }, services: { db: { image: "postgres:16", agentEnv: { HTTPS_PROXY: "http://evil" } } } };
    assert.deepEqual(errs(raw({ sandbox }, [{ id: "code", services: ["db"] }])), [`config: "sandbox.services.db" agentEnv key HTTPS_PROXY is reserved (the sandbox's egress proxy sets it).`], `mode ${mode}`);
  }
  for (const k of EGRESS_PROXY_ENV_KEYS) {
    assert.deepEqual(errs(withSvc({ db: { image: "postgres:16", agentEnv: { [k]: "x" } } })), [`config: "sandbox.services.db" agentEnv key ${k} is reserved (the sandbox's egress proxy sets it).`], k);
    assert.deepEqual(errs(withSvc({ db: { image: "postgres:16", env: { [k]: "x" } } })), [], `${k} in env (not agentEnv) is still accepted`);
  }
  assert.deepEqual(errs(withSvc({ db: { image: "postgres:16", agentEnv: { HTTPS_PROXY_X: "x", MY_NO_PROXY: "x" } } })), [], "look-alike names are still accepted");
  for (const k of ["DOCKER_HOST", "PATH", "HOME", "XDG_RUNTIME_DIR", "CONTAINER_HOST", "LD_PRELOAD"]) {
    assert.deepEqual(errs(withSvc({ db: { image: "postgres:16", env: { [k]: "x" } } })), [`config: "sandbox.services.db" env key ${k} is reserved: service env reaches the docker/podman client that starts the service, and ${k} would reconfigure it.`], k);
  }
  assert.deepEqual(errs(withSvc({ db: { image: "postgres:16", agentEnv: { HOME_DIR: "x" }, env: { PGDATA: "/x" } } })), [], "only exact names / the listed prefixes are reserved");
  assert.deepEqual(errs(withSvc({ db: { image: "postgres:16", wait: { cmd: [] } } })), [`config: "sandbox.services.db" wait.cmd must be a non-empty array of strings (an argv).`]);
  assert.deepEqual(errs(withSvc({ db: { image: "postgres:16", wait: { cmd: "pg_isready" } } })), [`config: "sandbox.services.db" wait.cmd must be a non-empty array of strings (an argv).`]);
  assert.deepEqual(errs(withSvc({ db: { image: "postgres:16", wait: { cmd: ["true"], timeoutS: 0 } } })), [`config: "sandbox.services.db" wait.timeoutS must be a number > 0.`]);
  assert.deepEqual(errs(withSvc({ db: { image: "postgres:16", memory: "lots", cpus: -1 } })), [
    `config: "sandbox.services.db" memory must be a size like "1g", "512m" or bytes.`,
    `config: "sandbox.services.db" cpus must be a number > 0.`,
  ]);

  // A step's services
  assert.deepEqual(errs(withSvc({ db }, [{ id: "code", services: "db" }])), [`config: pipeline step "code" services must be a list of sandbox.services names.`]);
  assert.deepEqual(errs(withSvc({ db }, [{ id: "code", services: ["redis"] }])), [`config: pipeline step "code" services "redis" is not in sandbox.services.`]);
  assert.deepEqual(errs(raw({ sandbox: { type: "podman" } }, [{ id: "code", services: ["db"] }])), [`config: pipeline step "code" services "db" is not in sandbox.services.`]);
  assert.deepEqual(errs(withSvc({ db }, [{ id: "code", services: ["db", "db"] }])), [`config: pipeline step "code" services lists "db" twice.`]);
  const nine = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`s${i}`, { image: "redis:7" }]));
  assert.deepEqual(errs(withSvc(nine, [{ id: "code", services: Object.keys(nine) }])), [`config: pipeline step "code" services lists 9 services (at most 8).`]);
  assert.deepEqual(errs(withSvc({ db }, [{ id: "code", sandbox: false, services: ["db"] }])), [`config: pipeline step "code" services needs the sandbox: the step runs on the host ("sandbox": false).`]);
  assert.deepEqual(errs(raw({}, [{ id: "code", services: ["db"] }])), [`config: pipeline step "code" services needs a profile "sandbox" (services run beside the sandboxed agent).`]);
  assert.deepEqual(errs(withSvc({ db }, [{ id: "code" }, { id: "done", manual: true, services: ["db"] }])), [`config: pipeline step "done" services has no effect on a manual step (no agent runs).`]);
});

// --- named harnesses (#619) ---

const HARNESSES = {
  "local-qwen": { agent: "claude", model: "qwen3-coder", env: { ANTHROPIC_BASE_URL: "http://localhost:11434" }, maxConcurrent: 1 },
  opus: { agent: "claude", model: "claude-opus-5-5", maxConcurrent: 3 },
  deepseek: { agent: "opencode", model: "deepseek/deepseek-v3", maxConcurrent: 2, sandbox: { image: "agent-opencode:1" } },
  bare: {},
};
/** @param {any} harnesses @param {any[]} [pipeline] */
const hErrs = (harnesses, pipeline) => /** @type {any} */ (validateRawConfig(raw({ harnesses }, pipeline))).errors;

test("harnesses: the example shape passes — a string, a first-free list and a round-robin list; a step without harness still loads", () => {
  const steps = [
    { id: "triage", harness: "opus" },
    { id: "code", harness: ["local-qwen", "deepseek"], routing: "first-free" },
    { id: "review", harness: ["deepseek", "opus"], routing: "round-robin" },
    { id: "plain" },
    { id: "done", manual: true },
  ];
  assert.deepEqual(validateRawConfig(raw({ harnesses: HARNESSES }, steps)), { ok: true });
  assert.deepEqual(validateRawConfig(raw({}, [{ id: "code" }])), { ok: true }, "no harnesses block at all");
});

test("harnesses: not an object fails", () => {
  for (const v of [[], "opus", 5]) assert.match(hErrs(v)[0], /^config: "harnesses" must be an object/);
  assert.deepEqual(hErrs({ opus: "claude" }), [`config: harness "opus" must be an object.`]);
});

test("harnesses: a bad agent, bin, provider, toolsets, env, model, maxConcurrent or sandbox.image fails", () => {
  const one = (/** @type {any} */ h) => hErrs({ x: h });
  assert.deepEqual(one({ agent: "gpt" }), [`config: harness "x" agent "gpt" is not a known agent (claude, cursor, hermes, opencode, pi).`]);
  assert.deepEqual(one({ bin: " " }), [`config: harness "x" bin must be a non-empty string (a name on PATH or an absolute path).`]);
  assert.deepEqual(one({ provider: "" }), [`config: harness "x" provider must be a non-empty string.`]);
  assert.deepEqual(one({ toolsets: [] }), [`config: harness "x" toolsets must be a non-empty array of non-empty strings.`]);
  assert.deepEqual(one({ env: [] }), [`config: harness "x" env must be an object of NAME: "value" strings.`]);
  assert.deepEqual(one({ env: { AGENTHOOK_VERDICT_FILE: "x" } }), [`config: harness "x" env key AGENTHOOK_VERDICT_FILE is reserved (the receiver sets it).`]);
  assert.deepEqual(one({ env: { A: 1 } }), [`config: harness "x" env.A must be a string.`]);
  assert.deepEqual(one({ model: "" }), [`config: harness "x" model must be a non-empty string.`]);
  assert.deepEqual(one({ opencodeConfig: "" }), [`config: harness "x" opencodeConfig must be a non-empty string.`]);
  assert.deepEqual(one({ piConfigDir: "" }), [`config: harness "x" piConfigDir must be a non-empty string.`]);
  for (const v of [0, -1, 1.5, "2"]) assert.deepEqual(one({ maxConcurrent: v }), [`config: harness "x" maxConcurrent must be a positive integer.`], `maxConcurrent ${JSON.stringify(v)}`);
  assert.deepEqual(one({ sandbox: { image: "" } }), [`config: harness "x" sandbox.image must be a non-empty string.`]);
  assert.deepEqual(one({ sandbox: "img" }), [`config: harness "x" sandbox must be an object ({ "image": "…" }).`]);
  for (const v of [0, -1, 1.5, "64000"]) assert.deepEqual(one({ contextTokens: v }), [`config: harness "x" contextTokens must be a positive integer.`], JSON.stringify(v));
});

test("harnesses: the breaker keys — cooldownMinutes is an integer 1-60, downGraceSeconds a positive integer", () => {
  const one = (/** @type {any} */ h) => hErrs({ x: h });
  assert.equal(one({ cooldownMinutes: 1, downGraceSeconds: 1 }), undefined, "valid → no errors");
  assert.equal(one({ cooldownMinutes: 60, downGraceSeconds: 600 }), undefined);
  for (const v of [0, 61, 1.5, "10"]) assert.deepEqual(one({ cooldownMinutes: v }), [`config: harness "x" cooldownMinutes must be an integer 1-60.`], `cooldownMinutes ${JSON.stringify(v)}`);
  for (const v of [0, -1, 2.5, "30"]) assert.deepEqual(one({ downGraceSeconds: v }), [`config: harness "x" downGraceSeconds must be a positive integer.`], `downGraceSeconds ${JSON.stringify(v)}`);
});

test("step harness: not a string or list, an empty list, or a duplicate name fails", () => {
  const msg = `config: pipeline step "code" harness must be a harness name or a non-empty list of names or {name, model?, effort?} entries.`;
  for (const v of [5, {}, "", [], [""], ["opus", 3]]) assert.deepEqual(hErrs(HARNESSES, [{ id: "code", harness: v }]), [msg], `harness ${JSON.stringify(v)}`);
  assert.deepEqual(hErrs(HARNESSES, [{ id: "code", harness: ["opus", "opus"] }]), [`config: pipeline step "code" harness lists "opus" twice.`]);
});

test("step harness: an unknown name fails (also with no harnesses block)", () => {
  assert.deepEqual(hErrs(HARNESSES, [{ id: "code", harness: ["opus", "gone"] }]), [`config: pipeline step "code" harness "gone" is not in "harnesses".`]);
  assert.deepEqual(hErrs(undefined, [{ id: "code", harness: "opus" }]), [`config: pipeline step "code" harness "opus" is not in "harnesses".`]);
  assert.deepEqual(hErrs(HARNESSES, [{ id: "code", harness: "toString" }]), [`config: pipeline step "code" harness "toString" is not in "harnesses".`], "own keys only");
});

test("step harness: an object entry passes and pins model/effort per name", () => {
  assert.deepEqual(validateRawConfig(raw({ harnesses: HARNESSES }, [{ id: "code", harness: [{ name: "opus", model: "claude-sonnet-5", effort: "high" }, "deepseek"] }])), { ok: true });
  assert.deepEqual(validateRawConfig(raw({ harnesses: HARNESSES }, [{ id: "code", harness: [{ name: "opus" }] }])), { ok: true }, "a one-element object list is valid");
});

test("step harness: an unknown harness name inside an entry, or an unknown key, fails naming the key", () => {
  assert.deepEqual(hErrs(HARNESSES, [{ id: "code", harness: [{ name: "gone" }] }]), [`config: pipeline step "code" harness "gone" is not in "harnesses".`]);
  assert.deepEqual(hErrs(HARNESSES, [{ id: "review", harness: [{ name: "opus", bin: "claude-local" }] }]), [`config: pipeline step "review" harness entry "opus" has unknown key "bin" (allowed: name, model, effort).`]);
  assert.deepEqual(hErrs(HARNESSES, [{ id: "review", harness: [{ name: "opus", model: "", effort: 3 }] }]), [`config: pipeline step "review" harness entry "opus" model must be a non-empty string.`, `config: pipeline step "review" harness entry "opus" effort must be a non-empty string.`]);
});

test("step harness: a duplicate name across string and object forms fails", () => {
  assert.deepEqual(hErrs(HARNESSES, [{ id: "code", harness: ["opus", { name: "opus", model: "m" }] }]), [`config: pipeline step "code" harness lists "opus" twice.`]);
});

test("harnesses: effort must be a non-empty string", () => {
  const one = (/** @type {any} */ h) => hErrs({ x: h });
  assert.equal(one({ effort: "high" }), undefined, "valid → no errors");
  assert.deepEqual(one({ effort: "" }), [`config: harness "x" effort must be a non-empty string.`]);
  assert.deepEqual(one({ effort: 3 }), [`config: harness "x" effort must be a non-empty string.`]);
});

test("step routing: without a list, or an unknown value, fails", () => {
  const needsList = `config: pipeline step "code" routing needs a "harness" list (it picks among several harnesses).`;
  assert.deepEqual(hErrs(HARNESSES, [{ id: "code", routing: "first-free" }]), [needsList]);
  assert.deepEqual(hErrs(HARNESSES, [{ id: "code", harness: "opus", routing: "round-robin" }]), [needsList]);
  assert.deepEqual(hErrs(HARNESSES, [{ id: "code", harness: ["opus", "bare"], routing: "random" }]), [`config: pipeline step "code" routing must be "first-free" or "round-robin".`]);
});

test("branchPrefix: rejects empty/no-trailing-slash/'..'/space/'//'/leading-dot/'.lock' components; accepts slash-separated names (#674)", () => {
  for (const bad of ["", "agent", "a..b/", "a b/", "a//", ".x/", "x.lock/"]) {
    assert.deepEqual(validateRawConfig(raw({ branchPrefix: bad })).errors, [
      `config: "branchPrefix" must be slash-separated components of [A-Za-z0-9._-]+ ending in "/" (e.g. "agent/", "team/bot/"); no "..", and no component starting with "." or ending with ".lock".`,
    ], JSON.stringify(bad));
  }
  for (const good of ["agent/", "local/", "team/bot/"]) {
    assert.deepEqual(validateRawConfig(raw({ branchPrefix: good })), { ok: true }, good);
  }
});

test("step harness: on a manual step fails (no agent runs)", () => {
  assert.deepEqual(hErrs(HARNESSES, [{ id: "code" }, { id: "done", manual: true, harness: "opus" }]), [`config: pipeline step "done" harness has no effect on a manual step (no agent runs).`]);
});
