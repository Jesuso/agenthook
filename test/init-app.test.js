import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// `agenthook init` GitHub App helpers (pure): the auth block written for the App answers, the
// permission list printed, and the forge reusing the tracker's App auth.
import test from "node:test";
import assert from "node:assert/strict";
import { githubAppAuthBlock, githubAppPermissionLines, GITHUB_APP_PERMISSIONS, initForgeBlock, preselectTracker, trackerChoiceTitle, missingTokenMessage } from "../src/commands/init.js";
import { validateRawConfig } from "../src/config.js";

test("githubAppAuthBlock: an UPPER_CASE answer is the PEM's env var (a ${VAR} ref); anything else a .pem path", () => {
  assert.deepEqual(githubAppAuthBlock({ appId: "1", installationId: "2", privateKey: "GITHUB_APP_PRIVATE_KEY" }), { type: "app", appId: "1", installationId: "2", privateKey: "${GITHUB_APP_PRIVATE_KEY}" });
  assert.deepEqual(githubAppAuthBlock({ appId: "1", installationId: "2", privateKey: " ./keys/app.pem " }), { type: "app", appId: "1", installationId: "2", privateKeyPath: "./keys/app.pem" });
});

test("the written App block (+ assigneeLogin) validates; without the login it fails closed", () => {
  const auth = githubAppAuthBlock({ appId: "1", installationId: "2", privateKey: "GITHUB_APP_PRIVATE_KEY" });
  const cfg = (/** @type {any} */ extra) => ({ name: "x", repoPath: "/tmp/r", tracker: { type: "github", repository: "o/r", auth, pipeline: [{ id: "code" }], ...extra } });
  assert.deepEqual(validateRawConfig(cfg({ assigneeLogin: "alice" })), { ok: true });
  assert.equal(validateRawConfig(cfg({})).ok, false);
});

test("githubAppPermissionLines: the minimal permissions per tracker, the forge's on request, and the inactive-webhook note", () => {
  const gh = githubAppPermissionLines("github").join("\n");
  assert.match(gh, /Repository: Metadata \(read\), Issues \(read & write\), Webhooks \(read & write\)/);
  assert.match(gh, /webhook INACTIVE/);
  assert.doesNotMatch(gh, /Actions/);
  const proj = githubAppPermissionLines("github-projects", { forge: true }).join("\n");
  assert.match(proj, /Organization: Projects \(read & write\), Webhooks \(read & write\)/);
  assert.match(proj, /Org-owned projects only/);
  assert.ok(proj.includes(GITHUB_APP_PERMISSIONS.forge[0]));
  assert.match(GITHUB_APP_PERMISSIONS.forge[0], /Pull requests \(read\), Checks \(read\), Actions \(read & write\), Issues \(write\), Webhooks \(read & write\)/);
});

test("initForgeBlock: a github forge reuses the tracker's App auth instead of asking for a token", () => {
  const auth = githubAppAuthBlock({ appId: "1", installationId: "2", privateKey: "GITHUB_APP_PRIVATE_KEY" });
  assert.deepEqual(initForgeBlock("github", { repository: "o/r", _appAuth: auth }), { type: "github", repository: "o/r", auth });
  assert.deepEqual(initForgeBlock("github", { repository: "o/r", tokenEnv: "GITHUB_TOKEN" }), { type: "github", repository: "o/r", token: "${GITHUB_TOKEN}" });
});

const TRACKER_TYPES = ["asana", "jira", "github", "github-projects", "linear"];

test("preselectTracker: defaults to the first type whose token env is set, else the first entry", () => {
  assert.equal(preselectTracker(TRACKER_TYPES, {}), "asana");
  assert.equal(preselectTracker(TRACKER_TYPES, { GITHUB_TOKEN: "x" }), "github");
  assert.equal(preselectTracker(TRACKER_TYPES, { JIRA_API_TOKEN: "x", GITHUB_TOKEN: "x" }), "jira"); // earliest in order wins
});

test("trackerChoiceTitle: names the env var found for that type, else just the type", () => {
  assert.equal(trackerChoiceTitle("github", {}), "github");
  assert.equal(trackerChoiceTitle("github", { GITHUB_TOKEN: "x" }), "github  (GITHUB_TOKEN found)");
  assert.equal(trackerChoiceTitle("asana", { GITHUB_TOKEN: "x" }), "asana");
});

test("missingTokenMessage: names the variable and where init looked for it", () => {
  const msg = missingTokenMessage("ASANA_TOKEN", "/repo/.env");
  assert.match(msg, /ASANA_TOKEN/);
  assert.match(msg, /\/repo\/\.env/);
  assert.doesNotMatch(msg, /\$\{/); // never echoes a token value — there isn't one to echo here, but guard the shape
});

test("loadEnv: reads a .env into process.env without clobbering an exported var (init relies on it for the tracker token)", async () => {
  const { loadEnv } = await import("../src/config.js");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-env-"));
  fs.writeFileSync(path.join(dir, ".env"), "AH_TEST_FROM_DOTENV=fromfile\nAH_TEST_EXPORTED=fromfile\n");
  process.env.AH_TEST_EXPORTED = "exported";
  try {
    loadEnv(path.join(dir, ".env"));
    assert.equal(process.env.AH_TEST_FROM_DOTENV, "fromfile");
    assert.equal(process.env.AH_TEST_EXPORTED, "exported");
  } finally {
    delete process.env.AH_TEST_FROM_DOTENV;
    delete process.env.AH_TEST_EXPORTED;
  }
});
