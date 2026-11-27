import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// `fetchComments` — the adapter-side half of a remote (ssh) run's prompt (#826, epic #681):
// the ticket's newest 100 comments, oldest→newest, each entry owner-flagged by the adapter
// ITSELF using the same strict rule as the `@agent` resume gate (unresolvable identity fails
// closed), plus `omitted` — how many OLDER comments were left out (#829). The github tracker
// is REST (Link-header `rel="last"`; a SHORT last page also pulls the page before it so the
// newest-100 window has no gap); github-projects is a single GraphQL `comments(last:100)`
// whose `totalCount` yields the omission count.
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
      out.comments.map((c) => [c.author, c.body, c.owner]),
      [
        ["alice", "c1", false],
        ["octo", "c2", true], // exact match on assigneeLogin → owner
        ["alice", "c3", false],
      ],
    );
    assert.equal(out.comments[0].createdAt, "2025-01-01");
    assert.equal(out.omitted, undefined, "a ≤100 thread omits nothing — the key is absent");
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
    assert.deepEqual(out.comments, [{ author: "alice", body: "hi", createdAt: "t", owner: false }], "unresolvable identity fails closed");
  } finally {
    stub.restore();
  }
});

test("github fetchComments: a SHORT last page pulls the page before it — the newest-100 window has no gap, and `omitted` counts the rest (#829)", async () => {
  const a = ghAdapter({ assigneeLogin: "octo" });
  const all = mkComments(120); // 100 on page 1 (oldest) + 20 on page 2 (newest)
  const stub = stubFetch({
    "GET /repos/o/r/issues/7/comments?per_page=100": {
      json: all.slice(0, 100),
      headers: { link: `<https://api.github.com/repos/o/r/issues/7/comments?per_page=100&page=2>; rel="last"` },
    },
    "GET /repos/o/r/issues/7/comments?per_page=100&page=2": { json: all.slice(100) }, // c101..c120
    "GET /repos/o/r/issues/7/comments?per_page=100&page=1": { json: all.slice(0, 100) }, // c1..c100
  });
  try {
    const out = await a.fetchComments("7");
    assert.equal(out.comments.length, 100, "the newest 100 — not just the short last page");
    assert.equal(out.comments[0].body, "c21", "the window starts 80 into the previous page");
    assert.equal(out.comments[99].body, "c120");
    assert.equal(out.omitted, 20, "120 total − 100 windowed = 20 older comments omitted");
    const commentCalls = stub.calls.filter((c) => c.url.includes("/comments"));
    assert.equal(commentCalls.length, 3, "page 1, the last page, and the page before it");
  } finally {
    stub.restore();
  }
});

test("github fetchComments: a FULL last page needs no earlier fetch — `omitted` is the exact count ((lastPage−1)·100)", async () => {
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
    assert.equal(out.comments.length, 100);
    assert.equal(out.comments[0].body, "c101");
    assert.equal(out.comments[99].body, "c200");
    assert.equal(out.omitted, 100, "a full last page ⇒ total is exactly lastPage·100");
    assert.equal(stub.calls.filter((c) => c.url.includes("/comments")).length, 2, "no fetch of an earlier page");
  } finally {
    stub.restore();
  }
});

test("github fetchComments: more than 200 comments — omitted spans pages, window is still the newest 100", async () => {
  const a = ghAdapter({ assigneeLogin: "octo" });
  const all = mkComments(250); // 100/100/50
  const stub = stubFetch({
    "GET /repos/o/r/issues/9/comments?per_page=100": {
      json: all.slice(0, 100),
      headers: { link: `<https://api.github.com/repos/o/r/issues/9/comments?per_page=100&page=3>; rel="last"` },
    },
    "GET /repos/o/r/issues/9/comments?per_page=100&page=3": { json: all.slice(200) }, // c201..c250
    "GET /repos/o/r/issues/9/comments?per_page=100&page=2": { json: all.slice(100, 200) }, // c101..c200
  });
  try {
    const out = await a.fetchComments("9");
    assert.equal(out.comments.length, 100);
    assert.equal(out.comments[0].body, "c151");
    assert.equal(out.comments[99].body, "c250");
    assert.equal(out.omitted, 150, "(3−1)·100 + 50 − 100");
  } finally {
    stub.restore();
  }
});

test("github fetchComments: no Link header (≤100 comments) → a single request, no omitted", async () => {
  const a = ghAdapter({ assigneeLogin: "octo" });
  const stub = stubFetch({ "GET /repos/o/r/issues/7/comments?per_page=100": { json: mkComments(42) } });
  try {
    const out = await a.fetchComments("7");
    assert.equal(out.comments.length, 42);
    assert.equal(out.omitted, undefined);
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
      out.comments.map((c) => [c.author, c.body, c.owner]),
      [
        ["bot", "mine", true], // viewer is "bot" → owner
        ["alice", "theirs", false],
        [null, "orphan", false], // null author can't be ours
      ],
    );
    assert.equal(out.omitted, undefined, "no totalCount in the stub → no count reported");
  } finally {
    stub.restore();
  }
});

test("github-projects fetchComments: totalCount beyond the 100-cap becomes `omitted` (#829)", async () => {
  const a = gpxAdapter();
  const stub = stubGraphql({ comments: [{ author: { login: "alice" }, body: "hi", createdAt: "t" }], commentsTotal: 101 });
  try {
    const out = await a.fetchComments("42");
    assert.equal(out.comments.length, 1);
    assert.equal(out.omitted, 100, "101 total − 1 windowed");
  } finally {
    stub.restore();
  }
});

test("github-projects fetchComments: unresolvable identity (viewer login comes back empty) is owner:false", async () => {
  const a = gpxAdapter();
  const stub = stubGraphql({ viewer: null, comments: [{ author: { login: "alice" }, body: "hi", createdAt: "t" }] });
  try {
    const out = await a.fetchComments("42");
    assert.deepEqual(out.comments, [{ author: "alice", body: "hi", createdAt: "t", owner: false }], "fails closed");
  } finally {
    stub.restore();
  }
});
