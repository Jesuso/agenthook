import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// GitHub forge REST calls for CI (pure-unit, fetch stubbed): prHead/prState lookups,
// fenceLog, and the enableAutoMerge/disableAutoMerge GraphQL dance.
import test from "node:test";
import assert from "node:assert/strict";
import { fenceLog } from "../src/forges/github.js";
import { forge, stubFetch } from "./_forge-helpers.js";

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

// --- enableAutoMerge (forge.autoMerge): REST read, GraphQL ready + auto-merge, fetch stubbed ---

/**
 * Stub fetch for enableAutoMerge: `pr` answers GET /pulls/77, `gql` maps a mutation name to its
 * GraphQL reply body, `merge` answers PUT /pulls/77/merge. Records [method, what] per call.
 * @param {{pr: any, gql?: Record<string, any>, merge?: {status: number, json?: any}}} o
 */
function autoMergeFetch({ pr, gql = {}, merge = { status: 200 } }) {
  /** @type {any[]} */
  const calls = [];
  const orig = global.fetch;
  // @ts-ignore - test stub
  global.fetch = async (url, init = {}) => {
    const u = String(url);
    const method = init.method || "GET";
    const reply = (/** @type {number} */ status, /** @type {any} */ json) => ({ ok: status < 300, status, json: async () => json, text: async () => "" });
    if (u.endsWith("/graphql")) {
      const body = JSON.parse(String(init.body));
      const name = Object.keys(gql).find((k) => body.query.includes(k)) ?? "?";
      calls.push(["graphql", name, body.variables]);
      return reply(200, gql[name] ?? { errors: [{ message: `unstubbed ${name}` }] });
    }
    if (method === "PUT" && u.endsWith("/repos/o/r/pulls/77/merge")) {
      calls.push(["PUT merge", JSON.parse(String(init.body))]);
      return reply(merge.status, merge.json ?? {});
    }
    if (method === "GET" && u.endsWith("/repos/o/r/pulls/77")) {
      calls.push(["GET pr"]);
      return reply(200, pr);
    }
    calls.push([method, u]);
    return reply(404, {});
  };
  return { calls, restore: () => (global.fetch = orig) };
}

/** An open agent PR as GET /pulls/:n returns it. @param {any} [over] */
const amPr = (over = {}) => ({ number: 77, node_id: "PR_node", state: "open", draft: false, merged_at: null, auto_merge: null, head: { ref: "agent/123", sha: "abc", repo: { full_name: "o/r" } }, ...over });
const READY = "markPullRequestReadyForReview";
const ENABLE = "enablePullRequestAutoMerge";
const ok = { data: {} };

test("enableAutoMerge: a draft is marked ready BEFORE auto-merge is enabled, with the method upper-cased", async () => {
  const s = autoMergeFetch({ pr: amPr({ draft: true }), gql: { [READY]: ok, [ENABLE]: ok } });
  try {
    assert.deepEqual(await forge().enableAutoMerge?.(77, { method: "squash", expectedSha: "abc" }), { status: "enabled", readied: true });
    assert.deepEqual(s.calls, [["GET pr"], ["graphql", READY, { id: "PR_node" }], ["graphql", ENABLE, { id: "PR_node", method: "SQUASH", sha: "abc" }]]);
  } finally {
    s.restore();
  }
});

test("enableAutoMerge: a ready PR skips the ready mutation", async () => {
  const s = autoMergeFetch({ pr: amPr(), gql: { [ENABLE]: ok } });
  try {
    assert.deepEqual(await forge().enableAutoMerge?.(77, { method: "rebase", expectedSha: "abc" }), { status: "enabled", readied: false });
    assert.deepEqual(s.calls.map((c) => c[1] ?? c[0]), ["GET pr", ENABLE]);
    assert.equal(s.calls[1][2].method, "REBASE");
  } finally {
    s.restore();
  }
});

test("enableAutoMerge: idempotent — already enabled, merged or closed PRs make no write", async () => {
  for (const [over, status] of /** @type {Array<[any, string]>} */ ([
    [{ auto_merge: { merge_method: "squash" } }, "already"],
    [{ state: "closed", merged_at: "2026-01-01T00:00:00Z" }, "merged"],
    [{ state: "closed" }, "closed"],
  ])) {
    const s = autoMergeFetch({ pr: amPr(over) });
    try {
      assert.deepEqual(await forge().enableAutoMerge?.(77, { method: "squash", expectedSha: "abc" }), { status, readied: false });
      assert.deepEqual(s.calls, [["GET pr"]], status);
    } finally {
      s.restore();
    }
  }
  // GitHub answering "already enabled" (a race with another enabler) is the same no-op, not an error.
  const s = autoMergeFetch({ pr: amPr(), gql: { [ENABLE]: { errors: [{ message: "Pull request auto merge is already enabled" }] } } });
  try {
    assert.deepEqual(await forge().enableAutoMerge?.(77, { method: "squash", expectedSha: "abc" }), { status: "already", readied: false });
  } finally {
    s.restore();
  }
});

test("enableAutoMerge: nothing to wait for (clean status) → merges directly at the read head sha", async () => {
  const s = autoMergeFetch({ pr: amPr(), gql: { [ENABLE]: { errors: [{ message: "Pull request Pull request is in clean status" }] } } });
  try {
    assert.deepEqual(await forge().enableAutoMerge?.(77, { method: "squash", expectedSha: "abc" }), { status: "merged_now", readied: false });
    assert.deepEqual(s.calls.at(-1), ["PUT merge", { merge_method: "squash", sha: "abc" }]);
  } finally {
    s.restore();
  }
});

test("enableAutoMerge: a head that moved past the approved sha writes nothing and reports moved", async () => {
  const s = autoMergeFetch({ pr: amPr({ draft: true, head: { ref: "agent/123", sha: "def", repo: { full_name: "o/r" } } }) });
  try {
    assert.deepEqual(await forge().enableAutoMerge?.(77, { method: "squash", expectedSha: "abc" }), { status: "moved", readied: false, headSha: "def" });
    assert.deepEqual(s.calls, [["GET pr"]], "no ready, no enable, no merge");
  } finally {
    s.restore();
  }
});

test("enableAutoMerge: a refusal throws with GitHub's message; a non-agent PR is refused before any write", async () => {
  let s = autoMergeFetch({ pr: amPr(), gql: { [ENABLE]: { errors: [{ message: "Auto merge is not allowed for this repository" }] } } });
  try {
    await assert.rejects(forge().enableAutoMerge?.(77, { method: "squash", expectedSha: "abc" }) ?? Promise.resolve(), /Auto merge is not allowed for this repository/);
  } finally {
    s.restore();
  }
  s = autoMergeFetch({ pr: amPr({ head: { ref: "feature/x", sha: "abc", repo: { full_name: "o/r" } } }) });
  try {
    await assert.rejects(forge().enableAutoMerge?.(77, { method: "squash", expectedSha: "abc" }) ?? Promise.resolve(), /not an agent PR/);
    assert.deepEqual(s.calls, [["GET pr"]]);
  } finally {
    s.restore();
  }
});

const DISABLE = "disablePullRequestAutoMerge";

test("disableAutoMerge: turns it off only when on; merged/closed/off make no write; non-agent PR refused", async () => {
  let s = autoMergeFetch({ pr: amPr({ auto_merge: { merge_method: "squash" } }), gql: { [DISABLE]: ok } });
  try {
    assert.deepEqual(await forge().disableAutoMerge?.(77), { status: "disabled" });
    assert.deepEqual(s.calls, [["GET pr"], ["graphql", DISABLE, { id: "PR_node" }]]);
  } finally {
    s.restore();
  }
  for (const [over, status] of /** @type {Array<[any, string]>} */ ([
    [{}, "off"],
    [{ state: "closed", merged_at: "2026-01-01T00:00:00Z", auto_merge: { merge_method: "squash" } }, "merged"],
    [{ state: "closed" }, "closed"],
  ])) {
    s = autoMergeFetch({ pr: amPr(over) });
    try {
      assert.deepEqual(await forge().disableAutoMerge?.(77), { status }, status);
      assert.deepEqual(s.calls, [["GET pr"]], status);
    } finally {
      s.restore();
    }
  }
  s = autoMergeFetch({ pr: amPr({ auto_merge: {}, head: { ref: "feature/x", sha: "abc", repo: { full_name: "o/r" } } }) });
  try {
    await assert.rejects(forge().disableAutoMerge?.(77) ?? Promise.resolve(), /not an agent PR/);
    assert.deepEqual(s.calls, [["GET pr"]]);
  } finally {
    s.restore();
  }
});

test("prState by number: merged_at → merged, closed → closed, else open (any branch); non-2xx throws", async () => {
  for (const [over, want] of /** @type {[any, string][]} */ ([
    [{ state: "closed", merged_at: "2026-10-15T00:00:00Z" }, "merged"],
    [{ state: "closed", merged_at: null }, "closed"],
    [{ state: "open", head: { ref: "feature/x", sha: "s", repo: { full_name: "o/r" } } }, "open"],
  ])) {
    const s = stubFetch({ "GET /repos/o/r/pulls/77": { json: prJson(over) } });
    try {
      assert.equal(await forge().prState(77), want);
    } finally {
      s.restore();
    }
  }
  const s = stubFetch({ "GET /pulls/77": { status: 404, json: {} } });
  try {
    await assert.rejects(forge().prState(77), /404/);
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
