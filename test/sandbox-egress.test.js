import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// A sandboxed run's allowlist (src/sandbox/egress.js) and the adapters' egress hosts. Pure.
import test from "node:test";
import assert from "node:assert/strict";
import { egressRules, egressPolicy, urlRule, originRule, REGISTRY_PRESETS, needsEgressProxy } from "../src/sandbox/egress.js";
import { claudeEgressHosts, claude } from "../src/agents/claude.js";
import { TRACKER_EGRESS_HOSTS } from "../src/trackers/index.js";
import { FORGE_EGRESS_HOSTS } from "../src/forges/index.js";

test("claude: api.anthropic.com, plus ANTHROPIC_BASE_URL's host:port, Bedrock and Vertex endpoints", () => {
  assert.equal(claude.egressHosts, claudeEgressHosts);
  assert.deepEqual(claudeEgressHosts({}), ["api.anthropic.com"]);
  const rules = egressRules({ agentHosts: claudeEgressHosts({ ANTHROPIC_BASE_URL: "https://llm.corp:8443/v1" }) });
  assert.ok(rules.includes("llm.corp:8443"), rules.join(" "));
  assert.deepEqual(claudeEgressHosts({ ANTHROPIC_BASE_URL: "http://gpu.lan/" }), ["api.anthropic.com", "gpu.lan:80"]);
  assert.ok(claudeEgressHosts({ CLAUDE_CODE_USE_BEDROCK: "1", AWS_REGION: "us-east-1" }).includes("bedrock-runtime.us-east-1.amazonaws.com"));
  assert.ok(claudeEgressHosts({ CLAUDE_CODE_USE_VERTEX: "1", CLOUD_ML_REGION: "us-east5" }).includes("us-east5-aiplatform.googleapis.com"));
  assert.deepEqual(claudeEgressHosts({ CLAUDE_CODE_USE_BEDROCK: "0", AWS_REGION: "us-east-1" }), ["api.anthropic.com"]);
});

test("tracker and forge hosts: jira's baseUrl host (with port), linear, github, gitlab's baseUrl", () => {
  const jira = TRACKER_EGRESS_HOSTS.jira(/** @type {any} */ ({ baseUrl: "https://jira.acme.io:8443/" }));
  assert.deepEqual(jira, ["jira.acme.io:8443"]);
  assert.deepEqual(TRACKER_EGRESS_HOSTS.jira(/** @type {any} */ ({ site: "acme" })), ["acme.atlassian.net"]);
  assert.ok(egressRules({ trackerHosts: jira }).includes("jira.acme.io:8443"));
  assert.deepEqual(TRACKER_EGRESS_HOSTS.asana(/** @type {any} */ ({})), ["app.asana.com"]);
  assert.deepEqual(TRACKER_EGRESS_HOSTS.linear(/** @type {any} */ ({})), ["api.linear.app"]);
  assert.deepEqual(TRACKER_EGRESS_HOSTS.github(/** @type {any} */ ({})), ["api.github.com"]);
  assert.deepEqual(TRACKER_EGRESS_HOSTS["github-projects"](/** @type {any} */ ({})), ["api.github.com"]);
  assert.deepEqual(TRACKER_EGRESS_HOSTS.local(/** @type {any} */ ({})), []);
  assert.deepEqual(FORGE_EGRESS_HOSTS.github(/** @type {any} */ ({})), ["github.com", "api.github.com", "uploads.github.com", "*.githubusercontent.com"]);
  assert.deepEqual(FORGE_EGRESS_HOSTS.gitlab(/** @type {any} */ ({})), ["gitlab.com"]);
  assert.deepEqual(FORGE_EGRESS_HOSTS.gitlab(/** @type {any} */ ({ baseUrl: "https://git.acme.io:4443" })), ["git.acme.io:4443"]);
});

test("egressRules: order agent → tracker → forge → origin → allow, deduped; the origin host is included", () => {
  const rules = egressRules({
    agentHosts: ["api.anthropic.com"],
    trackerHosts: ["api.github.com"],
    forgeHosts: ["github.com", "api.github.com"],
    originUrl: "git@git.acme.io:o/r.git",
    allow: ["@npm", "github.com"],
  });
  assert.deepEqual(rules, ["api.anthropic.com", "api.github.com", "github.com", "git.acme.io", "registry.npmjs.org"]);
  assert.ok(egressRules({ originUrl: "https://git.acme.io:4443/o/r.git" }).includes("git.acme.io:4443"), "an https origin keeps its port");
  assert.deepEqual(egressRules({ originUrl: "ssh://git@git.acme.io:2222/o/r.git" }), ["git.acme.io"], "ssh is pushed over https (443)");
});

test("egressRules: presets expand; deny removes a default (or one port); an unknown preset throws", () => {
  assert.deepEqual(egressRules({ allow: ["@npm"] }), REGISTRY_PRESETS["@npm"]);
  assert.deepEqual(egressRules({ allow: ["@pypi", "@crates"] }), ["pypi.org", "files.pythonhosted.org", "crates.io", "index.crates.io", "static.crates.io"]);
  assert.deepEqual(egressRules({ trackerHosts: ["api.linear.app"], agentHosts: ["api.anthropic.com"], deny: ["api.linear.app"] }), ["api.anthropic.com"]);
  assert.deepEqual(egressRules({ allow: ["x.io", "x.io:8443"], deny: ["x.io:8443"] }), ["x.io"], "a port in deny only drops that port");
  assert.deepEqual(egressRules({ allow: ["x.io", "x.io:8443"], deny: ["X.io"] }), [], "no port in deny drops every port of the host");
  assert.deepEqual(egressRules({ allow: ["@npm", "a.io"], deny: ["@npm"] }), ["a.io"]);
  assert.deepEqual(egressRules({ forgeHosts: ["*.githubusercontent.com"], deny: ["githubusercontent.com"] }), ["*.githubusercontent.com"], "deny matches the host pattern exactly");
  assert.throws(() => egressRules({ allow: ["@cpan"] }), /unknown egress preset "@cpan"/);
  assert.throws(() => egressRules({ allow: ["not a host"] }), /invalid egress rule/);
});

test("egressPolicy: the step's mode overrides; allow/deny are additive; allowlist by default", () => {
  const cfg = { sandbox: { egress: { mode: /** @type {const} */ ("allowlist"), allow: ["@npm"], deny: ["api.linear.app"] } } };
  assert.deepEqual(egressPolicy(cfg, { egress: { allow: ["@pypi"] } }), { mode: "allowlist", allow: ["@npm", "@pypi"], deny: ["api.linear.app"] });
  assert.deepEqual(egressPolicy(cfg, { egress: { mode: "none" } }).mode, "none");
  assert.deepEqual(egressPolicy({ sandbox: {} }, undefined), { mode: "allowlist", allow: [], deny: [] });
  const rules = egressRules({ trackerHosts: ["api.linear.app"], ...egressPolicy(cfg, { egress: { allow: ["registry.internal:8443"] } }) });
  assert.deepEqual(rules, ["registry.npmjs.org", "registry.internal:8443"], "step allow adds to the profile's; profile deny still applies");
});

test("urlRule / originRule / needsEgressProxy", () => {
  assert.equal(urlRule("https://h.io/x"), "h.io");
  assert.equal(urlRule("https://h.io:443/x"), "h.io");
  assert.equal(urlRule("http://h.io"), "h.io:80");
  assert.equal(urlRule("http://[::1]:8080"), "[::1]:8080");
  assert.equal(urlRule("nope"), undefined);
  assert.equal(originRule("https://github.com/o/r"), "github.com");
  assert.equal(originRule(undefined), undefined);
  const pipeline = [{ id: "code" }, { id: "done", manual: true }];
  assert.equal(needsEgressProxy(/** @type {any} */ ({ sandbox: { type: "docker" }, pipeline })), true);
  assert.equal(needsEgressProxy(/** @type {any} */ ({ sandbox: { type: "docker", egress: { mode: "open" } }, pipeline })), false);
  assert.equal(needsEgressProxy(/** @type {any} */ ({ sandbox: { type: "docker", egress: { mode: "open" } }, pipeline: [{ id: "c", egress: { mode: "allowlist" } }] })), true);
  assert.equal(needsEgressProxy(/** @type {any} */ ({ sandbox: { type: "docker" }, pipeline: [{ id: "c", sandbox: false }] })), false);
  assert.equal(needsEgressProxy(/** @type {any} */ ({ pipeline })), false);
});
