import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// Egress (#473), through the real container sandbox and dispatcher: the default allowlist, the
// hosts a step/profile/forge/origin each contribute to wrap()'s rules, and denials reported by
// done(). Shares its fake-docker client and harness with dispatch-sandbox-runtime.test.js via
// _dispatch-sandbox-helpers.js.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { inferredForgeEgressHosts } from "../src/dispatch/sandbox.js";
import { createDispatcher } from "../src/dispatch.js";
import { createSandbox } from "../src/sandbox/index.js";
import { g, sandboxHarness } from "./_dispatch-sandbox-helpers.js";

test("sandbox e2e: the default allowlist puts the run on its internal network behind the proxy, with the tracker, forge and origin hosts", async () => {
  const forge = { describe: () => ({ name: "github", egressHosts: ["github.com", "api.github.com"] }) };
  const h = sandboxHarness([{ id: "code", env: { CLAUDE_CODE_OAUTH_TOKEN: "tok" } }, { id: "done", manual: true }], { forge });
  g(h.repo, ["remote", "add", "origin", "https://git.origin.test:4443/o/r.git"]);
  try {
    await h.go("code");
    assert.equal(h.advanced[0]?.outcome, "advance");
    const calls = h.calls();
    const net = calls.find((c) => c[0] === "network" && c[1] === "create");
    assert.ok(net?.includes("--internal"), JSON.stringify(calls.map((c) => c.slice(0, 2))));
    const agentRun = calls.find((c) => c[0] === "run" && c[1] !== "-d");
    assert.equal(agentRun[agentRun.indexOf("--network") + 1], net.at(-1));
    // allow.json is gone with the run's egress dir; the proxy's argv names the dir, the rules went in first.
    const proxy = calls.find((c) => c[0] === "run" && c[1] === "-d");
    assert.ok(proxy, "the proxy was started");
    assert.ok(calls.some((c) => c[0] === "rm" && c[1] === "-f" && c[2] === `${agentRun[agentRun.indexOf("--name") + 1]}-proxy`), "done() removed the proxy");
    assert.ok(calls.some((c) => c[0] === "network" && c[1] === "rm"), "done() removed the network");
    assert.deepEqual(fs.readdirSync(path.join(h.state, "egress")), [], "per-run egress dir removed");
    const end = h.events.find((e) => e.event === "run_end");
    assert.equal(end?.data.outcome, "advance");
    assert.equal(end?.data.egressDenied, undefined, "no denials, no field");
  } finally {
    h.restore();
  }
});

test("sandbox e2e: wrap() receives egress.rules with the model API, tracker, forge and origin hosts", async () => {
  const forge = { describe: () => ({ name: "github", egressHosts: ["github.com", "api.github.com"] }) };
  const h = sandboxHarness([{ id: "code", env: { CLAUDE_CODE_OAUTH_TOKEN: "tok" }, egress: { allow: ["@npm"] } }, { id: "done", manual: true }], { forge, sandbox: { type: "docker", image: "img:1", egress: { deny: ["api.github.com"] } } });
  g(h.repo, ["remote", "add", "origin", "https://git.origin.test:4443/o/r.git"]);
  /** @type {any[]} */
  const wraps = [];
  const sb = /** @type {any} */ (createSandbox(h.cfg));
  const wrap = sb.wrap.bind(sb);
  sb.wrap = (/** @type {any} */ o) => (wraps.push(o), wrap(o));
  const run = createDispatcher(h.cfg, /** @type {any} */ ({ describe: () => ({ platform: "GitHub", taskNoun: "issue", trigger: "@agent", commentHowTo: "c", egressHosts: ["api.tracker.test"] }), fetchTask: async (/** @type {string} */ ref) => ({ ref, name: "t", description: "d", url: "u", assignedToUs: true }), advance: async () => {} }), undefined, h.store, () => {}, /** @type {any} */ (forge), undefined, { killGraceMs: 200, sandbox: sb });
  const l = console.log;
  console.log = () => {};
  try {
    await run({ kind: "pipeline", ref: "42", stepId: "code", dedupKey: "k" });
  } finally {
    console.log = l;
    h.restore();
  }
  assert.equal(wraps.length, 1);
  assert.deepEqual(wraps[0].egress, { mode: "allowlist", rules: ["api.anthropic.com", "api.tracker.test", "github.com", "git.origin.test:4443", "registry.npmjs.org"] }, "profile deny drops api.github.com; the step's allow adds @npm");
});

test("inferredForgeEgressHosts: a profile with no forge block gets the forge hosts its origin implies", () => {
  assert.deepEqual(inferredForgeEgressHosts("git@github.com:o/r.git"), ["github.com", "api.github.com", "uploads.github.com", "*.githubusercontent.com"]);
  assert.deepEqual(inferredForgeEgressHosts("https://github.com/o/r"), inferredForgeEgressHosts("git@github.com:o/r.git"));
  assert.deepEqual(inferredForgeEgressHosts("git@gitlab.acme.io:g/p.git"), ["gitlab.acme.io"]);
  assert.deepEqual(inferredForgeEgressHosts("https://git.acme.io/o/r.git"), [], "an unknown forge contributes nothing (the origin rule still covers the push)");
  assert.deepEqual(inferredForgeEgressHosts(undefined), []);
});

test("sandbox e2e: no forge block + a github origin → wrap() still allows api.github.com, so gh pr … works", async () => {
  const h = sandboxHarness([{ id: "code", env: { CLAUDE_CODE_OAUTH_TOKEN: "tok" } }, { id: "done", manual: true }]);
  g(h.repo, ["remote", "add", "origin", "git@github.com:o/r.git"]);
  /** @type {any[]} */
  const wraps = [];
  const sb = /** @type {any} */ (createSandbox(h.cfg));
  const wrap = sb.wrap.bind(sb);
  sb.wrap = (/** @type {any} */ o) => (wraps.push(o), wrap(o));
  const asana = /** @type {any} */ ({ describe: () => ({ platform: "Asana", taskNoun: "task", trigger: "@agent", commentHowTo: "c", egressHosts: ["app.asana.com"] }), fetchTask: async (/** @type {string} */ ref) => ({ ref, name: "t", description: "d", url: "u", assignedToUs: true }), advance: async () => {} });
  const run = createDispatcher(h.cfg, asana, undefined, h.store, () => {}, null, undefined, { killGraceMs: 200, sandbox: sb });
  const l = console.log;
  console.log = () => {};
  try {
    await run({ kind: "pipeline", ref: "42", stepId: "code", dedupKey: "k" });
  } finally {
    console.log = l;
    h.restore();
  }
  assert.equal(wraps.length, 1);
  assert.deepEqual(wraps[0].egress.rules, ["api.anthropic.com", "app.asana.com", "github.com", "api.github.com", "uploads.github.com", "*.githubusercontent.com"]);
});

test("sandbox e2e: a denial reported by done() lands in the run log and on run_end; the outcome is unchanged", async () => {
  const h = sandboxHarness([{ id: "code", env: { CLAUDE_CODE_OAUTH_TOKEN: "tok" } }, { id: "done", manual: true }]);
  process.env.DOCKER_FAKE_DENY = [{ host: "example.com", port: 443 }, { host: "example.com", port: 443 }, { host: "169.254.169.254", port: 80 }].map((d) => JSON.stringify(d)).join("\n") + "\n";
  try {
    await h.go("code");
    assert.equal(h.advanced[0]?.outcome, "advance", "denials never change the outcome");
    const end = h.events.find((e) => e.event === "run_end");
    assert.equal(end?.data.outcome, "advance");
    assert.deepEqual(end?.data.egressDenied, ["example.com:443", "169.254.169.254:80"]);
    const log = fs.readdirSync(h.state).filter((f) => f.endsWith(".log")).map((f) => fs.readFileSync(path.join(h.state, f), "utf8")).join("\n");
    assert.match(log, /\[agenthook\] egress denied: example\.com:443 \(2×\) — add it to sandbox\.egress\.allow/);
    assert.match(log, /\[agenthook\] egress denied: 169\.254\.169\.254:80 \(1×\)/);
  } finally {
    h.restore();
  }
});

test("sandbox e2e: egress mode none runs with --network none and starts no proxy", async () => {
  const h = sandboxHarness([{ id: "code", env: { CLAUDE_CODE_OAUTH_TOKEN: "tok" }, egress: { mode: "none" } }, { id: "done", manual: true }]);
  try {
    await h.go("code");
    assert.equal(h.advanced[0]?.outcome, "advance");
    const calls = h.calls();
    assert.deepEqual(calls.map((c) => c[0]), ["run"], "no network, no proxy");
    assert.equal(calls[0][calls[0].indexOf("--network") + 1], "none");
  } finally {
    h.restore();
  }
});
