// Shared fixtures for the forge-*.test.js files (split from the former forge.test.js
// so no single test file costs too much to read/load — see #717's dispatch split for
// precedent). Not matched by the `test/*.test.js` glob `npm test` runs, so it is never
// itself executed as a test file.
import crypto from "node:crypto";
import { createGithubForge } from "../src/forges/github.js";

/** Minimal in-memory Store stub (only secrets are used). */
export function makeStore() {
  const m = new Map();
  return { getSecret: (k) => m.get(k), setSecret: (k, v) => m.set(k, v) };
}

export const SECRET = "s3cr3t";
export const pipeline = [
  { id: "code", sourceSectionGid: "S1" },
  { id: "done", manual: true, completeOnMerge: true, drainWorktree: true, sourceSectionGid: "S9" },
];

/** @param {any} [fc] @param {any} [pl] @param {any} [store] @param {any} [cfgOver] */
export function forge(fc = {}, pl = pipeline, store = makeStore(), cfgOver = {}) {
  const cfg = { pipeline: pl, forge: { type: "github", token: "t", repository: "o/r", webhookSecret: SECRET, ...fc }, ...cfgOver };
  return createGithubForge(/** @type {any} */ (cfg), /** @type {any} */ (store));
}

/** @param {string} body @param {string} [secret] */
export const sign = (body, secret = SECRET) => "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");

/** @param {any} payload @param {string} [event] */
export function ctx(payload, event = "pull_request") {
  const rawBody = JSON.stringify(payload);
  return /** @type {any} */ ({ pathname: "/forge", headers: { "x-github-event": event, "x-hub-signature-256": sign(rawBody) }, rawBody });
}

/** @param {any} [over] */
export const merged = (over = {}) => ({ action: "closed", pull_request: { number: 77, merged: true, head: { ref: "agent/123" }, ...over } });

export const ghTracker = { provider: "github", tracker: { type: "github", repository: "O/R" } };

/**
 * Stub global.fetch with a route table: `"METHOD path-suffix" → response`. Records calls.
 * @param {Record<string, any>} routes
 */
export function stubFetch(routes) {
  /** @type {{method: string, url: string, body?: any}[]} */
  const calls = [];
  const orig = global.fetch;
  // @ts-ignore - test stub
  global.fetch = async (url, init = {}) => {
    const method = init.method || "GET";
    calls.push({ method, url: String(url), body: init.body ? JSON.parse(String(init.body)) : undefined });
    const hit = Object.entries(routes).find(([k]) => {
      const [m, suffix] = k.split(" ");
      return m === method && String(url).endsWith(suffix);
    });
    if (!hit) return { ok: false, status: 404, json: async () => ({}), text: async () => "", headers: new Headers() };
    const r = hit[1];
    return { ok: (r.status ?? 200) < 300, status: r.status ?? 200, json: async () => r.json, text: async () => r.text ?? "", headers: new Headers(r.headers ?? {}) };
  };
  return { calls, restore: () => (global.fetch = orig) };
}
