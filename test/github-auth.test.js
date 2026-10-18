import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// src/github-auth.js — the GitHub App JWT and the installation-token cache (no network:
// fetch is injected or stubbed on global).
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { appJwt, createGithubAuth, githubFetch, normalizePem, resetGithubAuthCache, isAppAuth } from "../src/github-auth.js";

const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const TEST_PEM = privateKey.export({ type: "pkcs1", format: "pem" }).toString();

/** @param {string} part */
const decode = (part) => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));

test("appJwt: RS256 header, iss/iat/exp claims, and a signature the public key verifies", () => {
  const now = 1_700_000_000;
  const jwt = appJwt({ appId: 12345, privateKey: TEST_PEM, now });
  const [h, c, s] = jwt.split(".");
  assert.deepEqual(decode(h), { alg: "RS256", typ: "JWT" });
  const claims = decode(c);
  assert.deepEqual(Object.keys(claims).sort(), ["exp", "iat", "iss"]);
  assert.equal(claims.iss, "12345");
  assert.equal(claims.iat, now - 60);
  assert.ok(claims.exp <= now + 600 && claims.exp > now, `exp ${claims.exp}`);
  assert.ok(crypto.verify("sha256", Buffer.from(`${h}.${c}`), publicKey, Buffer.from(s, "base64url")));
});

test("normalizePem: a one-line .env PEM (literal \\n) signs like the real one", () => {
  const oneLine = TEST_PEM.replace(/\n/g, "\\n");
  assert.ok(!oneLine.includes("\n"));
  assert.equal(normalizePem(oneLine), TEST_PEM);
  const [h, c, s] = appJwt({ appId: 1, privateKey: oneLine, now: 1 }).split(".");
  assert.ok(crypto.verify("sha256", Buffer.from(`${h}.${c}`), publicKey, Buffer.from(s, "base64url")));
});

test("isAppAuth / token mode: Bearer <token> unchanged, no fetch", async () => {
  assert.equal(isAppAuth({ auth: { type: "app" } }), true);
  assert.equal(isAppAuth({ token: "t" }), false);
  let fetched = 0;
  const a = createGithubAuth({ token: "pat" }, { fetch: /** @type {any} */ (async () => (fetched++, {})) });
  assert.equal(a.app, false);
  assert.equal(await a.header(), "Bearer pat");
  assert.equal(fetched, 0);
});

/** A mocked access_tokens endpoint minting tok-1, tok-2, … that expire `ttlMs` after `clock.t`.
 * @param {{t: number}} clock @param {number} [ttlMs] */
function tokenServer(clock, ttlMs = 60 * 60 * 1000) {
  const calls = /** @type {{url: string, init: any}[]} */ ([]);
  /** @type {any} */
  const f = async (/** @type {string} */ url, /** @type {any} */ init) => {
    calls.push({ url, init });
    await new Promise((r) => setImmediate(r));
    const n = calls.length;
    return { ok: true, status: 201, json: async () => ({ token: `tok-${n}`, expires_at: new Date(clock.t + ttlMs).toISOString() }) };
  };
  return { f, calls };
}

const APP = { type: /** @type {const} */ ("app"), appId: "77", installationId: "88", privateKey: TEST_PEM };

test("installation token: one fetch serves repeated calls; the JWT goes to /app/installations/<id>/access_tokens", async () => {
  resetGithubAuthCache();
  const clock = { t: 1_700_000_000_000 };
  const { f, calls } = tokenServer(clock);
  const a = createGithubAuth({ auth: APP }, { fetch: f, now: () => clock.t });
  assert.equal(await a.header(), "Bearer tok-1");
  assert.equal(await a.header(), "Bearer tok-1");
  clock.t += 30 * 60 * 1000; // half-way through the hour: still cached
  assert.equal(await a.header(), "Bearer tok-1");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.github.com/app/installations/88/access_tokens");
  assert.equal(calls[0].init.method, "POST");
  const jwt = String(calls[0].init.headers.Authorization).replace(/^Bearer /, "");
  assert.equal(decode(jwt.split(".")[1]).iss, "77");
});

test("installation token: within 5 minutes of expires_at it is refetched", async () => {
  resetGithubAuthCache();
  const clock = { t: 1_700_000_000_000 };
  const { f, calls } = tokenServer(clock);
  const a = createGithubAuth({ auth: APP }, { fetch: f, now: () => clock.t });
  assert.equal(await a.header(), "Bearer tok-1");
  clock.t += 55 * 60 * 1000 + 1; // 4m59s before expiry
  assert.equal(await a.header(), "Bearer tok-2");
  assert.equal(calls.length, 2);
});

test("installation token: concurrent callers share one fetch; tracker + forge on one installation share the cache", async () => {
  resetGithubAuthCache();
  const clock = { t: 1_700_000_000_000 };
  const { f, calls } = tokenServer(clock);
  const tracker = createGithubAuth({ auth: APP }, { fetch: f, now: () => clock.t });
  const forge = createGithubAuth({ auth: { ...APP } }, { fetch: f, now: () => clock.t });
  const got = await Promise.all([tracker.header(), tracker.header(), forge.header()]);
  assert.deepEqual(got, ["Bearer tok-1", "Bearer tok-1", "Bearer tok-1"]);
  assert.equal(calls.length, 1);
});

test("installation token: a failed mint rejects and is not cached (the next call retries)", async () => {
  resetGithubAuthCache();
  let n = 0;
  /** @type {any} */
  const f = async () => (++n === 1 ? { ok: false, status: 401, json: async () => ({ message: "Bad credentials" }) } : { ok: true, status: 201, json: async () => ({ token: "ok", expires_at: new Date(Date.now() + 3600e3).toISOString() }) });
  const a = createGithubAuth({ auth: APP }, { fetch: f });
  await assert.rejects(a.header(), /installation token 401: Bad credentials/);
  assert.equal(await a.header(), "Bearer ok");
});

test("githubFetch: a 401 invalidates the cached token and retries once with a fresh one", async () => {
  resetGithubAuthCache();
  const clock = { t: 1_700_000_000_000 };
  const { f, calls } = tokenServer(clock);
  const a = createGithubAuth({ auth: APP }, { fetch: f, now: () => clock.t });
  /** @type {string[]} */
  const seen = [];
  const orig = global.fetch;
  // @ts-ignore - test stub: the API rejects tok-1 (revoked), accepts tok-2
  global.fetch = async (url, init = {}) => {
    const h = /** @type {any} */ (init.headers).Authorization;
    seen.push(h);
    return /** @type {any} */ ({ ok: h === "Bearer tok-2", status: h === "Bearer tok-2" ? 200 : 401, json: async () => ({}) });
  };
  try {
    const res = await githubFetch(a, "https://api.github.com/repos/o/r", { headers: { Accept: "x" } });
    assert.equal(res.status, 200);
  } finally {
    global.fetch = orig;
  }
  assert.deepEqual(seen, ["Bearer tok-1", "Bearer tok-2"]);
  assert.equal(calls.length, 2, "minted a fresh token after the 401");
});

test("githubFetch: under token auth a 401 is returned as-is (no retry)", async () => {
  const a = createGithubAuth({ token: "pat" });
  let n = 0;
  const orig = global.fetch;
  // @ts-ignore - test stub
  global.fetch = async () => (n++, /** @type {any} */ ({ ok: false, status: 401, json: async () => ({}) }));
  try {
    assert.equal((await githubFetch(a, "https://api.github.com/user")).status, 401);
  } finally {
    global.fetch = orig;
  }
  assert.equal(n, 1);
});

test("src/github-auth.js imports only node:crypto (no dependency)", () => {
  const src = fs.readFileSync(new URL("../src/github-auth.js", import.meta.url), "utf8");
  const imports = [...src.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
  assert.deepEqual(imports, ["node:crypto"]);
});
