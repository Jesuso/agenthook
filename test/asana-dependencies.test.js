import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// Asana adapter: native task dependencies (the block gate; mirrors test/github-trigger.test.js):
// a task with an incomplete "blocked by" dependency rests in its source section; a blocker
// completing releases each eligible dependent; completeTask on a terminal step completes the
// task; plus the fail-closed/retrying owner-check guard around advance (#265).
import test from "node:test";
import assert from "node:assert/strict";
import { MoveRefusedError } from "../src/trackers/owner.js";
import { ok, withFetch, withPipeline, pipeline, releasePipeline, releaseStub, changedEvent, routed } from "./_asana-helpers.js";

const addedEvent = (gid) => JSON.stringify({ events: [{ action: "added", resource: { resource_type: "task", gid } }] });

test("a task added to a source section with an incomplete dependency rests (no job)", async () => {
  const jobs = await withFetch(
    (u) => {
      if (u.includes("/tasks/G1/dependencies")) return ok({ data: [{ gid: "B1", completed: false }] });
      if (u.includes("/tasks/G1?")) return ok({ data: { memberships: [{ section: { gid: "S1" } }] } });
      return ok({});
    },
    () => routed().processEvents(/** @type {any} */ ({ rawBody: addedEvent("G1") })),
  );
  assert.equal(jobs.length, 0);
});

test("a task whose dependencies are all completed routes as before", async () => {
  const jobs = await withFetch(
    (u) => {
      if (u.includes("/tasks/G1/dependencies")) return ok({ data: [{ gid: "B1", completed: true }] });
      if (u.includes("/tasks/G1?")) return ok({ data: { memberships: [{ section: { gid: "S1" } }] } });
      return ok({});
    },
    () => routed().processEvents(/** @type {any} */ ({ rawBody: addedEvent("G1") })),
  );
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].dedupKey, "step:code:G1");
});

test("a task moved into a source section with an incomplete dependency rests (no job)", async () => {
  const jobs = await withFetch(
    (u) => {
      if (u.includes("/stories/ST1")) return ok({ data: { resource_subtype: "section_changed", target: { gid: "G1" } } });
      if (u.includes("/tasks/G1/dependencies")) return ok({ data: [{ gid: "B1", completed: false }] });
      if (u.includes("/tasks/G1?")) return ok({ data: { memberships: [{ section: { gid: "S1" } }] } });
      return ok({});
    },
    () => routed().processEvents(/** @type {any} */ ({ rawBody: JSON.stringify({ events: [{ action: "added", resource: { resource_type: "story", gid: "ST1" } }] }) })),
  );
  assert.equal(jobs.length, 0);
});

test("a dependencies API error warns and the task fires (fail-open)", async () => {
  /** @type {string[]} */
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...a) => void warnings.push(a.join(" "));
  let jobs;
  try {
    jobs = await withFetch(
      (u) => {
        if (u.includes("/tasks/G1/dependencies")) return /** @type {any} */ ({ ok: false, status: 500, json: async () => ({}) });
        if (u.includes("/tasks/G1?")) return ok({ data: { memberships: [{ section: { gid: "S1" } }] } });
        return ok({});
      },
      () => routed().processEvents(/** @type {any} */ ({ rawBody: addedEvent("G1") })),
    );
  } finally {
    console.warn = origWarn;
  }
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].stepId, "code");
  assert.ok(warnings.some((w) => w.includes("dependencies for G1")), `expected a fail-open warning; got:\n${warnings.join("\n")}`);
});

test("a completed blocker releases exactly its eligible dependents (unblock dedup key)", async () => {
  /** @type {string[]} */
  const urls = [];
  const jobs = await withFetch(releaseStub(true, urls), () =>
    withPipeline(releasePipeline, { assigneeFilter: true, userGid: "U" }).processEvents(/** @type {any} */ ({ rawBody: changedEvent })),
  );
  assert.deepEqual(jobs, [{ kind: "pipeline", ref: "D1", stepId: "code", dedupKey: "unblock:B1:D1" }]);
});

test("a task changed event for a task that is NOT completed releases nothing", async () => {
  /** @type {string[]} */
  const urls = [];
  const jobs = await withFetch(releaseStub(false, urls), () =>
    withPipeline(releasePipeline, { assigneeFilter: true, userGid: "U" }).processEvents(/** @type {any} */ ({ rawBody: changedEvent })),
  );
  assert.equal(jobs.length, 0);
  assert.ok(!urls.some((u) => u.includes("/dependents")), "an incomplete task must not look up its dependents");
});

test("registerWebhook posts four filters, including task changed on `completed`", async () => {
  let body;
  await withFetch(
    (u, init) => {
      if (init.method === "POST" && u.endsWith("/webhooks")) {
        body = JSON.parse(String(init.body));
        return ok({ data: { gid: "W1", active: true } });
      }
      return ok({ data: [] });
    },
    () => routed({ projectGid: "P1", workspaceGid: "WS" }).registerWebhook("https://x.example"),
  );
  assert.deepEqual(body?.data.filters, [
    { resource_type: "task", action: "added" },
    { resource_type: "story", action: "added", resource_subtype: "section_changed" },
    { resource_type: "task", action: "changed", fields: ["completed"] },
    { resource_type: "story", action: "added", resource_subtype: "comment_added" },
  ]);
});

test("listResting omits blocked tasks", async () => {
  const jobs = await withFetch(
    (u) => {
      if (u.includes("/sections/S1/tasks")) return ok({ data: [{ gid: "T1", completed: false }, { gid: "T2", completed: false }] });
      if (u.includes("/tasks/T2/dependencies")) return ok({ data: [{ gid: "B1", completed: false }] });
      if (u.includes("/dependencies")) return ok({ data: [] });
      return ok({});
    },
    () => routed().listResting(),
  );
  assert.deepEqual(
    jobs.map((j) => j.ref),
    ["T1"],
  );
});

test("listResting drops an epic row, keeps untyped and other-typed rows", async () => {
  const jobs = await withFetch(
    (u) => {
      if (u.includes("/sections/S1/tasks")) {
        return ok({
          data: [
            { gid: "T1", completed: false },
            { gid: "T2", completed: false, custom_type: { name: "Epic" } },
            { gid: "T3", completed: false, custom_type: { name: "Milestone" } },
          ],
        });
      }
      if (u.includes("/dependencies")) return ok({ data: [] });
      return ok({});
    },
    () => routed().listResting(),
  );
  assert.deepEqual(
    jobs.map((j) => j.ref),
    ["T1", "T3"],
  );
});

/** Record every fetch as `METHOD url body`. @param {string[]} calls @param {string} [assignee] */
const recordStub = (calls, assignee = "U") => (/** @type {string} */ u, /** @type {any} */ init) => {
  calls.push(`${init.method || "GET"} ${u} ${init.body || ""}`);
  return ok({ data: { assignee: { gid: assignee } } });
};

test("advance into a step flagged completeTask marks the task completed", async () => {
  /** @type {string[]} */
  const calls = [];
  const pl = [
    { id: "code", sourceSectionGid: "S1", successSectionGid: "S2" },
    { id: "done", sourceSectionGid: "S2", manual: true, completeTask: true },
  ];
  await withFetch(recordStub(calls), () => withPipeline(pl, { assigneeFilter: true, userGid: "U" }).advance("G1", "code", /** @type {any} */ ({ outcome: "advance" })));
  assert.ok(calls.some((c) => c.startsWith("POST https://app.asana.com/api/1.0/sections/S2/addTask")), calls.join("\n"));
  assert.ok(
    calls.some((c) => c === `PUT https://app.asana.com/api/1.0/tasks/G1 ${JSON.stringify({ data: { completed: true } })}`),
    `expected a completing PUT; got:\n${calls.join("\n")}`,
  );
});

test("advance without the completeTask flag never completes the task", async () => {
  /** @type {string[]} */
  const calls = [];
  const pl = [
    { id: "code", sourceSectionGid: "S1", successSectionGid: "S2" },
    { id: "done", sourceSectionGid: "S2", manual: true },
  ];
  await withFetch(recordStub(calls), () => withPipeline(pl, { assigneeFilter: true, userGid: "U" }).advance("G1", "code", /** @type {any} */ ({ outcome: "advance" })));
  assert.ok(calls.some((c) => c.startsWith("POST https://app.asana.com/api/1.0/sections/S2/addTask")));
  assert.ok(!calls.some((c) => c.startsWith("PUT")), `expected no PUT; got:\n${calls.join("\n")}`);
});

test("a task that isn't ours is never completed (nor moved)", async () => {
  /** @type {string[]} */
  const calls = [];
  const pl = [
    { id: "code", sourceSectionGid: "S1", successSectionGid: "S2" },
    { id: "done", sourceSectionGid: "S2", manual: true, completeTask: true },
  ];
  await assert.rejects(
    withFetch(recordStub(calls, "OTHER"), () => withPipeline(pl, { assigneeFilter: true, userGid: "U" }).advance("G1", "code", /** @type {any} */ ({ outcome: "advance" }))),
    (e) => e instanceof MoveRefusedError && e.reason === "not_ours",
  );
  assert.ok(!calls.some((c) => c.startsWith("PUT") || c.startsWith("POST")), `expected no mutation; got:\n${calls.join("\n")}`);
});

// --- transient owner-check failures (#265): retried, and a persistent one is reported (thrown), never moved.
/** Stub: the owner GET answers `statuses[i]` on call i (then the last), 200 = the task as ours. @param {string[]} calls @param {number[]} statuses */
const flakyOwner = (calls, statuses) => {
  let n = 0;
  return (/** @type {string} */ u, /** @type {any} */ init) => {
    calls.push(`${init.method || "GET"} ${u}`);
    if (u.includes("opt_fields=assignee.gid")) {
      const status = statuses[Math.min(n++, statuses.length - 1)];
      if (status !== 200) return /** @type {any} */ ({ ok: false, status, json: async () => ({}) });
    }
    return ok({ data: { assignee: { gid: "U" } } });
  };
};

test("advance retries a transient owner-check 503 and then moves the task", async () => {
  /** @type {string[]} */
  const calls = [];
  await withFetch(flakyOwner(calls, [503, 200]), () => withPipeline(pipeline, { assigneeFilter: true, userGid: "U" }).advance("G1", "code", /** @type {any} */ ({ outcome: "advance" })));
  assert.equal(calls.filter((c) => c.includes("opt_fields=assignee.gid")).length, 2);
  assert.ok(calls.some((c) => c.startsWith("POST https://app.asana.com/api/1.0/sections/S2/addTask")), calls.join("\n"));
});

test("advance throws owner_check_failed (and never moves) on a persistent owner-check 503", async () => {
  /** @type {string[]} */
  const calls = [];
  await assert.rejects(
    withFetch(flakyOwner(calls, [503]), () => withPipeline(pipeline, { assigneeFilter: true, userGid: "U" }).advance("G1", "code", /** @type {any} */ ({ outcome: "advance" }))),
    (e) => e instanceof MoveRefusedError && e.code === "move_refused" && e.reason === "owner_check_failed",
  );
  assert.equal(calls.filter((c) => c.includes("opt_fields=assignee.gid")).length, 3);
  assert.ok(!calls.some((c) => c.includes("/addTask")), calls.join("\n"));
});
