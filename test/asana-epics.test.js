import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// Asana adapter: complete (forge merge), queue-stage pull (listQueued), epics (#297 — the
// tracker-neutral shape plus the Asana reader), and the done signal (#585 — fetchTask().completed
// as the native flag; a completion of ours yields a board_done job).
import test from "node:test";
import assert from "node:assert/strict";
import { createAsanaAdapter, mapEpicFields, mapEpics, mapEpicTickets } from "../src/trackers/asana.js";
import { makeStore, ok, withFetch, withPipeline, releasePipeline, releaseStub, routed } from "./_asana-helpers.js";

// --- complete (forge merge) ---

test("complete PUTs completed:true on the task", async () => {
  /** @type {string[]} */
  const calls = [];
  let body;
  const orig = global.fetch;
  // @ts-ignore - test stub
  global.fetch = async (url, init = {}) => {
    calls.push(`${init.method || "GET"} ${url}`);
    if (init.body) body = JSON.parse(String(init.body));
    return ok({ data: {} });
  };
  try {
    await routed().complete?.("G1");
  } finally {
    global.fetch = orig;
  }
  assert.deepEqual(calls, ["PUT https://app.asana.com/api/1.0/tasks/G1"]);
  assert.deepEqual(body, { data: { completed: true } });
});

test("complete throws on a non-2xx", async () => {
  const orig = global.fetch;
  // @ts-ignore - test stub
  global.fetch = async () => ({ ok: false, status: 403, json: async () => ({}) });
  try {
    await assert.rejects(() => /** @type {any} */ (routed()).complete("G1"), /complete 403/);
  } finally {
    global.fetch = orig;
  }
});

test("complete refuses (no PUT) a task not assigned to us — fail-closed", async () => {
  /** @type {string[]} */
  const calls = [];
  const orig = global.fetch;
  // @ts-ignore - test stub
  global.fetch = async (url, init = {}) => {
    calls.push(`${init.method || "GET"} ${url}`);
    return ok({ data: { assignee: { gid: "SOMEONE_ELSE" } } });
  };
  try {
    await routed({ assigneeFilter: true, userGid: "ME" }).complete?.("G1");
  } finally {
    global.fetch = orig;
  }
  assert.ok(!calls.some((c) => c.startsWith("PUT")), `unexpected write: ${calls.join("\n")}`);
});

// --- queue-stage pull: listQueued ---
const qPipeline = [{ id: "code", sourceSectionGid: "S1", successSectionGid: "S2", queueSectionGid: "Q1" }];
/** @param {any} [pc] */
const queued = (pc = {}) =>
  createAsanaAdapter(/** @type {any} */ ({ trigger: "@agent", pipeline: qPipeline, providerConfig: { type: "asana", token: "t", ...pc } }), /** @type {any} */ (makeStore()));

test("listQueued reads the queue section in API order, keeping only our open, unblocked tasks", async () => {
  /** @type {string[]} */
  const urls = [];
  const orig = global.fetch;
  // @ts-ignore - test stub
  global.fetch = async (url) => {
    const u = String(url);
    urls.push(u);
    if (u.includes("/tasks/t3/dependencies")) return ok({ data: [] });
    if (u.includes("/tasks/t9/dependencies")) return ok({ data: [{ gid: "blocker", completed: false }] });
    return ok({
      data: [
        { gid: "t3", completed: false, assignee: { gid: "me" } },
        { gid: "t1", completed: true, assignee: { gid: "me" } },
        { gid: "t2", completed: false, assignee: { gid: "someone" } },
        { gid: "t9", completed: false, assignee: { gid: "me" } },
      ],
    });
  };
  try {
    // t9 is blocked (open dependency) and must not be pulled.
    assert.deepEqual(await queued({ userGid: "me" }).listQueued("code"), ["t3"]);
    assert.ok(urls[0].includes("/sections/Q1/tasks"), urls[0]);
    // Fail-closed: scoping on but no userGid → nothing is ours.
    assert.deepEqual(await queued().listQueued("code"), []);
  } finally {
    global.fetch = orig;
  }
});

test("listQueued drops an epic row, keeps untyped and other-typed rows", async () => {
  const orig = global.fetch;
  // @ts-ignore - test stub
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/dependencies")) return ok({ data: [] });
    return ok({
      data: [
        { gid: "t1", completed: false, assignee: { gid: "me" } },
        { gid: "t2", completed: false, assignee: { gid: "me" }, custom_type: { name: "Epic" } },
        { gid: "t3", completed: false, assignee: { gid: "me" }, custom_type: { name: "Milestone" } },
      ],
    });
  };
  try {
    assert.deepEqual(await queued({ userGid: "me" }).listQueued("code"), ["t1", "t3"]);
  } finally {
    global.fetch = orig;
  }
});

test("listQueued lists a task whose dependencies are all completed", async () => {
  const orig = global.fetch;
  // @ts-ignore - test stub
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/tasks/t3/dependencies")) return ok({ data: [{ gid: "blocker", completed: true }] });
    return ok({ data: [{ gid: "t3", completed: false, assignee: { gid: "me" } }] });
  };
  try {
    assert.deepEqual(await queued({ userGid: "me" }).listQueued("code"), ["t3"]);
  } finally {
    global.fetch = orig;
  }
});

test("listQueued fails open (lists the task) when the dependencies call errors", async () => {
  const orig = global.fetch;
  // @ts-ignore - test stub
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/tasks/t3/dependencies")) return /** @type {any} */ ({ ok: false, status: 500 });
    return ok({ data: [{ gid: "t3", completed: false, assignee: { gid: "me" } }] });
  };
  try {
    assert.deepEqual(await queued({ userGid: "me" }).listQueued("code"), ["t3"]);
  } finally {
    global.fetch = orig;
  }
});

test("listQueued is [] (no API call) for a step without a queue key", async () => {
  let calls = 0;
  const orig = global.fetch;
  // @ts-ignore - test stub
  global.fetch = async () => (calls++, ok({ data: [] }));
  try {
    assert.deepEqual(await routed().listQueued("code"), []);
  } finally {
    global.fetch = orig;
  }
  assert.equal(calls, 0);
});

// --- epics (#297): tracker-neutral shape + Asana reader — pure mappers, fetchTask fields,
// and the two optional readers (fail-open, [] when the custom type isn't configured).

test("mapEpicFields: a task typed as the epic type is itself an epic", () => {
  assert.deepEqual(mapEpicFields({ custom_type: { name: "Epic" } }, "Epic"), { isEpic: true });
});

test("mapEpicFields: a ticket whose parent is typed as the epic type gets .epic", () => {
  const t = { parent: { gid: "E1", name: "Epics epic", permalink_url: "https://x/E1", custom_type: { name: "Epic" } } };
  assert.deepEqual(mapEpicFields(t, "Epic"), { isEpic: false, epic: { ref: "E1", name: "Epics epic", url: "https://x/E1" } });
});

test("mapEpicFields: a plain (untyped) parent is never an epic", () => {
  assert.deepEqual(mapEpicFields({ parent: { gid: "P1", name: "Plain parent" } }, "Epic"), { isEpic: false });
});

test("mapEpicFields: a non-default epicType name is respected", () => {
  assert.deepEqual(mapEpicFields({ custom_type: { name: "Initiative" } }, "Initiative"), { isEpic: true });
  assert.deepEqual(mapEpicFields({ custom_type: { name: "Epic" } }, "Initiative"), { isEpic: false });
});

test("mapEpics keeps only Epic-typed rows, maps status and completed", () => {
  const data = [
    { gid: "E1", name: "Epic one", permalink_url: "https://x/E1", completed: false, custom_type: { name: "Epic" }, custom_type_status_option: { name: "On track" } },
    { gid: "E2", name: "Epic two", permalink_url: "https://x/E2", completed: true, custom_type: { name: "Epic" } },
    { gid: "T1", name: "Not an epic", permalink_url: "https://x/T1", completed: false, custom_type: { name: "Milestone" } },
  ];
  assert.deepEqual(mapEpics(data, "Epic"), [
    { ref: "E1", name: "Epic one", url: "https://x/E1", status: "On track", completed: false },
    { ref: "E2", name: "Epic two", url: "https://x/E2", status: null, completed: true },
  ]);
});

test("mapEpicTickets keeps a subtask in the project (right stage + displayId + permalink, even with a /f suffix) and drops one outside it", () => {
  const data = [
    {
      gid: "T1",
      name: "In project",
      completed: false,
      permalink_url: "https://app.asana.com/0/1/T1/f",
      custom_fields: [{ name: "ID", display_value: "ID-1" }],
      memberships: [{ project: { gid: "P1" }, section: { name: "In progress" } }],
    },
    {
      gid: "T2",
      name: "Elsewhere",
      completed: false,
      memberships: [{ project: { gid: "OTHER" }, section: { name: "Backlog" } }],
    },
  ];
  assert.deepEqual(mapEpicTickets(data, "P1", "ID"), [
    { ref: "T1", displayId: "ID-1", name: "In project", completed: false, stage: "In progress", url: "https://app.asana.com/0/1/T1/f" },
  ]);
});

test("fetchTask returns epic and isEpic with no extra API call (opt_fields only)", async () => {
  /** @type {string[]} */
  const urls = [];
  const task = await withFetch(
    (u) => {
      urls.push(u);
      return ok({
        data: {
          name: "A ticket",
          permalink_url: "https://x/G1",
          completed: false,
          custom_fields: [],
          parent: { gid: "E1", name: "The epic", permalink_url: "https://x/E1", custom_type: { name: "Epic" } },
        },
      });
    },
    () => routed().fetchTask("G1"),
  );
  assert.deepEqual(task.epic, { ref: "E1", name: "The epic", url: "https://x/E1" });
  assert.equal(task.isEpic, false);
  assert.equal(urls.length, 1, `expected exactly one fetchTask call; got:\n${urls.join("\n")}`);
});

test("listEpics returns [] with no Epic type configured on the project (fail-open, no search call)", async () => {
  const jobs = await withFetch(
    (u) => {
      if (u.includes("/custom_types")) return ok({ data: [] });
      throw new Error(`unexpected call: ${u}`);
    },
    () => routed({ projectGid: "P1", workspaceGid: "WS" }).listEpics?.(),
  );
  assert.deepEqual(jobs, []);
});

test("listEpics returns [] on a custom_types API error (fail-open)", async () => {
  const origWarn = console.warn;
  console.warn = () => {};
  let epics;
  try {
    epics = await withFetch(
      () => /** @type {any} */ ({ ok: false, status: 500, json: async () => ({}) }),
      () => routed({ projectGid: "P1", workspaceGid: "WS" }).listEpics?.(),
    );
  } finally {
    console.warn = origWarn;
  }
  assert.deepEqual(epics, []);
});

test("listEpics maps the task search results once the Epic type is found", async () => {
  const epics = await withFetch(
    (u) => {
      if (u.includes("/custom_types")) return ok({ data: [{ gid: "CT1", name: "Epic" }] });
      if (u.includes("/tasks/search")) return ok({ data: [{ gid: "E1", name: "Epic one", permalink_url: "https://x/E1", completed: false, custom_type: { name: "Epic" } }] });
      throw new Error(`unexpected call: ${u}`);
    },
    () => routed({ projectGid: "P1", workspaceGid: "WS" }).listEpics?.(),
  );
  assert.deepEqual(epics, [{ ref: "E1", name: "Epic one", url: "https://x/E1", status: null, completed: false }]);
});

test("listEpicTickets returns [] with no Epic type configured (fail-open, no subtasks call)", async () => {
  const tickets = await withFetch(
    (u) => {
      if (u.includes("/custom_types")) return ok({ data: [] });
      throw new Error(`unexpected call: ${u}`);
    },
    () => routed({ projectGid: "P1", workspaceGid: "WS" }).listEpicTickets?.("E1"),
  );
  assert.deepEqual(tickets, []);
});

test("listEpicTickets maps the subtasks results once the Epic type is found, requesting permalink_url", async () => {
  const urls = [];
  const tickets = await withFetch(
    (u) => {
      urls.push(u);
      if (u.includes("/custom_types")) return ok({ data: [{ gid: "CT1", name: "Epic" }] });
      if (u.includes("/tasks/E1/subtasks")) return ok({ data: [{ gid: "T1", name: "A ticket", completed: false, permalink_url: "https://app.asana.com/0/1/T1", custom_fields: [], memberships: [{ project: { gid: "P1" }, section: { name: "Doing" } }] }] });
      throw new Error(`unexpected call: ${u}`);
    },
    () => routed({ projectGid: "P1", workspaceGid: "WS" }).listEpicTickets?.("E1"),
  );
  assert.deepEqual(tickets, [{ ref: "T1", displayId: undefined, name: "A ticket", completed: false, stage: "Doing", url: "https://app.asana.com/0/1/T1" }]);
  assert.ok(urls.some((u) => u.includes("/tasks/E1/subtasks") && u.includes("permalink_url")));
});

test("listEpicTickets returns [] on a subtasks API error (fail-open)", async () => {
  const origWarn = console.warn;
  console.warn = () => {};
  let tickets;
  try {
    tickets = await withFetch(
      (u) => {
        if (u.includes("/custom_types")) return ok({ data: [{ gid: "CT1", name: "Epic" }] });
        if (u.includes("/subtasks")) return /** @type {any} */ ({ ok: false, status: 500, json: async () => ({}) });
        throw new Error(`unexpected call: ${u}`);
      },
      () => routed({ projectGid: "P1", workspaceGid: "WS" }).listEpicTickets?.("E1"),
    );
  } finally {
    console.warn = origWarn;
  }
  assert.deepEqual(tickets, []);
});

test("registerWebhook: a non-2xx (list or create, JSON or HTML body) throws an Error carrying the HTTP status", async () => {
  const html = (/** @type {number} */ status) => /** @type {any} */ ({ ok: false, status, json: async () => JSON.parse("<html>bad gateway</html>") });
  const reg = () => routed({ projectGid: "P1", workspaceGid: "WS" }).registerWebhook("https://x.example");
  /** @param {(u: string, init: any) => any} stub */
  const thrown = (stub) => withFetch(stub, reg).then(() => null, (e) => e);

  const listDown = await thrown(() => html(502));
  assert.equal(listDown.status, 502);
  assert.equal(listDown.message, "Asana: list webhooks 502");

  const createDown = await thrown((u, init) => (init.method === "POST" ? html(503) : ok({ data: [] })));
  assert.equal(createDown.status, 503);

  const notFound = await thrown((u, init) =>
    init.method === "POST" ? { ok: false, status: 404, json: async () => ({ errors: [{ message: "Not a recognized ID: P1" }] }) } : ok({ data: [] }),
  );
  assert.equal(notFound.status, 404);
  assert.equal(notFound.message, 'Asana: [{"message":"Not a recognized ID: P1"}]');
});

// --- done signal (#585): fetchTask().completed is the native flag; a completion of ours → board_done ---

test("fetchTask().completed: task completed true → true, false/absent → false", async () => {
  for (const [completed, want] of [[true, true], [false, false], [undefined, false]]) {
    const task = await withFetch(() => ok({ data: { name: "t", notes: "", permalink_url: "u", completed, custom_fields: [] } }), () => routed().fetchTask("G9"));
    assert.equal(task.completed, want, String(completed));
  }
});

test("board_done: completing a task of ours yields one board_done (keyed by event created_at) alongside the unblock jobs; not ours → none", async () => {
  const ev = JSON.stringify({ events: [{ action: "changed", created_at: "2026-10-27T10:00:00.000Z", resource: { resource_type: "task", gid: "B1" }, change: { field: "completed", action: "changed" } }] });
  /** @param {string} assignee */
  const stub = (assignee) => (/** @type {string} */ u) => {
    if (u.includes("/tasks/B1?")) {
      assert.ok(u.includes("assignee.gid"), "the live re-read requests the assignee");
      return ok({ data: { completed: true, assignee: { gid: assignee } } });
    }
    return releaseStub(true, [])(u);
  };
  const a = withPipeline(releasePipeline, { assigneeFilter: true, userGid: "U" });
  const ours = await withFetch(stub("U"), () => a.processEvents(/** @type {any} */ ({ rawBody: ev })));
  assert.deepEqual(ours, [
    { kind: "board_done", ref: "B1", stepId: "", dedupKey: "done:B1:2026-10-27T10:00:00.000Z" },
    { kind: "pipeline", ref: "D1", stepId: "code", dedupKey: "unblock:B1:D1" },
  ]);
  const theirs = await withFetch(stub("OTHER"), () => a.processEvents(/** @type {any} */ ({ rawBody: ev })));
  assert.deepEqual(theirs, [{ kind: "pipeline", ref: "D1", stepId: "code", dedupKey: "unblock:B1:D1" }]);
});
