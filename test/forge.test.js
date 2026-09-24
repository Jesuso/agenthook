// GitHub forge — pure-unit coverage (no network): the shared x-hub-signature-256
// verifier, branch → ref mapping, authenticate reject/accept, merged-PR routing in
// processEvents, and the `/forge`-only hook scrub.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { verifyHubSignature } from "../src/hmac.js";
import { createGithubForge, refFromBranch, isForgePath } from "../src/forges/github.js";
import { createForge } from "../src/forges/index.js";

/** Minimal in-memory Store stub (only secrets are used). */
function makeStore() {
  const m = new Map();
  return { getSecret: (k) => m.get(k), setSecret: (k, v) => m.set(k, v) };
}

const SECRET = "s3cr3t";
const pipeline = [
  { id: "code", sourceSectionGid: "S1" },
  { id: "done", manual: true, completeOnMerge: true, drainWorktree: true, sourceSectionGid: "S9" },
];

/** @param {any} [fc] @param {any} [pl] */
function forge(fc = {}, pl = pipeline) {
  const cfg = { pipeline: pl, forge: { type: "github", token: "t", repository: "o/r", webhookSecret: SECRET, ...fc } };
  return createGithubForge(/** @type {any} */ (cfg), /** @type {any} */ (makeStore()));
}

/** @param {string} body @param {string} [secret] */
const sign = (body, secret = SECRET) => "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");

/** @param {any} payload @param {string} [event] */
function ctx(payload, event = "pull_request") {
  const rawBody = JSON.stringify(payload);
  return /** @type {any} */ ({ pathname: "/forge", headers: { "x-github-event": event, "x-hub-signature-256": sign(rawBody) }, rawBody });
}

/** @param {any} [over] */
const merged = (over = {}) => ({ action: "closed", pull_request: { number: 77, merged: true, head: { ref: "agent/123" }, ...over } });

// --- shared verifier ---

test("verifyHubSignature accepts a correct sha256= signature", () => {
  assert.equal(verifyHubSignature("k", "body", sign("body", "k")), true);
});

test("verifyHubSignature rejects bad, missing, or secretless input", () => {
  assert.equal(verifyHubSignature("k", "body", "sha256=deadbeef"), false);
  assert.equal(verifyHubSignature("k", "body", undefined), false);
  assert.equal(verifyHubSignature(undefined, "body", sign("body", "k")), false);
  assert.equal(verifyHubSignature("other", "body", sign("body", "k")), false);
});

test("verifyHubSignature takes the first value of an array header", () => {
  assert.equal(verifyHubSignature("k", "body", [sign("body", "k")]), true);
});

// --- branch → ref ---

test("refFromBranch maps agent/<ref> and rejects anything else", () => {
  assert.equal(refFromBranch("agent/123"), "123");
  assert.equal(refFromBranch("agent/ABC-12"), "ABC-12");
  assert.equal(refFromBranch("agent/1209876543210"), "1209876543210");
  assert.equal(refFromBranch("feature/x"), null);
  assert.equal(refFromBranch("agent/"), null);
  assert.equal(refFromBranch(undefined), null);
});

test("isForgePath tolerates a trailing slash and nothing else", () => {
  assert.equal(isForgePath("/forge"), true);
  assert.equal(isForgePath("/forge/"), true);
  assert.equal(isForgePath("/github/"), false);
  assert.equal(isForgePath("/forge/x"), false);
});

// --- authenticate ---

test("authenticate accepts a correctly signed body", () => {
  assert.equal(forge().authenticate(ctx(merged())).type, "accept");
});

test("authenticate rejects a bad or missing signature", () => {
  const rawBody = JSON.stringify(merged());
  assert.equal(forge().authenticate(/** @type {any} */ ({ rawBody, headers: { "x-hub-signature-256": "sha256=deadbeef" } })).type, "reject");
  assert.equal(forge().authenticate(/** @type {any} */ ({ rawBody, headers: {} })).type, "reject");
});

test("authenticate has no opt-out: webhookSecret:false still verifies (generated secret)", () => {
  const f = forge({ webhookSecret: false });
  assert.equal(f.authenticate(/** @type {any} */ ({ rawBody: "{}", headers: {} })).type, "reject");
});

test("a generated secret is persisted under forge:github:webhookSecret and verifies", () => {
  const store = makeStore();
  const cfg = { pipeline, forge: { type: "github", token: "t", repository: "o/r" } };
  const f = createGithubForge(/** @type {any} */ (cfg), /** @type {any} */ (store));
  f.authenticate(/** @type {any} */ ({ rawBody: "{}", headers: {} })); // triggers generation
  const secret = store.getSecret("forge:github:webhookSecret");
  assert.ok(secret && secret.length >= 32);
  const rawBody = "{}";
  assert.equal(f.authenticate(/** @type {any} */ ({ rawBody, headers: { "x-hub-signature-256": sign(rawBody, secret) } })).type, "accept");
});

// --- processEvents ---

test("merged PR on agent/<ref> → one merge job keyed merged:<n>, stepId = completeOnMerge step", async () => {
  const jobs = await forge().processEvents(ctx(merged()));
  assert.deepEqual(jobs, [{ kind: "merge", ref: "123", stepId: "done", dedupKey: "merged:77" }]);
});

test("merged PR with no completeOnMerge step → stepId is empty", async () => {
  const jobs = await forge({}, [{ id: "code" }]).processEvents(ctx(merged({ head: { ref: "agent/ABC-12" } })));
  assert.deepEqual(jobs, [{ kind: "merge", ref: "ABC-12", stepId: "", dedupKey: "merged:77" }]);
});

test("PR closed without merging → no job", async () => {
  assert.deepEqual(await forge().processEvents(ctx(merged({ merged: false }))), []);
});

test("non-closed PR action → no job", async () => {
  assert.deepEqual(await forge().processEvents(ctx({ ...merged(), action: "opened" })), []);
});

test("merged PR on a non-agent branch → no job", async () => {
  assert.deepEqual(await forge().processEvents(ctx(merged({ head: { ref: "feature/x" } }))), []);
});

test("non-pull_request events (ping, push) → no job", async () => {
  assert.deepEqual(await forge().processEvents(ctx({ zen: "hi" }, "ping")), []);
  assert.deepEqual(await forge().processEvents(ctx(merged(), "push")), []);
});

// --- hooks ---

test("registerWebhook deletes only /forge hooks, then creates a pull_request hook at <url>/forge", async () => {
  /** @type {string[]} */
  const calls = [];
  let created;
  const orig = global.fetch;
  // @ts-ignore - test stub
  global.fetch = async (url, init = {}) => {
    const method = init.method || "GET";
    calls.push(`${method} ${url}`);
    if (method === "GET") {
      return {
        ok: true,
        status: 200,
        json: async () => [
          { id: 1, config: { url: "https://old.example/forge" } },
          { id: 2, config: { url: "https://old.example/github/" } },
          { id: 3, config: { url: "https://old.example/mytasks/" } },
        ],
      };
    }
    if (method === "POST") created = JSON.parse(String(init.body));
    return { ok: true, status: 201, json: async () => ({ id: 9, active: true }) };
  };
  try {
    await forge().registerWebhook("https://new.example/");
  } finally {
    global.fetch = orig;
  }
  const deletes = calls.filter((c) => c.startsWith("DELETE"));
  assert.deepEqual(deletes, ["DELETE https://api.github.com/repos/o/r/hooks/1"]);
  assert.deepEqual(created.events, ["pull_request"]);
  assert.equal(created.config.url, "https://new.example/forge");
  assert.equal(created.config.secret, SECRET);
  assert.equal(created.config.content_type, "json");
});

test("registerWebhook on 403 prints manual setup instead of throwing", async () => {
  const orig = global.fetch;
  const warn = console.warn;
  /** @type {string[]} */
  const warnings = [];
  console.warn = (m) => warnings.push(String(m));
  // @ts-ignore - test stub
  global.fetch = async () => ({ ok: false, status: 403, json: async () => ({}) });
  try {
    await forge().registerWebhook("https://new.example");
  } finally {
    global.fetch = orig;
    console.warn = warn;
  }
  assert.ok(warnings.some((w) => w.includes("https://new.example/forge") && w.includes("Pull requests")));
});

// --- registry ---

test("createForge: null without a forge block; throws on an unknown type", () => {
  assert.equal(createForge(/** @type {any} */ ({ pipeline }), /** @type {any} */ (makeStore())), null);
  assert.throws(() => createForge(/** @type {any} */ ({ pipeline, forge: { type: "gitlab" } }), /** @type {any} */ (makeStore())), /unknown forge "gitlab"/);
});
