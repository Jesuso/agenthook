import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// `fetchComments` — the adapter-side half of a remote (ssh) run's prompt (#826, epic #681):
// the ticket's thread, oldest→newest, each entry owner-flagged by the adapter ITSELF using
// the same strict rule as the `@agent` resume gate (unresolvable identity fails closed).
// The github tracker is REST (Link-header `rel="last"` for one extra page); github-projects
// is a single GraphQL `comments(last:100)` on the issue node.
import test from "node:test";
import assert from "node:assert/strict";
import { adapter as ghAdapter } from "./_github-helpers.js";
import { stubFetch } from "./_forge-helpers.js";
import { adapter as gpxAdapter, stubGraphql } from "./_github-projects-helpers.js";

/** @param {number} n */
const mkComments = (n, start = 1) =>
  Array.from({ length: n }, (_, i) => ({
    user: { login: i % 2 === 0 ? "alice" : "octo" },
    body: `c${start + i}`,
    created_at: `2025-01-${String(start + i).padStart(2, "0")}`,
  }));

// --- github tracker (REST) ---

test("github fetchComments: shape is oldest→newest with author/body/createdAt/owner, identity is strict", async () => {
  const a = ghAdapter({ assigneeLogin: "octo" });
  const stub = stubFetch({ "GET /repos/o/r/issues/7/comments?per_page=100": { json: mkComments(3) } });
  try {
    const out = await a.fetchComments("7");
    assert.deepEqual(
      out.map((c) => [c.author, c.body, c.owner]),
      [
        ["alice", "c1", false],
        ["octo", "c2", true], // exact match on assigneeLogin → owner
        ["alice", "c3", false],
      ],
    );
    assert.deepEqual(out[0].createdAt, "2025-01-01");
  } finally {
    stub.restore();
  }
});

test("github fetchComments: an author we can't resolve (identity fetch fails) is owner:false, not an error", async () => {
  const a = ghAdapter(); // no assigneeLogin → identity comes from /user
  const stub = stubFetch({
    "GET /repos/o/r/issues/7/comments?per_page=100": { json: [{ user: { login: "alice" }, body: "hi", created_at: "t" }] },
    "GET /user": { status: 403, json: { message: "no /user for App tokens" } },
  });
  try {
    const out = await a.fetchComments("7");
    assert.deepEqual(out, [{ author: "alice", body: "hi", createdAt: "t", owner: false }], "unresolvable identity fails closed");
  } finally {
    stub.restore();
  }
});

test("github fetchComments: more than 100 comments → exactly one extra request, for the LAST page only (the newest page of the thread)", async () => {
  const a = ghAdapter({ assigneeLogin: "octo" });
  const all = mkComments(120); // 100 on page 1 (oldest) + 20 on page 3 (newest)
  const stub = stubFetch({
    "GET /repos/o/r/issues/7/comments?per_page=100": {
      json: all.slice(0, 100),
      headers: { link: `<https://api.github.com/repos/o/r/issues/7/comments?per_page=100&page=3>; rel="last"` },
    },
    "GET /repos/o/r/issues/7/comments?per_page=100&page=3": { json: all.slice(100) },
  });
  try {
    const out = await a.fetchComments("7");
    assert.equal(out.length, 20, "the last page's contents — the newest page, never a middle-page gap")
    assert.deepEqual(out.map((c) => c.body), all.slice(100).map((c) => c.body), "newest page, oldest→newest within the page");
    const commentCalls = stub.calls.filter((c) => c.url.includes("/comments"));
    assert.equal(commentCalls.length, 2, "exactly one extra request, for the last page");
    assert.ok(commentCalls[1].url.endsWith("&page=3"));
  } finally {
    stub.restore();
  }
});

test("github fetchComments: the last page is capped to 100 newest (a 100-item last page survives intact)", async () => {
  const a = ghAdapter({ assigneeLogin: "octo" });
  const page1 = mkComments(100, 1); // c1..c100 (oldest)
  const pageLast = mkComments(100, 101); // c101..c200 (newest 100)
  const stub = stubFetch({
    "GET /repos/o/r/issues/9/comments?per_page=100": {
      json: page1,
      headers: { link: `<https://api.github.com/repos/o/r/issues/9/comments?per_page=100&page=2>; rel="last"` },
    },
    "GET /repos/o/r/issues/9/comments?per_page=100&page=2": { json: pageLast },
  });
  try {
    const out = await a.fetchComments("9");
    assert.equal(out.length, 100);
    assert.equal(out[0].body, "c101");
    assert.equal(out[99].body, "c200");
  } finally {
    stub.restore();
  }
});

test("github fetchComments: no Link header (≤100 comments) → a single request", async () => {
  const a = ghAdapter({ assigneeLogin: "octo" });
  const stub = stubFetch({ "GET /repos/o/r/issues/7/comments?per_page=100": { json: mkComments(42) } });
  try {
    const out = await a.fetchComments("7");
    assert.equal(out.length, 42);
    assert.equal(stub.calls.length, 1);
  } finally {
    stub.restore();
  }
});

test("github fetchComments: a non-2xx list fails with the status (the caller downgrades to a prompt notice)", async () => {
  const a = ghAdapter({ assigneeLogin: "octo" });
  const stub = stubFetch({ "GET /repos/o/r/issues/7/comments?per_page=100": { status: 403, json: { message: "forbidden" } } });
  try {
    await assert.rejects(a.fetchComments("7"), /list comments 403/);
  } finally {
    stub.restore();
  }
});

// --- github-projects tracker (GraphQL) ---

test("github-projects fetchComments: shape is oldest→newest, subjectId is the card's issue node id, owner via viewer", async () => {
  const a = gpxAdapter();
  const stub = stubGraphql({
    comments: [
      { author: { login: "bot" }, body: "mine", createdAt: "t1" },
      { author: { login: "alice" }, body: "theirs", createdAt: "t2" },
      { author: null, body: "orphan", createdAt: "t3" },
    ],
  });
  try {
    const out = await a.fetchComments("42");
    assert.deepEqual(
      out.map((c) => [c.author, c.body, c.owner]),
      [
        ["bot", "mine", true], // viewer is "bot" → owner
        ["alice", "theirs", false],
        [null, "orphan", false], // null author can't be ours
      ],
    );
  } finally {
    stub.restore();
  }
});

test("github-projects fetchComments: unresolvable identity (viewer login comes back empty) is owner:false", async () => {
  const a = gpxAdapter();
  const stub = stubGraphql({ viewer: null, comments: [{ author: { login: "alice" }, body: "hi", createdAt: "t" }] });
  try {
    const out = await a.fetchComments("42");
    assert.deepEqual(out, [{ author: "alice", body: "hi", createdAt: "t", owner: false }], "fails closed");
  } finally {
    stub.restore();
  }
});
