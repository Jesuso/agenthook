import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// The `postComment` tracker methods the outbox publisher (#825, #681 phase 5a) calls to post
// a REMOTE worker's comment with the hub's own credentials: the github tracker (REST) and the
// github-projects tracker (GraphQL addComment — the card's issue node id when the item is on
// the board, else the loose issue's node id via tracker.repository).
import test from "node:test";
import assert from "node:assert/strict";
import { adapter as ghAdapter } from "./_github-helpers.js";
import { stubFetch } from "./_forge-helpers.js";
import { adapter as gpxAdapter, stubGraphql } from "./_github-projects-helpers.js";

// --- github tracker (REST) ---

test("github postComment posts the body to the issue's comments endpoint and returns the id", async () => {
  const a = ghAdapter();
  const stub = stubFetch({ "POST /repos/o/r/issues/77/comments": { json: { id: 9001 } } });
  try {
    const id = await a.postComment("77", "All green — see the PR.");
    assert.equal(id, 9001);
    const call = stub.calls.find((c) => c.method === "POST" && c.url.endsWith("/repos/o/r/issues/77/comments"));
    assert.ok(call, "a POST to the issue's comments endpoint was made");
    assert.deepEqual(call.body, { body: "All green — see the PR." });
  } finally {
    stub.restore();
  }
});

test("github postComment throws with the status and the API's message on a non-2xx", async () => {
  const a = ghAdapter();
  const stub = stubFetch({ "POST /repos/o/r/issues/77/comments": { status: 403, json: { message: "Resource not accessible by integration" } } });
  try {
    await assert.rejects(a.postComment("77", "hi"), /403.*Resource not accessible by integration/);
  } finally {
    stub.restore();
  }
});

// --- github-projects tracker (GraphQL addComment) ---

/** Wrap the stubbed graphql fetch to capture the addComment variables and answer them. */
function captureAddComment(stub, { dbId = 9001, errors = null } = {}) {
  const inner = global.fetch;
  const seen = { vars: null };
  // @ts-ignore - test stub
  global.fetch = async (url, init) => {
    const parsed = JSON.parse(String(init.body));
    if (parsed.query.includes("addComment")) {
      seen.vars = parsed.variables;
      const data = errors ? { errors, data: null } : { data: { addComment: { commentEdge: { node: { databaseId: dbId } } } } };
      return /** @type {any} */ ({ ok: true, status: 200, json: async () => data });
    }
    return inner(url, init);
  };
  return seen;
}

test("github-projects postComment comments on the card's issue when the item is on the board", async () => {
  const a = gpxAdapter();
  const stub = stubGraphql(); // default item: issue number 42, node id I_42
  const seen = captureAddComment(stub);
  try {
    const id = await a.postComment("42", "remote run's findings");
    assert.equal(id, 9001);
    assert.deepEqual(seen.vars, { s: "I_42", b: "remote run's findings" }, "subjectId is the card's issue node id — no repository lookup needed");
  } finally {
    stub.restore();
  }
});

test("github-projects postComment falls back to the loose issue's node id via tracker.repository", async () => {
  const a = gpxAdapter({ repository: "acme/repo" });
  const stub = stubGraphql({ items: [] }); // nothing on the board
  const seen = captureAddComment(stub);
  try {
    await a.postComment("42", "orphan");
    assert.deepEqual(seen.vars, { s: "I_new", b: "orphan" }, "the issue's node id resolved from tracker.repository");
  } finally {
    stub.restore();
  }
});

test("github-projects postComment: an off-board issue WITHOUT tracker.repository throws a clear message", async () => {
  const a = gpxAdapter();
  const stub = stubGraphql({ items: [] });
  try {
    await assert.rejects(a.postComment("42", "orphan"), /tracker\.repository is unset/);
  } finally {
    stub.restore();
  }
});

test("github-projects postComment throws with the GraphQL error message", async () => {
  const a = gpxAdapter();
  const stub = stubGraphql();
  const seen = captureAddComment(stub, { errors: [{ message: "could not resolve to a node with the global id of \"I_42\"" }] });
  try {
    await assert.rejects(a.postComment("42", "x"), /could not resolve to a node/);
    assert.ok(seen.vars, "the mutation was attempted before the error surfaced");
  } finally {
    stub.restore();
  }
});
