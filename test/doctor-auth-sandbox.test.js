import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// Doctor — GitHub App auth (installation token fetch, per-run tokens #474) and
// sandboxChecks/sandboxRuntimeChecks/egressLints/runTokenLints (a profile `sandbox` block).
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { agentBinChecks, runChecks, applyFixes, fixableCount, githubAppChecks, sandboxChecks, sandboxRuntimeChecks, egressLints, runTokenLints } from "../src/commands/doctor.js";
import { resetGithubAuthCache } from "../src/github-auth.js";
import { DEFAULT_IMAGE } from "../src/sandbox/image.js";
import { SANDBOX_CREDENTIAL_VARS } from "../src/agents/claude.js";
import { cleanProfile, io } from "./_doctor-helpers.js";

// --- GitHub App auth: key parses, installation token fetchable, assigneeLogin set ---

const APP_PEM = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" }).toString();
/** @param {any} [over] */
const appAuth = (over = {}) => ({ type: /** @type {const} */ ("app"), appId: "101", installationId: "202", privateKey: APP_PEM, ...over });
/** A mocked access_tokens endpoint answering `status`. @param {number} status */
const tokenFetch = (status) => {
  const calls = /** @type {string[]} */ ([]);
  /** @type {any} */
  const f = async (/** @type {string} */ url) => {
    calls.push(url);
    return status < 300
      ? { ok: true, status, json: async () => ({ token: "inst", expires_at: new Date(Date.now() + 3600e3).toISOString() }) }
      : { ok: false, status, json: async () => ({ message: "Integration not found" }) };
  };
  return { f, calls };
};

test("githubAppChecks: a parsing key, a fetchable installation token and assigneeLogin → three ✓", async () => {
  resetGithubAuthCache();
  const { f, calls } = tokenFetch(201);
  const checks = await githubAppChecks({ auth: appAuth({ privateKey: APP_PEM.replace(/\n/g, "\\n") }), assigneeLogin: "alice" }, "tracker", { fetch: f });
  assert.deepEqual(checks.map((c) => [c.ok, c.label]), [
    [true, "tracker GitHub App private key parses (app 101)"],
    [true, "tracker GitHub App installation token fetchable (installation 202)"],
    [true, "tracker.assigneeLogin set (the human the App acts for)"],
  ]);
  assert.deepEqual(calls, ["https://api.github.com/app/installations/202/access_tokens"]);
});

test("githubAppChecks: a bad key fails (and skips the live call); a missing assigneeLogin fails", async () => {
  resetGithubAuthCache();
  const { f, calls } = tokenFetch(201);
  const checks = await githubAppChecks({ auth: appAuth({ privateKey: "not a pem" }) }, "tracker", { fetch: f });
  assert.deepEqual(checks.map((c) => [c.ok, c.label.split(" (")[0]]), [
    [false, "tracker GitHub App private key parses"],
    [false, "tracker.assigneeLogin set"],
  ]);
  assert.equal(calls.length, 0);
  assert.ok(checks.every((c) => c.fix && "manual" in c.fix));
});

test("githubAppChecks: an installation token the API refuses fails with its status; the forge has no login check", async () => {
  resetGithubAuthCache();
  const checks = await githubAppChecks({ auth: appAuth() }, "forge", { fetch: tokenFetch(404).f });
  assert.deepEqual(checks.map((c) => c.ok), [true, false]);
  assert.match(String(checks[1].note), /installation token 404: Integration not found/);
});

test("runChecks under App auth: the App checks replace the token check, for the tracker and a github forge", async () => {
  resetGithubAuthCache();
  const { cfg } = cleanProfile();
  cfg.provider = "github";
  cfg.providerConfig = /** @type {any} */ ({ type: "github", repository: "o/r", auth: appAuth(), assigneeLogin: "alice", pipeline: cfg.pipeline });
  cfg.forge = /** @type {any} */ ({ type: "github", repository: "o/r", auth: appAuth() });
  const checks = await runChecks(cfg, io({ fetch: tokenFetch(201).f }));
  const labels = checks.map((c) => c.label);
  assert.ok(!labels.some((l) => l.startsWith("tracker token resolved")), labels.join("\n"));
  for (const l of ["tracker GitHub App private key parses", "tracker GitHub App installation token fetchable", "tracker.assigneeLogin set", "forge GitHub App private key parses", "forge GitHub App installation token fetchable"]) {
    const c = checks.find((x) => x.label.startsWith(l));
    assert.ok(c?.ok, `${l}: ${JSON.stringify(c)}`);
  }
});

// --- per-run GitHub App tokens (#474) ---

/** A mocked GitHub for the run-token check: the receiver mint answers 201; a scoped mint (a
 * body) answers `scoped`; DELETE /installation/token answers 204. @param {number} scoped */
const runTokenFetch = (scoped) => {
  const calls = /** @type {{url: string, method: string, body?: any}[]} */ ([]);
  /** @type {any} */
  const f = async (/** @type {string} */ url, /** @type {any} */ init = {}) => {
    calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : undefined });
    if (init.method === "DELETE") return { ok: true, status: 204, json: async () => ({}) };
    if (init.body && scoped >= 300) return { ok: false, status: scoped, json: async () => ({ message: "The permissions requested are not granted to this installation." }) };
    return { ok: true, status: 201, json: async () => ({ token: init.body ? "run" : "inst", expires_at: new Date(Date.now() + 3600e3).toISOString() }) };
  };
  return { f, calls };
};

test("githubAppChecks with runTokenRepo: mints an implement-scoped run token and revokes it at once → ✓", async () => {
  resetGithubAuthCache();
  const { f, calls } = runTokenFetch(201);
  const checks = await githubAppChecks({ auth: appAuth() }, "forge", { fetch: f, runTokenRepo: "o/r" });
  assert.deepEqual(checks.map((c) => [c.ok, c.label]), [
    [true, "forge GitHub App private key parses (app 101)"],
    [true, "forge GitHub App installation token fetchable (installation 202)"],
    [true, "forge GitHub App can mint agent run tokens (contents:write, pull_requests:write, issues:write)"],
  ]);
  assert.deepEqual(calls[1].body.repositories, ["r"]);
  assert.equal(calls[1].body.permissions.contents, "write");
  assert.deepEqual(calls[2], { url: "https://api.github.com/installation/token", method: "DELETE", body: undefined });
});

test("githubAppChecks with runTokenRepo: a 422 is ✗ with GitHub's message and the grant-permissions fix", async () => {
  resetGithubAuthCache();
  const { f } = runTokenFetch(422);
  const checks = await githubAppChecks({ auth: appAuth() }, "forge", { fetch: f, runTokenRepo: "o/r" });
  const c = checks[2];
  assert.equal(c.ok, false);
  assert.match(String(c.note), /422: The permissions requested are not granted/);
  assert.match(String(c.fix && "manual" in c.fix ? c.fix.manual : ""), /Contents: Read & write and Pull requests: Read & write \(docs\/github-app\.md#agent-run-tokens\)/);
});

test("runTokenLints: a PAT is an ℹ; App + githubRunToken:false and a step env GH_TOKEN are ⚠; a non-github origin is issues-only", () => {
  const base = /** @type {any} */ ({ provider: "github", providerConfig: { type: "github", token: "t" }, pipeline: [{ id: "code" }], repoPath: "/r" });
  const github = () => "o/r";
  assert.deepEqual(runTokenLints(base, { originRepo: github }), [{ level: "info", label: "agents use your personal GitHub token (no GitHub App)", note: "an App gives each run a 1h token scoped to one repo: docs/github-app.md#agent-run-tokens" }]);
  assert.deepEqual(runTokenLints({ ...base, provider: "asana", providerConfig: {} }, { originRepo: github }), [], "no GitHub anywhere");
  const app = { ...base, providerConfig: { type: "github", auth: appAuth(), assigneeLogin: "a" } };
  assert.deepEqual(runTokenLints(app, { originRepo: github }), []);
  assert.deepEqual(runTokenLints({ ...app, githubRunToken: false }, { originRepo: github }).map((l) => [l.level, l.label]), [["warn", "agents use your own GitHub credentials, not a scoped run token"]]);
  assert.deepEqual(runTokenLints({ ...app, pipeline: [{ id: "code", env: { GH_TOKEN: "${X}" } }] }, { originRepo: github }).map((l) => [l.level, l.label]), [["warn", `step "code" env GH_TOKEN overrides the per-run App token`]]);
  assert.deepEqual(runTokenLints(app, { originRepo: () => null }).map((l) => [l.level, l.label]), [["warn", `run tokens for "default" cover issues only; pushes use your own git credentials`]]);
  const forgeApp = { ...base, forge: { type: "github", repository: "o/r", auth: appAuth() } };
  assert.deepEqual(runTokenLints(forgeApp, { originRepo: () => null }), [], "an App forge falls back to its repository");
});

// --- sandboxChecks (a profile `sandbox` block) ---

/** @param {any} [over] */
const sbCfg = (over = {}) =>
  /** @type {any} */ ({
    claudeBin: "claude",
    sandbox: { type: "docker" },
    pipeline: [{ id: "code", env: { CLAUDE_CODE_OAUTH_TOKEN: "t" } }, { id: "done", manual: true }],
    ...over,
  });
/** @param {Record<string, number>} codes  "arg0" or "arg0 arg1" → exit code */
const sbRun = (codes = {}) => /** @type {import('../src/types.js').IngressRun} */ (async (_bin, args) => ({ code: codes[args.slice(0, 2).join(" ")] ?? codes[args[0]] ?? 0, stdout: "", stderr: "boom" }));

test("sandboxChecks: no sandbox block → no checks", async () => {
  assert.deepEqual(await sandboxChecks(sbCfg({ sandbox: undefined }), { run: sbRun(), has: () => true }), []);
});

test("sandboxChecks: a missing default image is ✗ with an apply fix that builds it from stdin", async () => {
  /** @type {any[]} */
  const builds = [];
  const checks = await sandboxChecks(sbCfg(), { run: sbRun({ "image inspect": 1 }), has: () => true, build: (bin, args, df) => (builds.push([bin, args, df]), { status: 0 }) });
  const img = checks.find((c) => c.label.startsWith("sandbox image present"));
  assert.equal(img?.ok, false);
  assert.ok(img?.fix && "apply" in img.fix);
  await /** @type {any} */ (img.fix).apply();
  assert.equal(builds[0][0], "docker");
  assert.deepEqual(builds[0][1].slice(0, 2), ["build", "-t"]);
  assert.match(builds[0][2], /^FROM node:22/);
  assert.match(checks.find((c) => c.label.includes("info"))?.note ?? "", /root-equivalent; prefer rootless podman/);
  const lines = await applyFixes(checks, { log: () => {} });
  assert.ok(lines.some((l) => l.startsWith("fixed: sandbox image present")));
});

test("sandboxChecks: each service image is checked (fix: pull it, never applied) and each sandboxed step's services listed as info", async () => {
  const cfg = sbCfg({
    sandbox: { type: "podman", egress: { mode: "open" }, services: { db: { image: "postgres:16.4" }, cache: { image: "redis:7.2" } } },
    pipeline: [{ id: "code", services: ["db", "cache"], env: { CLAUDE_CODE_OAUTH_TOKEN: "t" } }, { id: "review", env: { CLAUDE_CODE_OAUTH_TOKEN: "t" } }, { id: "done", manual: true }],
  });
  /** @type {string[][]} */
  const calls = [];
  const run = /** @type {import('../src/types.js').IngressRun} */ (async (_bin, args) => (calls.push(args), { code: args[2] === "redis:7.2" ? 1 : 0, stdout: "", stderr: "" }));
  const checks = await sandboxChecks(cfg, { run, has: () => true });
  const svc = checks.filter((c) => c.label.startsWith("sandbox service image present"));
  assert.deepEqual(svc.map((c) => [c.ok, c.label]), [[true, "sandbox service image present: postgres:16.4"], [false, "sandbox service image present: redis:7.2"]]);
  assert.deepEqual(svc[1].fix, { manual: "podman pull redis:7.2" });
  assert.deepEqual(checks.filter((c) => c.info).map((c) => c.label), ['step "code" services: db, cache']);
  assert.equal(fixableCount(checks), fixableCount(checks.filter((c) => !c.label.startsWith("sandbox service image"))), "a pull is never auto-applied");
});

test("sandboxChecks: runtime missing or down stops there", async () => {
  const off = await sandboxChecks(sbCfg(), { run: sbRun(), has: () => false });
  assert.equal(off.length, 1);
  assert.equal(off[0].ok, false);
  const down = await sandboxChecks(sbCfg(), { run: sbRun({ info: 1 }), has: () => true });
  assert.deepEqual(down.map((c) => c.ok), [true, false]);
});

test("sandboxRuntimeChecks: binary, info, then each image — a custom image's fix is manual, a missing default's builds", async () => {
  /** @type {string[][]} */
  const calls = [];
  const run = /** @type {import('../src/types.js').IngressRun} */ (async (_bin, args) => (calls.push(args), { code: args[2] === "mine:1" ? 1 : 0, stdout: "", stderr: "" }));
  const checks = await sandboxRuntimeChecks({ type: "podman", image: "mine:1" }, { run, has: () => true, images: ["mine:1", DEFAULT_IMAGE] });
  assert.deepEqual(checks.map((c) => [c.ok, c.label]), [
    [true, "sandbox: podman binary on PATH"],
    [true, "sandbox: `podman info` succeeds"],
    [false, "sandbox image present: mine:1"],
    [true, `sandbox image present: ${DEFAULT_IMAGE} (egress proxy)`],
  ]);
  assert.match(/** @type {any} */ (checks[2].fix).manual, /^build mine:1 \(FROM /);
  assert.ok(checks[3].fix && "apply" in checks[3].fix);
  assert.deepEqual(calls, [["info"], ["image", "inspect", "mine:1"], ["image", "inspect", DEFAULT_IMAGE]]);
  // images defaults to [image]; a down runtime stops before any inspect.
  assert.equal((await sandboxRuntimeChecks({ type: "docker", image: DEFAULT_IMAGE }, { run: sbRun(), has: () => true })).length, 3);
  assert.deepEqual((await sandboxRuntimeChecks({ type: "docker", image: DEFAULT_IMAGE }, { run: sbRun({ info: 1 }), has: () => true })).map((c) => c.ok), [true, false]);
});

test("sandboxChecks: a sandboxed hermes step ✗, a credential-less claude step ✗, an absolute claudeBin ⚠, sandbox:false skipped", async () => {
  // agentSpawnEnv reads the real process.env (#507) — clear every credential var sandboxCredentialProblem
  // checks, not just CLAUDE_CODE_OAUTH_TOKEN, so a host/sandbox shell with e.g. CLAUDE_CODE_USE_BEDROCK=1 set
  // doesn't make this "credential-less" step look credentialed.
  const saved = Object.fromEntries(SANDBOX_CREDENTIAL_VARS.map((k) => [k, process.env[k]]));
  SANDBOX_CREDENTIAL_VARS.forEach((k) => delete process.env[k]);
  try {
    const checks = await sandboxChecks(
      sbCfg({
        claudeBin: "/usr/local/bin/claude",
        pipeline: [{ id: "triage", agent: "hermes" }, { id: "code" }, { id: "host", agent: "cursor", sandbox: false }, { id: "done", manual: true }],
      }),
      { run: sbRun(), has: () => true },
    );
    const by = (/** @type {string} */ s) => checks.filter((c) => c.label.includes(s));
    assert.equal(by('step "triage"')[0].ok, false);
    assert.match(by('step "triage"')[0].note ?? "", /hermes does not support the sandbox yet/);
    const cred = by('step "code" has a claude credential')[0];
    assert.equal(cred.ok, false);
    assert.match(/** @type {any} */ (cred.fix).manual, /claude setup-token/);
    const abs = by('step "code" agent binary is a host path')[0];
    assert.equal(abs.warn, true);
    assert.equal(by('step "host"').length, 0, "an opted-out step is not sandbox-checked");
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v !== undefined) process.env[k] = v;
      else delete process.env[k];
    }
  }
});

test("sandboxChecks: a sandboxed opencode step is no longer flagged — it has a sandbox hook now (#647)", async () => {
  const checks = await sandboxChecks(
    sbCfg({ pipeline: [{ id: "code", agent: "opencode" }, { id: "done", manual: true }] }),
    { run: sbRun(), has: () => true },
  );
  const by = (/** @type {string} */ s) => checks.filter((c) => c.label.includes(s));
  assert.equal(by('step "code" (opencode) can run sandboxed').length, 0);
});

test("sandboxChecks: allowlist with a custom image also checks the built-in image (the egress proxy), with the build fix", async () => {
  /** @type {string[]} */
  const inspected = [];
  /** @type {import('../src/types.js').IngressRun} */
  const run = async (_bin, args) => {
    if (args[0] === "image") inspected.push(args[2]);
    return { code: args[0] === "image" && args[2] !== "mine:1" ? 1 : 0, stdout: "", stderr: "" };
  };
  const checks = await sandboxChecks(sbCfg({ sandbox: { type: "docker", image: "mine:1" } }), { run, has: () => true });
  assert.deepEqual(inspected.length, 2);
  const proxy = checks.find((c) => c.label.endsWith("(egress proxy)"));
  assert.equal(proxy?.ok, false);
  assert.ok(proxy?.fix && "apply" in proxy.fix, "doctor --fix builds it");
  inspected.length = 0;
  await sandboxChecks(sbCfg({ sandbox: { type: "docker", image: "mine:1", egress: { mode: "open" } } }), { run, has: () => true });
  assert.deepEqual(inspected, ["mine:1"], "open: no proxy, so no built-in image needed");
});

test("egressLints: ⚠ open (profile or step), ⚠ loopback ANTHROPIC_BASE_URL, ℹ @npm for a package-lock.json, ℹ the effective allowlist", () => {
  const base = { provider: "github", providerConfig: {}, forge: { type: "github" } };
  const open = egressLints(sbCfg({ ...base, sandbox: { type: "docker", egress: { mode: "open" } } }), { env: {} });
  assert.ok(open.some((l) => l.level === "warn" && l.label === `sandbox egress mode is "open"` && /exfiltrate the worktree and its env/.test(l.note ?? "")));
  const stepOpen = egressLints(sbCfg({ ...base, pipeline: [{ id: "code", egress: { mode: "open" } }] }), { env: {} });
  assert.ok(stepOpen.some((l) => l.level === "warn" && l.label === `step "code" egress mode is "open"`));

  const loop = egressLints(sbCfg(base), { env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:11434" } });
  const lw = loop.find((l) => l.label.startsWith("ANTHROPIC_BASE_URL is loopback"));
  assert.equal(lw?.level, "warn");
  assert.match(lw?.note ?? "", /the sandbox cannot reach http:\/\/127\.0\.0\.1:11434; use a host-reachable address \(host\.docker\.internal \/ host\.containers\.internal\) and allow it/);
  const stepLoop = egressLints(sbCfg({ ...base, pipeline: [{ id: "code", env: { ANTHROPIC_BASE_URL: "http://localhost:8080" } }] }), { env: {} });
  assert.ok(stepLoop.some((l) => l.label === "ANTHROPIC_BASE_URL is loopback (steps: code)"));

  const npm = egressLints(sbCfg(base), { files: ["package-lock.json", "README.md"], env: {} });
  const hint = npm.find((l) => l.label.includes("package-lock.json"));
  assert.equal(hint?.level, "info");
  assert.match(hint?.note ?? "", /add "@npm" to sandbox\.egress\.allow/);
  assert.equal(egressLints(sbCfg({ ...base, sandbox: { type: "docker", egress: { allow: ["@npm"] } } }), { files: ["package-lock.json"], env: {} }).some((l) => l.label.includes("package-lock")), false, "already allowed");

  const rules = npm.find((l) => l.label === `step "code" egress allowlist`);
  assert.equal(rules?.level, "info");
  assert.match(rules?.note ?? "", /^api\.anthropic\.com, api\.github\.com, github\.com, uploads\.github\.com, \*\.githubusercontent\.com \+ the repo's origin host$/);
  assert.deepEqual(egressLints(sbCfg({ sandbox: undefined }), { env: {} }), []);

  // No forge block: the forge hosts come from the origin, as dispatch infers them.
  const noForge = { provider: "asana", providerConfig: {} };
  const inferred = egressLints(sbCfg(noForge), { env: {}, origins: ["git@github.com:o/r.git"] }).find((l) => l.label === `step "code" egress allowlist`);
  assert.match(inferred?.note ?? "", /^api\.anthropic\.com, app\.asana\.com, github\.com, api\.github\.com, uploads\.github\.com, \*\.githubusercontent\.com \+ the repo's origin host$/);
  const unknown = egressLints(sbCfg(noForge), { env: {}, origins: ["https://git.acme.io/o/r"] }).find((l) => l.label === `step "code" egress allowlist`);
  assert.match(unknown?.note ?? "", /^api\.anthropic\.com, app\.asana\.com \+ the repo's origin host$/);
});

test("agentBinChecks: a sandboxed step's binary resolves in the image, not on the host PATH", () => {
  const groups = agentBinChecks(/** @type {any} */ ({ claudeBin: "claude", sandbox: { type: "docker" }, pipeline: [{ id: "code" }, { id: "host", sandbox: false, bin: "claude-local" }] }));
  assert.deepEqual(groups, [{ bin: "claude-local", agent: "claude", steps: ["host"] }]);
});

