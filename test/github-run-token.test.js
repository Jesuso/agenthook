import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// src/github-run-token.js — per-run GitHub App tokens for agents (#474). No network: fetch,
// the clock and the timer are injected.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  runTokenPermissions,
  runTokenRepos,
  runTokenBody,
  issueRepoFromUrl,
  ghHostsYml,
  runGitEnv,
  createRunCredentials,
  githubRunCredentials,
  RUN_TOKEN_REFRESH_MS,
  RUN_TOKEN_RETRY_MS,
} from "../src/github-run-token.js";
import { createGithubAuth, resetGithubAuthCache } from "../src/github-auth.js";
import { staleRunCreds } from "../src/commands/cleanup.js";

const PEM = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const auth = /** @type {const} */ ({ type: "app", appId: "101", installationId: "202", privateKey: PEM });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ah-run-token-"));
const HOUR = 60 * 60 * 1000;

test("runTokenPermissions: each kind matches the table; none ever gets workflows, administration, secrets or actions:write", () => {
  assert.deepEqual(runTokenPermissions("implement"), { metadata: "read", contents: "write", pull_requests: "write", issues: "write", checks: "read", statuses: "read", actions: "read" });
  assert.deepEqual(runTokenPermissions("change"), runTokenPermissions("implement"));
  assert.deepEqual(runTokenPermissions(undefined), runTokenPermissions("implement"), "no kind = implement");
  assert.deepEqual(runTokenPermissions("review"), { metadata: "read", contents: "read", pull_requests: "write", issues: "write", checks: "read", statuses: "read" });
  assert.deepEqual(runTokenPermissions("triage"), { metadata: "read", contents: "read", issues: "write" });
  for (const kind of ["implement", "change", "review", "triage"]) {
    const p = runTokenPermissions(kind);
    for (const banned of ["workflows", "administration", "secrets", "organization_administration", "members"]) assert.equal(p[banned], undefined, `${kind}: ${banned}`);
    assert.notEqual(p.actions, "write", kind);
    assert.equal(p.metadata, "read", kind);
  }
});

test("runTokenRepos: dedups one repo, keeps two in one account, throws across accounts, drops a null side", () => {
  assert.deepEqual(runTokenRepos({ codeRepo: "o/a", issueRepo: "o/a" }), { owner: "o", repositories: ["a"] });
  assert.deepEqual(runTokenRepos({ codeRepo: "O/A", issueRepo: "o/a" }), { owner: "O", repositories: ["A"] }, "GitHub names are case-insensitive");
  assert.deepEqual(runTokenRepos({ codeRepo: "o/code", issueRepo: "o/issues" }), { owner: "o", repositories: ["code", "issues"] });
  assert.throws(() => runTokenRepos({ codeRepo: "p/b", issueRepo: "o/a" }), /issue repo o\/a and code repo p\/b are under different accounts — one installation token cannot cover both/);
  assert.deepEqual(runTokenRepos({ codeRepo: null, issueRepo: "o/a" }), { owner: "o", repositories: ["a"] });
  assert.equal(runTokenRepos({ codeRepo: null, issueRepo: null }), null);
});

test("runTokenBody: no code repo on github.com narrows the token to metadata + issues", () => {
  assert.deepEqual(runTokenBody({ codeRepo: null, issueRepo: "o/a", kind: "implement" }), { owner: "o", repositories: ["a"], permissions: { metadata: "read", issues: "write" } });
  assert.deepEqual(runTokenBody({ codeRepo: "o/a", issueRepo: null, kind: "review" })?.permissions, runTokenPermissions("review"));
  assert.equal(runTokenBody({ codeRepo: null, issueRepo: null }), null);
});

test("issueRepoFromUrl: issue and PR URLs, else null", () => {
  assert.equal(issueRepoFromUrl("https://github.com/o/r/issues/12"), "o/r");
  assert.equal(issueRepoFromUrl("https://github.com/o/r/pull/7"), "o/r");
  assert.equal(issueRepoFromUrl("https://github.com/o/r"), null);
  assert.equal(issueRepoFromUrl("https://acme.atlassian.net/browse/X-1"), null);
  assert.equal(issueRepoFromUrl(undefined), null);
});

test("ghHostsYml: the token in both the legacy and the multi-account form, as x-access-token over https", () => {
  const y = ghHostsYml("ghs_x");
  assert.equal(y.match(/oauth_token: ghs_x/g)?.length, 2);
  assert.match(y, /^github\.com:\n {4}users:\n {8}x-access-token:\n {12}oauth_token: ghs_x\n/);
  assert.match(y, /\n {4}user: x-access-token\n/);
  assert.match(y, /\n {4}git_protocol: https\n/);
});

test("runGitEnv: GIT_CONFIG_COUNT matches the pairs; the reset helper comes before gh's; SSH github remotes go to https", () => {
  const env = runGitEnv();
  const n = Number(env.GIT_CONFIG_COUNT);
  const keys = Object.keys(env).filter((k) => k.startsWith("GIT_CONFIG_KEY_"));
  assert.equal(keys.length, n);
  assert.equal(Object.keys(env).filter((k) => k.startsWith("GIT_CONFIG_VALUE_")).length, n);
  const pairs = Array.from({ length: n }, (_, i) => [env[`GIT_CONFIG_KEY_${i}`], env[`GIT_CONFIG_VALUE_${i}`]]);
  const reset = pairs.findIndex(([k, v]) => k === "credential.https://github.com.helper" && v === "");
  const gh = pairs.findIndex(([k, v]) => k === "credential.https://github.com.helper" && v === "!gh auth git-credential");
  assert.ok(reset >= 0 && gh > reset, JSON.stringify(pairs));
  assert.deepEqual(pairs.filter(([k]) => k === "url.https://github.com/.insteadOf").map(([, v]) => v), ["git@github.com:", "ssh://git@github.com/"]);
  assert.equal(env.GIT_TERMINAL_PROMPT, "0");
});

/** A mocked GitHub: access_tokens mints run-1, run-2, … expiring `ttl` after the clock;
 * DELETE /installation/token answers 204. `fail` makes the next mint fail.
 * @param {{t: number}} clock */
function github(clock, ttl = HOUR) {
  /** @type {{url: string, method: string, auth: string, body: any}[]} */
  const calls = [];
  const state = { fail: 0, minted: 0 };
  /** @type {any} */
  const f = async (/** @type {string} */ url, /** @type {any} */ init = {}) => {
    calls.push({ url, method: init.method, auth: init.headers?.Authorization, body: init.body ? JSON.parse(init.body) : undefined });
    if (init.method === "DELETE") return { ok: true, status: 204, json: async () => ({}) };
    if (state.fail > 0) {
      state.fail--;
      return { ok: false, status: 502, json: async () => ({ message: "Bad gateway" }) };
    }
    const n = ++state.minted;
    return { ok: true, status: 201, json: async () => ({ token: `run-${n}`, expires_at: new Date(clock.t + ttl).toISOString() }) };
  };
  return { f, calls, state };
}

/** A manual timer: `fire()` runs the pending callback. */
function manualTimer() {
  /** @type {{fn: () => void, ms: number, cleared: boolean}[]} */
  const timers = [];
  return {
    timers,
    setTimeout: (/** @type {() => void} */ fn, /** @type {number} */ ms) => {
      const t = { fn, ms, cleared: false, unref() {} };
      timers.push(t);
      return t;
    },
    clearTimeout: (/** @type {any} */ t) => {
      if (t) t.cleared = true;
    },
    pending: () => timers.filter((t) => !t.cleared && !(/** @type {any} */ (t).fired)),
    async fire() {
      const t = this.pending().at(-1);
      assert.ok(t, "a timer is pending");
      /** @type {any} */ (t).fired = true;
      await t.fn();
    },
  };
}

test("createRunCredentials: POSTs the scoped body, writes hosts.yml 0600 under 0700 dirs, strips the env tokens", async () => {
  const clock = { t: Date.parse("2026-10-18T13:00:00Z") };
  const gh = github(clock);
  const timer = manualTimer();
  const dir = path.join(tmp(), "run-creds", "42-code");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "leftover"), "crash");
  const creds = await createRunCredentials(auth, { codeRepo: "o/r", issueRepo: "o/r", kind: "implement", dir, fetch: gh.f, now: () => clock.t, setTimeout: timer.setTimeout, clearTimeout: timer.clearTimeout });
  assert.ok(creds);
  assert.equal(gh.calls.length, 1);
  assert.equal(gh.calls[0].url, "https://api.github.com/app/installations/202/access_tokens");
  assert.equal(gh.calls[0].method, "POST");
  assert.deepEqual(gh.calls[0].body, { repositories: ["r"], permissions: runTokenPermissions("implement") });
  assert.equal(fs.existsSync(path.join(dir, "leftover")), false, "a crashed run's dir is wiped first");
  const hosts = path.join(dir, "gh", "hosts.yml");
  assert.match(fs.readFileSync(hosts, "utf8"), /oauth_token: run-1/);
  assert.equal(fs.statSync(hosts).mode & 0o777, 0o600);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(dir, "gh")).mode & 0o777, 0o700);
  assert.equal(creds.env.GH_CONFIG_DIR, path.join(dir, "gh"));
  assert.equal(creds.env.GIT_CONFIG_COUNT, runGitEnv().GIT_CONFIG_COUNT);
  for (const n of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "SSH_AUTH_SOCK"]) assert.ok(creds.strip.includes(n), n);
  assert.equal(creds.label, "GitHub App token: o/r (contents:write, pull_requests:write, issues:write), expires 14:00 UTC");
  assert.doesNotMatch(creds.label, /run-1/, "the label never carries the token");
  await creds.dispose();
});

test("createRunCredentials: an issues-only token keeps SSH_AUTH_SOCK (pushes go elsewhere); no github repo at all → null, no mint", async () => {
  const clock = { t: Date.now() };
  const gh = github(clock);
  const timer = manualTimer();
  const dir = path.join(tmp(), "c");
  const creds = await createRunCredentials(auth, { codeRepo: null, issueRepo: "o/r", kind: "implement", dir, fetch: gh.f, now: () => clock.t, setTimeout: timer.setTimeout, clearTimeout: timer.clearTimeout });
  assert.deepEqual(gh.calls[0].body.permissions, { metadata: "read", issues: "write" });
  assert.ok(!creds?.strip.includes("SSH_AUTH_SOCK"));
  assert.ok(creds?.strip.includes("GITHUB_TOKEN"));
  await creds?.dispose();
  const none = await createRunCredentials(auth, { codeRepo: null, issueRepo: null, dir, fetch: gh.f });
  assert.equal(none, null);
  assert.equal(gh.calls.filter((c) => c.method === "POST").length, 1);
});

test("createRunCredentials: refreshes 10 min before expiry with the same body and rewrites hosts.yml", async () => {
  const clock = { t: Date.parse("2026-10-18T13:00:00Z") };
  const gh = github(clock);
  const timer = manualTimer();
  const dir = path.join(tmp(), "r");
  const creds = await createRunCredentials(auth, { codeRepo: "o/r", issueRepo: "o/i", kind: "review", dir, fetch: gh.f, now: () => clock.t, setTimeout: timer.setTimeout, clearTimeout: timer.clearTimeout });
  assert.equal(timer.pending().length, 1);
  assert.equal(timer.pending()[0].ms, HOUR - RUN_TOKEN_REFRESH_MS);
  clock.t += HOUR - RUN_TOKEN_REFRESH_MS;
  await timer.fire();
  assert.equal(gh.calls.length, 2);
  assert.deepEqual(gh.calls[1].body, gh.calls[0].body, "the same scoped body");
  assert.deepEqual(gh.calls[1].body.repositories, ["r", "i"]);
  const hosts = fs.readFileSync(path.join(dir, "gh", "hosts.yml"), "utf8");
  assert.match(hosts, /oauth_token: run-2/);
  assert.doesNotMatch(hosts, /run-1/);
  assert.equal(gh.calls.filter((c) => c.method === "DELETE").length, 0, "the old token is left to expire, not revoked");
  assert.equal(timer.pending().length, 1, "the next refresh is scheduled");
  await creds?.dispose();
  assert.equal(gh.calls.at(-1)?.auth, "Bearer run-2", "dispose revokes the CURRENT token");
});

test("createRunCredentials: a failed refresh logs, does not throw, and retries every minute until expiry", async () => {
  const clock = { t: Date.parse("2026-10-18T13:00:00Z") };
  const gh = github(clock);
  const timer = manualTimer();
  /** @type {string[]} */
  const lines = [];
  const dir = path.join(tmp(), "f");
  const creds = await createRunCredentials(auth, { codeRepo: "o/r", issueRepo: null, dir, log: (l) => lines.push(l), fetch: gh.f, now: () => clock.t, setTimeout: timer.setTimeout, clearTimeout: timer.clearTimeout });
  gh.state.fail = 2;
  clock.t += HOUR - RUN_TOKEN_REFRESH_MS;
  await timer.fire();
  assert.equal(lines.length, 1);
  assert.match(lines[0], /GitHub run token refresh failed: GitHub App installation token 502: Bad gateway — retrying every 60s/);
  assert.equal(timer.pending().at(-1)?.ms, RUN_TOKEN_RETRY_MS);
  clock.t += RUN_TOKEN_RETRY_MS;
  await timer.fire();
  assert.equal(lines.length, 2);
  clock.t += RUN_TOKEN_RETRY_MS;
  await timer.fire(); // the API is back
  assert.match(fs.readFileSync(path.join(dir, "gh", "hosts.yml"), "utf8"), /oauth_token: run-2/);
  // Past expiry a failure stops retrying (the run itself is never killed).
  gh.state.fail = 1;
  clock.t += 2 * HOUR;
  await timer.fire();
  assert.match(String(lines.at(-1)), /the token has expired/);
  assert.equal(timer.pending().length, 0);
  await creds?.dispose();
});

test("createRunCredentials: dispose stops the timer, DELETEs /installation/token with the token, removes the dir; idempotent", async () => {
  const clock = { t: Date.now() };
  const gh = github(clock);
  const timer = manualTimer();
  const dir = path.join(tmp(), "d");
  const creds = await createRunCredentials(auth, { codeRepo: "o/r", issueRepo: null, dir, fetch: gh.f, now: () => clock.t, setTimeout: timer.setTimeout, clearTimeout: timer.clearTimeout });
  await creds?.dispose();
  await creds?.dispose();
  const deletes = gh.calls.filter((c) => c.method === "DELETE");
  assert.equal(deletes.length, 1, "idempotent");
  assert.equal(deletes[0].url, "https://api.github.com/installation/token");
  assert.equal(deletes[0].auth, "Bearer run-1");
  assert.equal(fs.existsSync(dir), false);
  assert.equal(timer.pending().length, 0, "the refresh timer is cleared");
});

test("createRunCredentials: a revoke that throws is swallowed — dispose never throws", async () => {
  const clock = { t: Date.now() };
  const gh = github(clock);
  const timer = manualTimer();
  const dir = path.join(tmp(), "t");
  /** @type {any} */
  const f = async (/** @type {string} */ url, /** @type {any} */ init) => {
    if (init.method === "DELETE") throw new Error("network down");
    return gh.f(url, init);
  };
  const creds = await createRunCredentials(auth, { codeRepo: "o/r", issueRepo: null, dir, fetch: f, now: () => clock.t, setTimeout: timer.setTimeout, clearTimeout: timer.clearTimeout });
  await creds?.dispose();
  assert.equal(fs.existsSync(dir), false);
});

test("a run token never lands in the receiver's createGithubAuth cache", async () => {
  resetGithubAuthCache();
  const clock = { t: Date.now() };
  const gh = github(clock);
  const saved = globalThis.fetch;
  /** @type {any} */
  const recv = async () => ({ ok: true, status: 201, json: async () => ({ token: "receiver", expires_at: new Date(clock.t + HOUR).toISOString() }) });
  try {
    const receiver = createGithubAuth({ auth }, { fetch: recv });
    assert.equal(await receiver.header(), "Bearer receiver");
    const timer = manualTimer();
    const creds = await createRunCredentials(auth, { codeRepo: "o/r", issueRepo: null, dir: path.join(tmp(), "c"), fetch: gh.f, now: () => clock.t, setTimeout: timer.setTimeout, clearTimeout: timer.clearTimeout });
    assert.equal(await createGithubAuth({ auth }, { fetch: recv }).header(), "Bearer receiver");
    assert.equal(await receiver.header(), "Bearer receiver");
    await creds?.dispose();
  } finally {
    globalThis.fetch = saved;
    resetGithubAuthCache();
  }
});

test("githubRunCredentials: null without App auth or with githubRunToken:false; a failure throws `GitHub run token: …`", async () => {
  const o = /** @type {any} */ ({ ref: "1", step: { id: "code" }, task: { url: "https://github.com/o/r/issues/1" }, repoPath: "/nope", dir: path.join(tmp(), "x"), log: () => {} });
  assert.equal(await githubRunCredentials({ token: "pat" }, {}, { codeRepo: () => "o/r" })(o), null);
  assert.equal(await githubRunCredentials({ auth }, { githubRunToken: false }, { codeRepo: () => "o/r" })(o), null);
  await assert.rejects(githubRunCredentials({ auth }, {}, { codeRepo: () => "p/code" })(o), /^Error: GitHub run token: issue repo o\/r and code repo p\/code are under different accounts/);
});

test("staleRunCreds: only run-creds dirs whose newest mtime is older than 2h", () => {
  const data = tmp();
  const fresh = path.join(data, "run-creds", "1-code");
  const old = path.join(data, "run-creds", "2-code");
  for (const d of [fresh, old]) fs.mkdirSync(path.join(d, "gh"), { recursive: true });
  fs.writeFileSync(path.join(fresh, "gh", "hosts.yml"), "x");
  const past = new Date(Date.now() - 3 * HOUR);
  for (const p of [path.join(fresh, "gh"), fresh]) fs.utimesSync(p, past, past); // only the file is fresh (a refresh)
  for (const p of [path.join(old, "gh"), old]) fs.utimesSync(p, past, past);
  assert.deepEqual(staleRunCreds(data), [old]);
  assert.deepEqual(staleRunCreds(tmp()), [], "no run-creds dir");
});
