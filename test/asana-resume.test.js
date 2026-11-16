import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// Asana adapter: the `@agent` comment trigger (story comment_added → resume the held step),
// fetchTask's displayId mapping (from a custom field, default name "ID"), and routeKeys
// (multi-repo routing off a custom field).
import test from "node:test";
import assert from "node:assert/strict";
import { createAsanaAdapter, extractRouteKeys } from "../src/trackers/asana.js";
import { makeStore, ok, pipeline, routed } from "./_asana-helpers.js";

/** Adapter over a store stub whose held record / attempt count / seen set the test controls.
 * @param {{pc?: object, held?: any, ran?: number, seen?: string[]}} [o] */
function commentRouted({ pc = {}, held = { stepId: "code", heldAt: "2026-09-24T00:00:00.000Z" }, ran = 1, seen = [] } = {}) {
  const store = { ...makeStore(), getHeld: () => held, getAttempt: () => ran, hasSeen: (/** @type {string} */ k) => seen.includes(k) };
  const providerConfig = { type: "asana", token: "t", assigneeFilter: false, userGid: "U1", ...pc };
  return createAsanaAdapter(/** @type {any} */ ({ trigger: "@agent", pipeline, providerConfig }), /** @type {any} */ (store));
}

/** Run a comment_added story ST1 on task G1 through processEvents with stubbed fetches.
 * @param {any} a @param {{text?: string, author?: string|null, assignee?: string}} [o] */
async function runComment(a, { text = "@agent use Postgres", author = "U1", assignee = "U1" } = {}) {
  /** @type {string[]} */
  const urls = [];
  const orig = global.fetch;
  // @ts-ignore - test stub
  global.fetch = async (url) => {
    const u = String(url);
    urls.push(u);
    if (u.includes("/stories/ST1")) return ok({ data: { resource_subtype: "comment_added", text, created_by: author ? { gid: author } : null, target: { gid: "G1" } } });
    if (u.includes("/tasks/G1")) return ok({ data: { assignee: { gid: assignee } } });
    return ok({});
  };
  try {
    const jobs = await a.processEvents(/** @type {any} */ ({ rawBody: JSON.stringify({ events: [{ action: "added", resource: { resource_type: "story", gid: "ST1" }, parent: { gid: "G1" } }] }) }));
    return { jobs, urls };
  } finally {
    global.fetch = orig;
  }
}

// --- fetchTask displayId: the human id comes from a custom field (default name "ID").
/** Run fetchTask("G9") against a stubbed task carrying `custom_fields`. @param {any[]} custom_fields @param {object} [pc] */
async function fetchWith(custom_fields, pc = {}) {
  const orig = global.fetch;
  /** @type {string[]} */
  const urls = [];
  // @ts-ignore - test stub
  global.fetch = async (url) => {
    urls.push(String(url));
    return ok({ data: { name: "Fix it", notes: "", permalink_url: "https://app.asana.com/t/G9", completed: false, custom_fields } });
  };
  try {
    return { task: await routed(pc).fetchTask("G9"), urls };
  } finally {
    global.fetch = orig;
  }
}

test("comment_added: the owner's @agent reply on a held task resumes the held step", async () => {
  const { jobs, urls } = await runComment(commentRouted());
  assert.deepEqual(jobs, [{ kind: "pipeline", ref: "G1", stepId: "code", dedupKey: "trigger:ST1", comment: "@agent use Postgres" }]);
  assert.ok(urls.some((u) => u.includes("/stories/ST1") && u.includes("created_by.gid")), "fetchStory must request the author");
});

test("comment_added: resumes under assignee scoping when the task is ours", async () => {
  assert.equal((await runComment(commentRouted({ pc: { assigneeFilter: true } }))).jobs.length, 1);
});

test("comment_added: assigneeFilter:false still rejects a foreign author", async () => {
  assert.deepEqual((await runComment(commentRouted(), { author: "U2" })).jobs, []);
});

test("comment_added: an unset userGid rejects every author (fail-closed)", async () => {
  assert.deepEqual((await runComment(commentRouted({ pc: { userGid: undefined } }))).jobs, []);
});

test("comment_added: a text not starting with the trigger yields no job", async () => {
  assert.deepEqual((await runComment(commentRouted(), { text: "thanks, @agent" })).jobs, []);
});

test("comment_added: a task not assigned to us yields no job (assignee gate)", async () => {
  assert.deepEqual((await runComment(commentRouted({ pc: { assigneeFilter: true } }), { assignee: "U9" })).jobs, []);
});

test("comment_added: no held record yields no job", async () => {
  assert.deepEqual((await runComment(commentRouted({ held: null }))).jobs, []);
});

test("comment_added: the held step at its attempt cap yields no job", async () => {
  assert.deepEqual((await runComment(commentRouted({ ran: 3 }))).jobs, []);
});

test("comment_added: an already-seen trigger:<storyGid> is skipped before any fetch", async () => {
  const { jobs, urls } = await runComment(commentRouted({ seen: ["trigger:ST1"] }));
  assert.deepEqual(jobs, []);
  assert.deepEqual(urls, []);
});

test("registerWebhook's filters include story comment_added (and keep section_changed)", async () => {
  /** @type {any} */
  let posted;
  const orig = global.fetch;
  // @ts-ignore - test stub
  global.fetch = async (url, init = {}) => {
    if (String(url).endsWith("/webhooks") && init.method === "POST") posted = JSON.parse(String(init.body));
    return ok({ data: String(url).includes("/webhooks?") ? [] : { gid: "W1", active: true } });
  };
  try {
    await routed({ projectGid: "P1", workspaceGid: "WS" }).registerWebhook("https://example.test");
  } finally {
    global.fetch = orig;
  }
  const subtypes = (posted?.data?.filters || []).map((/** @type {any} */ f) => f.resource_subtype).filter(Boolean);
  assert.deepEqual(subtypes, ["section_changed", "comment_added"]);
});

test("fetchTask maps displayId from the custom field named ID (case-insensitive)", async () => {
  const { task, urls } = await fetchWith([{ name: "Priority", display_value: "High" }, { name: "id", display_value: "ID-1234" }]);
  assert.equal(task.displayId, "ID-1234");
  assert.equal(task.name, "Fix it");
  assert.ok(urls[0].includes("custom_fields.name,custom_fields.display_value"), "requests the custom fields");
});

test("fetchTask honors a custom displayIdField", async () => {
  const { task } = await fetchWith([{ name: "ID", display_value: "ID-1" }, { name: "Ticket", display_value: "TK-9" }], { displayIdField: "Ticket" });
  assert.equal(task.displayId, "TK-9");
});

test("fetchTask leaves displayId undefined when the field is absent", async () => {
  assert.equal((await fetchWith([{ name: "Priority", display_value: "High" }])).task.displayId, undefined);
  assert.equal((await fetchWith(/** @type {any} */ (undefined))).task.displayId, undefined);
});

// --- routeKeys (multi-repo routing) ---

test("extractRouteKeys reads enum, multi-enum, text, display_value", () => {
  assert.deepEqual(extractRouteKeys([{ name: "Platform", enum_value: { name: "iOS" } }], "Platform"), ["iOS"]);
  assert.deepEqual(
    extractRouteKeys([{ name: "Platform", multi_enum_values: [{ name: "backend" }, { name: "iOS" }] }], "Platform"),
    ["backend", "iOS"],
  );
  assert.deepEqual(extractRouteKeys([{ name: "Platform", text_value: "ios" }], "Platform"), ["ios"]);
  assert.deepEqual(extractRouteKeys([{ name: "Platform", display_value: "Android" }], "Platform"), ["Android"]);
});

test("extractRouteKeys returns [] for unset / missing / unconfigured", () => {
  const unset = { name: "Platform", enum_value: null, multi_enum_values: [], text_value: null, display_value: null };
  assert.deepEqual(extractRouteKeys([unset], "Platform"), []);
  assert.deepEqual(extractRouteKeys([{ name: "Other", text_value: "x" }], "Platform"), []);
  assert.deepEqual(extractRouteKeys([unset], undefined), []);
  assert.deepEqual(extractRouteKeys([{ name: "Platform", text_value: "x" }], ""), []);
  assert.deepEqual(extractRouteKeys(undefined, "Platform"), []);
});

test("extractRouteKeys matches the field name case-insensitively", () => {
  assert.deepEqual(extractRouteKeys([{ name: "Platform", enum_value: { name: "iOS" } }], "platform"), ["iOS"]);
});

test("fetchTask returns routeKeys when routeField set, [] otherwise", async () => {
  const cf = [{ name: "Platform", enum_value: { name: "iOS" } }];
  const on = await fetchWith(cf, { routeField: "Platform" });
  assert.deepEqual(on.task.routeKeys, ["iOS"]);
  assert.ok(on.urls[0].includes("custom_fields.enum_value.name,custom_fields.multi_enum_values.name,custom_fields.text_value"));
  assert.deepEqual((await fetchWith(cf)).task.routeKeys, []);
});
