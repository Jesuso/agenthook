// GitHub auth shared by the `github` / `github-projects` trackers and the `github` forge.
// Either a personal token (`token`, sent as `Bearer <token>` exactly as before) or a GitHub
// App (`auth: { type: "app", appId, installationId, privateKey }`): an RS256 JWT signed with
// the App's private key is exchanged for an installation token, which expires after an hour
// and is cached until 5 minutes before that. node:crypto only — no JWT dependency.
//
// The installation-token cache is module-level, keyed `appId:installationId`, so a tracker
// and a forge on the same installation share one token. An in-flight fetch is memoised (the
// same way the adapters memoise `ourLogin`), so concurrent callers share one request; a
// failure clears it so the next call retries. githubFetch retries a 401 once with a fresh token.
import crypto from "node:crypto";

const API = "https://api.github.com";
// Refetch an installation token this long before its `expires_at`.
const REFRESH_MS = 5 * 60 * 1000;

/** @typedef {import('./types.js').GithubAuthConfig} GithubAuthConfig */
/** What every GitHub adapter calls instead of reading the raw token.
 * @typedef {object} GithubAuth
 * @property {boolean} app                     true under GitHub App auth
 * @property {() => Promise<string>} header    the `Authorization` header value
 * @property {(stale?: string) => void} invalidate  drop the cached installation token (only if it is still `stale`, when given)
 */

/** Is this config block's `auth` a GitHub App? @param {{auth?: any}|undefined|null} block @returns {boolean} */
export const isAppAuth = (block) => block?.auth?.type === "app";

/** A PEM from a one-line `.env` value: literal `\n` sequences become newlines. @param {string} pem */
export const normalizePem = (pem) => String(pem).replace(/\\n/g, "\n");

/** @param {string|Buffer} b */
const b64url = (b) => Buffer.from(b).toString("base64url");

/** The App's RS256 JWT: `iat` backdated 60s for clock drift, `exp` 9 minutes out (GitHub caps it at 10).
 * @param {{appId: string|number, privateKey: string, now?: number}} o  `now` in epoch seconds
 * @returns {string} */
export function appJwt({ appId, privateKey, now = Math.floor(Date.now() / 1000) }) {
  const input = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: String(appId) }))}`;
  const sig = crypto.sign("sha256", Buffer.from(input), crypto.createPrivateKey(normalizePem(privateKey)));
  return `${input}.${b64url(sig)}`;
}

/**
 * POST `/app/installations/{id}/access_tokens`. No `body` = the installation's full permissions on
 * every repo it covers (the receiver's token); a `{repositories, permissions}` body narrows it (a
 * per-run agent token, src/github-run-token.js). Never touches the cache below.
 * @param {GithubAuthConfig} auth @param {{repositories?: string[], permissions?: Record<string,string>}|undefined} body
 * @param {{fetch?: typeof fetch, now?: () => number}} [opts]  `now` in epoch ms
 * @returns {Promise<{token: string, expiresAt: number}>} */
export async function mintInstallationToken(auth, body, { fetch: f = (...a) => globalThis.fetch(...a), now = Date.now } = {}) {
  if (!auth?.privateKey) throw new Error(`GitHub App ${auth?.appId}: no private key (set auth.privateKey or auth.privateKeyPath)`);
  const jwt = appJwt({ appId: auth.appId, privateKey: auth.privateKey, now: Math.floor(now() / 1000) });
  const res = await f(`${API}/app/installations/${auth.installationId}/access_tokens`, {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  /** @type {any} */
  const out = await res.json().catch(() => ({}));
  if (!res.ok || !out?.token) throw new Error(`GitHub App installation token ${res.status}: ${out?.message || "no token in the response"}`);
  return { token: out.token, expiresAt: Date.parse(out.expires_at) || now() + 60 * 60 * 1000 };
}

/** @type {Map<string, {token: string|null, expiresAt: number, inflight: Promise<string>|null}>} */
const caches = new Map();

/** Forget every cached installation token (tests). */
export function resetGithubAuthCache() {
  caches.clear();
}

/**
 * The auth helper for one config block (`tracker` or `forge`). `auth.type === "app"` mints
 * installation tokens; anything else returns `Bearer <token>` unchanged (today's behaviour).
 * @param {{token?: string, auth?: GithubAuthConfig}} block
 * @param {{fetch?: typeof fetch, now?: () => number}} [opts]  `now` in epoch ms
 * @returns {GithubAuth}
 */
export function createGithubAuth(block, { fetch: f = (...a) => globalThis.fetch(...a), now = Date.now } = {}) {
  const auth = block?.auth;
  if (auth?.type !== "app") {
    const value = `Bearer ${block?.token}`;
    return { app: false, header: async () => value, invalidate: () => {} };
  }
  const key = `${auth.appId}:${auth.installationId}`;
  let c = caches.get(key);
  if (!c) caches.set(key, (c = { token: null, expiresAt: 0, inflight: null }));
  const cache = c;

  /** @returns {Promise<string>} */
  async function mint() {
    const { token, expiresAt } = await mintInstallationToken(/** @type {GithubAuthConfig} */ (auth), undefined, { fetch: f, now });
    cache.token = token;
    cache.expiresAt = expiresAt;
    return token;
  }

  return {
    app: true,
    header: async () => {
      if (cache.token && cache.expiresAt - REFRESH_MS > now()) return `Bearer ${cache.token}`;
      if (!cache.inflight) {
        cache.inflight = mint().finally(() => {
          cache.inflight = null;
        });
      }
      return `Bearer ${await cache.inflight}`;
    },
    invalidate: (stale) => {
      if (stale && stale !== `Bearer ${cache.token}`) return; // another caller already refreshed it
      cache.token = null;
      cache.expiresAt = 0;
    },
  };
}

/** `fetch` with the auth header added (before `init.headers`). Under App auth a 401 drops the
 * cached installation token and retries once with a fresh one.
 * @param {GithubAuth} auth @param {string} url @param {RequestInit} [init] @returns {Promise<Response>} */
export async function githubFetch(auth, url, init = {}) {
  const send = async () => {
    const h = await auth.header();
    return { h, res: await globalThis.fetch(url, { ...init, headers: { Authorization: h, ...(init.headers || {}) } }) };
  };
  const first = await send();
  if (first.res.status !== 401 || !auth.app) return first.res;
  auth.invalidate(first.h);
  return (await send()).res;
}
