import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// Doctor's remote-harness TRUST lints (src/commands/doctor.js, #829): pure, no ssh probes, no
// network — the worker executes ticket text with its own model credentials, and the fail-closed
// assignee scope is the only gate on a public tracker.
import test from "node:test";
import assert from "node:assert/strict";
import { remoteTrustLints } from "../src/commands/doctor.js";

/** @param {object} [o] a full config-ish object with the lint's four fields */
function cfg(o = {}) {
  return {
    provider: "github",
    providerConfig: { token: "$GITHUB_TOKEN", assigneeLogin: "octo" },
    harnesses: { worker: { remote: { host: "w1", workDir: "/w" } } },
    pipeline: [{ id: "code", harness: "worker" }],
    ...o,
  };
}

test("no remote harness, or the local tracker → []", () => {
  assert.deepEqual(remoteTrustLints(cfg({ provider: "local" })), []);
  assert.deepEqual(remoteTrustLints(cfg({ harnesses: { local: {} } })), []);
  assert.deepEqual(remoteTrustLints(cfg({ harnesses: undefined })), []);
});

test("assignee filter OFF + remote harness → a FAIL finding", () => {
  const out = remoteTrustLints(cfg({ providerConfig: { token: "$T", assigneeLogin: "octo", assigneeFilter: false } }));
  const fail = out.find((f) => f.level === "fail");
  assert.ok(fail, JSON.stringify(out));
  assert.match(fail.label, /assignee filter is OFF/);
  assert.match(fail.note, /worker/);
});

test("App auth with no assigneeLogin → a FAIL finding (no identity resolvable from the config)", () => {
  const out = remoteTrustLints(cfg({ providerConfig: { auth: { type: "app", appId: 1, pem: "x" } } }));
  const fail = out.find((f) => f.level === "fail");
  assert.ok(fail, JSON.stringify(out));
  assert.match(fail.label, /no assignee identity/);
  assert.match(fail.fix?.manual ?? "", /assigneeLogin/);
});

test("default scope with a known identity → one warn naming the harness and the gate; a remote-only step adds a per-step warn", () => {
  const out = remoteTrustLints(cfg());
  assert.equal(out.filter((f) => f.level === "warn").length, 2, JSON.stringify(out));
  assert.equal(out.filter((f) => f.level === "fail").length, 0);
  const harness = out[0];
  assert.match(harness.label, /remote harness "worker"/);
  assert.match(harness.note, /"octo"/, "the assignee scope on that login is the only gate");
  const step = out[1];
  assert.match(step.label, /step "code" runs only on remote harness "worker"/);
});

test("no assigneeLogin configured → the warn names the token's own login (looked up at runtime)", () => {
  const out = remoteTrustLints(cfg({ providerConfig: { token: "$T" } }));
  const warn = out.find((f) => f.level === "warn" && f.label.includes('remote harness "worker"'));
  assert.ok(warn, JSON.stringify(out));
  assert.match(warn.note, /the tracker token's own login \(looked up at runtime\)/, "the identity is the token's own account, resolved at runtime");
  assert.ok(!out.some((f) => f.level === "fail"), "token auth with a resolvable identity is a warn, not a fail");
});

test("the per-step warn names only THAT step's ssh user(s)", () => {
  const out = remoteTrustLints(
    cfg({
      harnesses: {
        gpu: { remote: { host: "gpu1", user: "cuda", workDir: "/g" } },
        cpu: { remote: { host: "cpu1", workDir: "/c" } },
      },
      pipeline: [{ id: "train", harness: ["gpu"] }, { id: "bake", harness: ["cpu"] }],
    }),
  );
  const train = out.find((f) => f.label.includes('step "train"'));
  assert.ok(train, JSON.stringify(out));
  assert.match(train.note, /cuda/, "the gpu harness's configured ssh user");
  assert.doesNotMatch(train.note, /cpu1/, "the cpu harness is NOT in this step's list — its user is not named");
  const bake = out.find((f) => f.label.includes('step "bake"'));
  assert.ok(bake, JSON.stringify(out));
  assert.match(bake.note, /the ssh default user for cpu1/, "the cpu harness has no configured user — the ssh default is named");
  assert.doesNotMatch(bake.note, /cuda/);
});

test("a step with a non-remote fallback is NOT flagged, and its user is named in the remote-only note", () => {
  const out = remoteTrustLints(
    cfg({
      harnesses: { worker: { remote: { host: "w1", user: "deploy", workDir: "/w" } }, local: {} },
      pipeline: [{ id: "code", harness: ["worker", "local"] }, { id: "ship", harness: "worker" }],
    }),
  );
  assert.ok(!out.some((f) => f.label.includes('step "code"')), "a non-remote fallback is not remote-only");
  assert.match(out.find((f) => f.label.includes('step "ship"'))?.label ?? "", /runs only on remote harness "worker"/);
  assert.match(out.find((f) => f.label.includes('step "ship"'))?.note ?? "", /deploy/);
});

test("manual steps are ignored", () => {
  const out = remoteTrustLints(cfg({ pipeline: [{ id: "done", manual: true, harness: "worker" }] }));
  assert.ok(!out.some((f) => f.label.includes('step "done"')));
  assert.equal(out.length, 1, "only the harness-level warn remains");
});
