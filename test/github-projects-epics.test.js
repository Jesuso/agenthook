import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// GitHub Projects v2 adapter — epics coverage (ADR 0003/0004/0005): isEpicGqlIssue /
// toRestShape / mapProjectEpics / mapProjectEpicTickets pure mapping, fetchTask's isEpic +
// epic-parent fields, listResting/listQueued excluding epic cards, and listEpics /
// listEpicTickets (including sub-issue paging). The adapter is GraphQL-only, so the fetch
// stubs route by inspecting the posted `query` string.
import test from "node:test";
import assert from "node:assert/strict";
import { createGithubProjectsAdapter, isEpicGqlIssue, toRestShape, mapProjectEpics, mapProjectEpicTickets } from "../src/trackers/github-projects.js";
import { adapter, makeStore, stubGraphql } from "./_github-projects-helpers.js";

// --- epics (ADR 0003/0004/0005) ---
const REPO = "acme/repo";
/** A GraphQL Issue node. @param {number} n @param {Record<string, any>} [o] */
const gqlIssue = (n, o = {}) => ({
  __typename: "Issue",
  id: `I_${n}`,
  number: n,
  title: `issue ${n}`,
  body: "",
  url: `https://github.com/${REPO}/issues/${n}`,
  state: "OPEN",
  assignees: { nodes: [] },
  issueType: null,
  labels: { nodes: [] },
  repository: { nameWithOwner: REPO },
  parent: null,
  ...o,
});
const TYPED_EPIC = gqlIssue(10, { title: "Typed epic", issueType: { name: "Epic" } });
const LABELLED_EPIC = gqlIssue(11, { title: "Labelled epic", labels: { nodes: [{ name: "EPIC" }] }, state: "CLOSED" });
const PLAIN_PARENT = gqlIssue(12, { title: "Plain parent" });
/** @param {any} issue @param {string|null} status */
const card = (issue, status) => ({ id: `PVTI_${issue.number}`, content: issue, status: status ? { name: status } : null });

test("isEpicGqlIssue: typed or labelled (any case) epic; plain parent / null is not", () => {
  assert.equal(isEpicGqlIssue(TYPED_EPIC, "Epic", "epic"), true);
  assert.equal(isEpicGqlIssue(LABELLED_EPIC, "Epic", "epic"), true);
  assert.equal(isEpicGqlIssue(PLAIN_PARENT, "Epic", "epic"), false);
  assert.equal(isEpicGqlIssue(null, "Epic", "epic"), false);
  assert.deepEqual(toRestShape(LABELLED_EPIC), { type: null, labels: [{ name: "EPIC" }] });
  assert.deepEqual(toRestShape(TYPED_EPIC).type, { name: "Epic" });
});

test("mapProjectEpics: only epic Issue cards, Status (null when unset), completed, deduped", () => {
  const items = [card(TYPED_EPIC, "In Progress"), card(PLAIN_PARENT, "Todo"), card(LABELLED_EPIC, null), card(TYPED_EPIC, "In Progress"), { issue: { __typename: "DraftIssue" }, status: null }];
  const shaped = items.map((it) => ("content" in it ? { issue: it.content, status: it.status?.name ?? null } : it));
  assert.deepEqual(mapProjectEpics(shaped, "Epic", "epic"), [
    { ref: "10", name: "Typed epic", url: `https://github.com/${REPO}/issues/10`, displayId: "#10", status: "In Progress", completed: false },
    { ref: "11", name: "Labelled epic", url: `https://github.com/${REPO}/issues/11`, displayId: "#11", status: null, completed: true },
  ]);
});

test("mapProjectEpicTickets: same/other repo refs, on-board Status, no-Status → '', off-board → null", () => {
  const children = [
    { id: "I_20", number: 20, title: "same on board", state: "OPEN", repository: { nameWithOwner: "ACME/Repo" }, url: "https://github.com/ACME/Repo/issues/20" },
    { id: "I_21", number: 21, title: "same off board", state: "CLOSED", repository: { nameWithOwner: REPO }, url: "https://github.com/acme/repo/issues/21" },
    { id: "I_X5", number: 5, title: "other on board", state: "OPEN", repository: { nameWithOwner: "acme/other" }, url: "https://github.com/acme/other/issues/5" },
    { id: "I_22", number: 22, title: "same no status", state: "OPEN", repository: { nameWithOwner: REPO }, url: "https://github.com/acme/repo/issues/22" },
  ];
  const stages = new Map([
    ["I_20", "In Review"],
    ["I_X5", "Todo"],
    ["I_22", null],
  ]);
  assert.deepEqual(mapProjectEpicTickets(children, REPO, stages), [
    { ref: "20", displayId: "#20", name: "same on board", completed: false, stage: "In Review", url: "https://github.com/ACME/Repo/issues/20" },
    { ref: "21", displayId: "#21", name: "same off board", completed: true, stage: null, url: "https://github.com/acme/repo/issues/21" },
    { ref: "acme/other#5", displayId: "acme/other#5", name: "other on board", completed: false, stage: "Todo", url: "https://github.com/acme/other/issues/5" },
    { ref: "22", displayId: "#22", name: "same no status", completed: false, stage: "", url: "https://github.com/acme/repo/issues/22" },
  ]);
});

test("fetchTask: typed / labelled epic → isEpic; plain parent → false", async () => {
  const { restore } = stubGraphql({ items: [card(TYPED_EPIC, "Todo"), card(LABELLED_EPIC, "Todo"), card(PLAIN_PARENT, "Todo")] });
  try {
    const a = adapter();
    assert.equal((await a.fetchTask("10")).isEpic, true);
    assert.equal((await a.fetchTask("11")).isEpic, true);
    assert.equal((await a.fetchTask("12")).isEpic, false);
  } finally {
    restore();
  }
});

test("fetchTask: same-repo epic parent → epic; plain or other-repo parent → no epic key; no extra request", async () => {
  const child = gqlIssue(30, { parent: { number: 10, title: "Typed epic", url: TYPED_EPIC.url, issueType: { name: "Epic" }, labels: { nodes: [] }, repository: { nameWithOwner: "Acme/Repo" } } });
  const plainChild = gqlIssue(31, { parent: { number: 12, title: "Plain parent", url: PLAIN_PARENT.url, issueType: null, labels: { nodes: [] }, repository: { nameWithOwner: REPO } } });
  const otherChild = gqlIssue(32, { parent: { number: 10, title: "Foreign epic", url: "u", issueType: { name: "Epic" }, labels: { nodes: [] }, repository: { nameWithOwner: "acme/other" } } });
  const orphan = gqlIssue(33);
  const { captured, restore } = stubGraphql({ items: [card(child, "Todo"), card(plainChild, "Todo"), card(otherChild, "Todo"), card(orphan, "Todo")] });
  try {
    const a = adapter();
    const t = await a.fetchTask("30");
    assert.deepEqual(t.epic, { ref: "10", name: "Typed epic", url: TYPED_EPIC.url, displayId: "#10" });
    assert.equal(t.isEpic, false);
    const callsAfterFirst = captured.calls;
    assert.equal(callsAfterFirst, 2, "project id + one item scan — no parent lookup");
    assert.ok(!("epic" in (await a.fetchTask("31"))));
    assert.ok(!("epic" in (await a.fetchTask("32"))));
    assert.ok(!("epic" in (await a.fetchTask("33"))));
    assert.equal(captured.calls - callsAfterFirst, 3, "one scan per fetchTask (project id memoised)");
  } finally {
    restore();
  }
});

test("the item query reads issueType, labels, repository and parent", async () => {
  const { restore } = stubGraphql();
  /** @type {string[]} */
  const queries = [];
  const inner = global.fetch;
  // @ts-ignore - test stub
  global.fetch = async (url, init = {}) => (queries.push(JSON.parse(String(init.body)).query), inner(url, init));
  try {
    await adapter().fetchTask("42");
  } finally {
    restore();
  }
  const q = queries.find((x) => x.includes("items(first:100")) || "";
  for (const f of ["issueType{ name }", "labels(first:20){ nodes{ name } }", "repository{ nameWithOwner }", "parent{ number title url"]) assert.ok(q.includes(f), f);
});

test("listResting / listQueued never return an epic card", async () => {
  const pl = [{ id: "code", sourceStatus: "In Progress", queueStatus: "Todo" }];
  const items = [card(TYPED_EPIC, "In Progress"), card(gqlIssue(40), "In Progress"), card(gqlIssue(41, { labels: { nodes: [{ name: "Epic" }] } }), "Todo"), card(gqlIssue(42), "Todo")];
  const { restore } = stubGraphql({ items });
  try {
    const a = createGithubProjectsAdapter(
      /** @type {any} */ ({ trigger: "@agent", pipeline: pl, providerConfig: { type: "github-projects", token: "t", project: "acme/7", assigneeFilter: false } }),
      /** @type {any} */ (makeStore()),
    );
    assert.deepEqual((await a.listResting()).map((j) => j.ref), ["40"]);
    assert.deepEqual(await a.listQueued("code"), ["42"]);
  } finally {
    restore();
  }
});

test("listEpics: epic cards on the board; GraphQL failure → [] + warn", async () => {
  const { restore } = stubGraphql({ items: [card(TYPED_EPIC, "Todo"), card(PLAIN_PARENT, "Todo"), card(LABELLED_EPIC, null)] });
  try {
    const epics = await adapter().listEpics?.();
    assert.deepEqual(epics?.map((e) => [e.ref, e.status, e.completed]), [
      ["10", "Todo", false],
      ["11", null, true],
    ]);
  } finally {
    restore();
  }
  const orig = global.fetch;
  const warn = console.warn;
  /** @type {any[]} */
  const warned = [];
  console.warn = (...args) => warned.push(args);
  // @ts-ignore - test stub
  global.fetch = async () => ({ ok: false, status: 502, json: async () => ({}) });
  try {
    assert.deepEqual(await adapter().listEpics?.(), []);
    assert.ok(warned.some((w) => String(w[0]).startsWith("[epics]")));
  } finally {
    global.fetch = orig;
    console.warn = warn;
  }
});

/** Wrap stubGraphql so subIssues queries answer from `pages` (one per call, by cursor). */
function stubSubIssues(items, pages) {
  const stub = stubGraphql({ items });
  const inner = global.fetch;
  /** @type {any[]} */
  const subCalls = [];
  // @ts-ignore - test stub
  global.fetch = async (url, init = {}) => {
    const { query, variables } = JSON.parse(String(init.body));
    if (query.includes("subIssues")) {
      stub.captured.calls++;
      subCalls.push(variables);
      const page = pages[subCalls.length - 1];
      if (page instanceof Error) throw page;
      return { ok: true, status: 200, json: async () => ({ data: { node: { subIssues: page } } }) };
    }
    return inner(url, init);
  };
  return { ...stub, subCalls };
}

test("listEpicTickets: pages sub-issues, maps refs + board stages", async () => {
  const onBoard = gqlIssue(50);
  const noStatus = gqlIssue(52);
  const foreign = gqlIssue(7, { id: "I_F7", repository: { nameWithOwner: "acme/other" } });
  const items = [card(TYPED_EPIC, "Todo"), card(onBoard, "In Review"), card(noStatus, null), card(foreign, "Todo")];
  const pages = [
    { nodes: [{ id: "I_50", number: 50, title: "a", state: "OPEN", repository: { nameWithOwner: REPO } }, { id: "I_51", number: 51, title: "b", state: "CLOSED", repository: { nameWithOwner: REPO } }], pageInfo: { hasNextPage: true, endCursor: "c1" } },
    { nodes: [{ id: "I_F7", number: 7, title: "c", state: "OPEN", repository: { nameWithOwner: "acme/other" } }, { id: "I_52", number: 52, title: "d", state: "OPEN", repository: { nameWithOwner: REPO } }], pageInfo: { hasNextPage: false, endCursor: null } },
  ];
  const { subCalls, restore } = stubSubIssues(items, pages);
  let tickets;
  try {
    tickets = await adapter().listEpicTickets?.("10");
  } finally {
    restore();
  }
  assert.deepEqual(subCalls, [
    { id: "I_10", after: null },
    { id: "I_10", after: "c1" },
  ]);
  assert.deepEqual(
    tickets?.map((t) => [t.ref, t.displayId, t.stage, t.completed]),
    [
      ["50", "#50", "In Review", false],
      ["51", "#51", null, true],
      ["acme/other#7", "acme/other#7", "Todo", false],
      ["52", "#52", "", false],
    ],
  );
});

test("listEpicTickets: bad ref → [] with no fetch; not on board / not an epic / GraphQL error → []", async () => {
  const { captured, restore } = stubSubIssues([card(TYPED_EPIC, "Todo"), card(PLAIN_PARENT, "Todo")], [new Error("boom")]);
  const warn = console.warn;
  console.warn = () => {};
  try {
    const a = adapter();
    for (const bad of ["1.2", "../x", "", "10a"]) assert.deepEqual(await a.listEpicTickets?.(bad), []);
    assert.equal(captured.calls, 0, "no request for an invalid ref");
    assert.deepEqual(await a.listEpicTickets?.("99"), []);
    assert.deepEqual(await a.listEpicTickets?.("12"), []);
    assert.deepEqual(await a.listEpicTickets?.("10"), []);
  } finally {
    restore();
    console.warn = warn;
  }
});

