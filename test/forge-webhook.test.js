import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// GitHub forge — pure-unit coverage (no network): the shared x-hub-signature-256
// verifier, the `init` wizard helpers (parseGithubRemote/forgeOffer/mergeStepCandidates/
// forgeBlock), branch → ref mapping, and `authenticate` accept/reject.
import test from "node:test";
import assert from "node:assert/strict";
import { verifyHubSignature } from "../src/hmac.js";
import { createGithubForge, refFromBranch, isForgePath, parseGithubRemote, forgeOffer, mergeStepCandidates, forgeBlock } from "../src/forges/github.js";
import { forge, makeStore, pipeline, sign, ctx, merged } from "./_forge-helpers.js";

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

// --- init helpers (parseGithubRemote, forgeOffer, mergeStepCandidates, forgeBlock) ---

test("parseGithubRemote handles the three URL forms, with and without .git", () => {
  assert.equal(parseGithubRemote("git@github.com:Jesuso/agenthook.git"), "Jesuso/agenthook");
  assert.equal(parseGithubRemote("git@github.com:Jesuso/agenthook"), "Jesuso/agenthook");
  assert.equal(parseGithubRemote("https://github.com/Jesuso/agenthook.git"), "Jesuso/agenthook");
  assert.equal(parseGithubRemote("https://github.com/Jesuso/agenthook"), "Jesuso/agenthook");
  assert.equal(parseGithubRemote("ssh://git@github.com/Jesuso/agenthook.git"), "Jesuso/agenthook");
  assert.equal(parseGithubRemote("ssh://git@github.com/Jesuso/agenthook"), "Jesuso/agenthook");
});

test("parseGithubRemote rejects non-github.com hosts or garbage", () => {
  assert.equal(parseGithubRemote("git@gitlab.com:o/r.git"), null);
  assert.equal(parseGithubRemote("https://gitlab.com/o/r"), null);
  assert.equal(parseGithubRemote("not a url"), null);
  assert.equal(parseGithubRemote(""), null);
  assert.equal(parseGithubRemote(undefined), null);
  assert.equal(parseGithubRemote(null), null);
});

test("forgeOffer: github tracker defaults yes with the tracker's own repo", () => {
  assert.deepEqual(forgeOffer({ trackerType: "github", trackerRepository: "o/r", remoteUrl: "" }), {
    defaultYes: true,
    repository: "o/r",
  });
});

test("forgeOffer: non-github tracker with a github.com remote defaults yes with the parsed repo", () => {
  assert.deepEqual(forgeOffer({ trackerType: "asana", trackerRepository: undefined, remoteUrl: "git@github.com:o/r.git" }), {
    defaultYes: true,
    repository: "o/r",
  });
});

test("forgeOffer: non-github tracker with a non-github remote (or none) defaults no", () => {
  assert.deepEqual(forgeOffer({ trackerType: "jira", trackerRepository: undefined, remoteUrl: "git@gitlab.com:o/r.git" }), {
    defaultYes: false,
    repository: null,
  });
  assert.deepEqual(forgeOffer({ trackerType: "jira", remoteUrl: "" }), { defaultYes: false, repository: null });
  assert.deepEqual(forgeOffer(), { defaultYes: false, repository: null });
});

test("mergeStepCandidates: only manual step ids, empty for init's generated pipeline", () => {
  assert.deepEqual(mergeStepCandidates(pipeline), ["done"]);
  assert.deepEqual(mergeStepCandidates([{ id: "code", createsWorktree: true }]), []);
  assert.deepEqual(mergeStepCandidates([]), []);
  assert.deepEqual(mergeStepCandidates(undefined), []);
});

test("forgeBlock: exactly type/repository/token, no other defaults", () => {
  assert.deepEqual(forgeBlock({ repository: "o/r", tokenEnv: "GITHUB_TOKEN" }), {
    type: "github",
    repository: "o/r",
    token: "${GITHUB_TOKEN}",
  });
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

test("refFromBranch: an explicit prefix maps that prefix and rejects agent/ (#674)", () => {
  assert.equal(refFromBranch("local/12", "local/"), "12");
  assert.equal(refFromBranch("agent/12", "local/"), null);
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
