// GitHub forge — pure-unit coverage (no network): the shared x-hub-signature-256
// verifier, branch → ref mapping, authenticate reject/accept, merged-PR + red-CI routing
// in processEvents, the `/forge`-only hook scrub, and the red-CI REST calls.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { verifyHubSignature } from "../src/hmac.js";
import { createGithubForge, refFromBranch, isForgePath, fenceLog } from "../src/forges/github.js";
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

// --- processEvents: red CI (workflow_run) ---

/** @param {any} [run] @param {string} [action] */
const redRun = (run = {}, action = "completed") => ({
  action,
  workflow_run: {
    id: 555,
    run_attempt: 1,
    conclusion: "failure",
    head_branch: "agent/123",
    head_sha: "abc1234def",
    html_url: "https://github.com/o/r/actions/runs/555",
    head_repository: { full_name: "o/r" },
    pull_requests: [{ number: 77 }],
    ...run,
  },
});

test("red workflow_run on agent/<ref> from this repo → one ci job keyed ci:<run>:<attempt>", async () => {
  const jobs = await forge().processEvents(ctx(redRun(), "workflow_run"));
  assert.deepEqual(jobs, [
    {
      kind: "ci",
      ref: "123",
      stepId: "",
      dedupKey: "ci:555:1",
      ci: { runId: 555, attempt: 1, headSha: "abc1234def", prNumber: 77, url: "https://github.com/o/r/actions/runs/555" },
    },
  ]);
});

test("timed_out counts as red; attempt 2 keys apart; no pull_requests → prNumber null", async () => {
  const [j] = await forge().processEvents(ctx(redRun({ conclusion: "timed_out", run_attempt: 2, pull_requests: [] }), "workflow_run"));
  assert.equal(j.dedupKey, "ci:555:2");
  assert.equal(j.ci.attempt, 2);
  assert.equal(j.ci.prNumber, null);
});

test("green/cancelled/in-progress, non-agent branch, fork, redCi:false → no ci job", async () => {
  const f = forge();
  const none = async (/** @type {any} */ p, g = f) => assert.deepEqual(await g.processEvents(ctx(p, "workflow_run")), []);
  await none(redRun({ conclusion: "success" }));
  await none(redRun({ conclusion: "cancelled" }));
  await none(redRun({ conclusion: null }, "in_progress"));
  await none(redRun({}, "requested"));
  await none(redRun({ head_branch: "feature/x" }));
  await none(redRun({ head_repository: { full_name: "evil/r" } }));
  await none(redRun({ head_repository: null }));
  await none(redRun(), forge({ redCi: false }));
});

// --- red-CI REST calls (fetch stubbed) ---

/**
 * Stub global.fetch with a route table: `"METHOD path-suffix" → response`. Records calls.
 * @param {Record<string, any>} routes
 */
function stubFetch(routes) {
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
    if (!hit) return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
    const r = hit[1];
    return { ok: (r.status ?? 200) < 300, status: r.status ?? 200, json: async () => r.json, text: async () => r.text ?? "" };
  };
  return { calls, restore: () => (global.fetch = orig) };
}

const prJson = (over = {}) => ({ number: 77, state: "open", head: { ref: "agent/123", sha: "abc1234def", repo: { full_name: "o/r" } }, ...over });

test("prHead by number → {number, sha, open}; by ref lists the open agent-branch PR", async () => {
  let s = stubFetch({ "GET /repos/o/r/pulls/77": { json: prJson() } });
  try {
    assert.deepEqual(await forge().prHead(77, "123"), { number: 77, sha: "abc1234def", open: true });
  } finally {
    s.restore();
  }
  s = stubFetch({ "GET &state=open": { json: [prJson({ state: "open" })] } });
  try {
    assert.deepEqual(await forge().prHead(null, "123"), { number: 77, sha: "abc1234def", open: true });
    assert.ok(s.calls[0].url.includes(`head=${encodeURIComponent("o:agent/123")}`));
  } finally {
    s.restore();
  }
});

test("prHead: closed PR reports open:false; a fork/other-branch head → null; non-2xx throws", async () => {
  let s = stubFetch({ "GET /pulls/77": { json: prJson({ state: "closed" }) } });
  try {
    assert.equal((await forge().prHead(77, "123"))?.open, false);
  } finally {
    s.restore();
  }
  s = stubFetch({ "GET /pulls/77": { json: prJson({ head: { ref: "agent/123", sha: "x", repo: { full_name: "evil/r" } } }) } });
  try {
    assert.equal(await forge().prHead(77, "123"), null);
    assert.equal(await forge().prHead(77, "999"), null, "PR head is not agent/999");
  } finally {
    s.restore();
  }
  s = stubFetch({ "GET &state=open": { json: [] } });
  try {
    assert.equal(await forge().prHead(null, "123"), null);
  } finally {
    s.restore();
  }
  s = stubFetch({ "GET /pulls/77": { status: 500, json: {} } });
  try {
    await assert.rejects(forge().prHead(77, "123"), /500/);
  } finally {
    s.restore();
  }
});

test("rerunFailedJobs POSTs rerun-failed-jobs; throws on non-2xx", async () => {
  let s = stubFetch({ "POST /actions/runs/555/rerun-failed-jobs": { status: 201, json: {} } });
  try {
    await forge().rerunFailedJobs(555);
    assert.deepEqual(s.calls.map((c) => `${c.method} ${c.url}`), ["POST https://api.github.com/repos/o/r/actions/runs/555/rerun-failed-jobs"]);
  } finally {
    s.restore();
  }
  s = stubFetch({ "POST /rerun-failed-jobs": { status: 403, json: {} } });
  try {
    await assert.rejects(forge().rerunFailedJobs(555), /403/);
  } finally {
    s.restore();
  }
});

test("failedLogTail: last 60 lines of each FAILED job of that attempt, capped; errors → \"\"", async () => {
  const long = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n") + "\n";
  const s = stubFetch({
    "GET /actions/runs/555/attempts/2/jobs?per_page=100": {
      json: { jobs: [{ id: 1, name: "test", conclusion: "failure" }, { id: 2, name: "lint", conclusion: "success" }] },
    },
    "GET /actions/jobs/1/logs": { text: long },
  });
  try {
    const out = await forge().failedLogTail(555, 2);
    assert.ok(out.includes("line 99") && out.includes("line 40"));
    assert.ok(!out.includes("line 39\n"), "only the last 60 lines");
    assert.ok(!s.calls.some((c) => c.url.includes("/jobs/2/")), "green jobs are skipped");
  } finally {
    s.restore();
  }
  const capped = stubFetch({
    "GET /jobs?per_page=100": { json: { jobs: [1, 2, 3].map((id) => ({ id, name: `j${id}`, conclusion: "failure" })) } },
    "GET /logs": { text: "x".repeat(5000) },
  });
  try {
    assert.ok((await forge().failedLogTail(555, 1)).length <= 6002);
  } finally {
    capped.restore();
  }
  const err = stubFetch({});
  try {
    assert.equal(await forge().failedLogTail(555, 1), "");
  } finally {
    err.restore();
  }
});

test("prComment posts the trusted body + the log inside a ~ fence; throws on non-2xx", async () => {
  let s = stubFetch({ "POST /repos/o/r/issues/77/comments": { status: 201, json: {} } });
  try {
    await forge().prComment(77, "CI is red.", "boom\n```\nnot a fence break");
    const body = s.calls[0].body.body;
    assert.ok(body.startsWith("CI is red.\n\n~~~\n"));
    assert.ok(body.endsWith("not a fence break\n~~~"));
  } finally {
    s.restore();
  }
  s = stubFetch({});
  try {
    await assert.rejects(forge().prComment(77, "x", ""), /404/);
  } finally {
    s.restore();
  }
});

test("fenceLog outgrows any ~ run inside the log", () => {
  assert.equal(fenceLog("a\n"), "~~~\na\n~~~");
  assert.equal(fenceLog("x\n~~~~\ny"), "~~~~~\nx\n~~~~\ny\n~~~~~");
});

// --- hooks ---

test("registerWebhook deletes only /forge hooks, then creates a pull_request+workflow_run hook at <url>/forge", async () => {
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
  assert.deepEqual(created.events, ["pull_request", "workflow_run"]);
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
  assert.ok(warnings.some((w) => w.includes("https://new.example/forge") && w.includes("Pull requests") && w.includes("Workflow runs")));
});

// --- registry ---

test("createForge: null without a forge block; throws on an unknown type", () => {
  assert.equal(createForge(/** @type {any} */ ({ pipeline }), /** @type {any} */ (makeStore())), null);
  assert.throws(() => createForge(/** @type {any} */ ({ pipeline, forge: { type: "gitlab" } }), /** @type {any} */ (makeStore())), /unknown forge "gitlab"/);
});
