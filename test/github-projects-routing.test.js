import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// GitHub Projects v2 adapter — pure-unit coverage (no network): HMAC authenticate,
// Status-driven processEvents routing (created + edited, with the non-Status guards),
// and advance setting the Status single-select option per outcome, plus fetchTask /
// listResting / forgeCatchup. The adapter is GraphQL-only, so the fetch stub routes by
// inspecting the posted `query` string.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { MoveRefusedError } from "../src/trackers/owner.js";
import { adapter, stubGraphql, evt, STATUS_FIELD_ID, STATUS_OPTIONS, PROJECT_ID } from "./_github-projects-helpers.js";

test("authenticate accepts a correctly signed body", () => {
  const a = adapter({ webhookSecret: "s3cr3t" });
  const body = JSON.stringify({ hello: 1 });
  const sig = "sha256=" + crypto.createHmac("sha256", "s3cr3t").update(body).digest("hex");
  assert.equal(a.authenticate(/** @type {any} */ ({ rawBody: body, headers: { "x-hub-signature-256": sig } })).type, "accept");
});

test("authenticate rejects a bad signature", () => {
  const a = adapter({ webhookSecret: "s3cr3t" });
  assert.equal(a.authenticate(/** @type {any} */ ({ rawBody: "{}", headers: { "x-hub-signature-256": "sha256=deadbeef" } })).type, "reject");
});

test("authenticate accepts unsigned when webhookSecret:false", () => {
  const a = adapter({ webhookSecret: false });
  assert.equal(a.authenticate(/** @type {any} */ ({ rawBody: "{}", headers: {} })).type, "accept");
});

test("a status-change edited event routes to the step whose sourceStatus the item now rests in", async () => {
  const { captured, restore } = stubGraphql({ status: "In Progress" });
  try {
    const jobs = await adapter().processEvents(
      /** @type {any} */ (
        evt(
          {
            action: "edited",
            projects_v2_item: { node_id: "PVTI_42", content_type: "Issue" },
            changes: { field_value: { field_node_id: STATUS_FIELD_ID, field_type: "single_select" } },
          },
          { "x-github-delivery": "guid-1" },
        )
      ),
    );
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].ref, "42");
    assert.equal(jobs[0].stepId, "code");
    assert.equal(jobs[0].dedupKey, "secmove:guid-1");
  } finally {
    restore();
  }
  assert.ok(captured.calls > 0);
});

test("a created event routes by the item's current Status (state-based dedup key)", async () => {
  const { restore } = stubGraphql({ status: "In Progress" });
  try {
    const jobs = await adapter().processEvents(
      /** @type {any} */ (evt({ action: "created", projects_v2_item: { node_id: "PVTI_42", content_type: "Issue" } })),
    );
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].dedupKey, "step:code:42");
  } finally {
    restore();
  }
});

test("a non-single-select edit yields no job (and never queries the item)", async () => {
  const { captured, restore } = stubGraphql();
  try {
    const jobs = await adapter().processEvents(
      /** @type {any} */ (
        evt({ action: "edited", projects_v2_item: { node_id: "PVTI_42", content_type: "Issue" }, changes: { field_value: { field_type: "text" } } })
      ),
    );
    assert.equal(jobs.length, 0);
    assert.equal(captured.calls, 0); // short-circuited before any GraphQL
  } finally {
    restore();
  }
});

test("a single-select edit on a DIFFERENT field (not Status) yields no job", async () => {
  const { restore } = stubGraphql();
  try {
    const jobs = await adapter().processEvents(
      /** @type {any} */ (
        evt({
          action: "edited",
          projects_v2_item: { node_id: "PVTI_42", content_type: "Issue" },
          changes: { field_value: { field_node_id: "PVTSSF_priority", field_type: "single_select" } },
        })
      ),
    );
    assert.equal(jobs.length, 0);
  } finally {
    restore();
  }
});

test("#35: edited whose field_node_id differs from the Status id but resolves by NAME to Status still fires", async () => {
  // The webhook's field_node_id and the GraphQL field id differ in format, yet both name
  // the same Status field. The old hard id-equality gate would silently drop this; we now
  // confirm identity by name and route the (real) Status change.
  const { restore } = stubGraphql({ status: "In Progress" });
  try {
    const jobs = await adapter().processEvents(
      /** @type {any} */ (
        evt(
          {
            action: "edited",
            projects_v2_item: { node_id: "PVTI_42", content_type: "Issue" },
            changes: { field_value: { field_node_id: "PVTSSF_status_alt", field_type: "single_select" } },
          },
          { "x-github-delivery": "guid-alt" },
        )
      ),
    );
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].stepId, "code");
    assert.equal(jobs[0].dedupKey, "secmove:guid-alt");
  } finally {
    restore();
  }
});

test("#35: edited whose changed field id is unknown (name unresolved) falls through to the live Status re-read", async () => {
  // Fail-open-with-log: an id we can't match AND can't name should not silently stall; it
  // routes by the item's actual current Status (here "In Progress" → the code step).
  const { restore } = stubGraphql({ status: "In Progress" });
  try {
    const jobs = await adapter().processEvents(
      /** @type {any} */ (
        evt({
          action: "edited",
          projects_v2_item: { node_id: "PVTI_42", content_type: "Issue" },
          changes: { field_value: { field_node_id: "PVTSSF_unknown", field_type: "single_select" } },
        })
      ),
    );
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].stepId, "code");
  } finally {
    restore();
  }
});

test("an item whose Status matches no step yields no job", async () => {
  const { restore } = stubGraphql({ status: "Done" });
  try {
    const jobs = await adapter().processEvents(
      /** @type {any} */ (evt({ action: "created", projects_v2_item: { node_id: "PVTI_42", content_type: "Issue" } })),
    );
    assert.equal(jobs.length, 0);
  } finally {
    restore();
  }
});

test("a non-issue item (draft/PR) yields no job", async () => {
  const { restore } = stubGraphql();
  try {
    const jobs = await adapter().processEvents(
      /** @type {any} */ (evt({ action: "created", projects_v2_item: { node_id: "PVTI_draft", content_type: "DraftIssue" } })),
    );
    assert.equal(jobs.length, 0);
  } finally {
    restore();
  }
});

test("a non-projects_v2_item delivery is ignored", async () => {
  const jobs = await adapter().processEvents(
    /** @type {any} */ (evt({ action: "created", projects_v2_item: { node_id: "PVTI_42" } }, { "x-github-event": "issues" })),
  );
  assert.equal(jobs.length, 0);
});

test("an item not assigned to us yields no job (fail-closed scoping)", async () => {
  const { restore } = stubGraphql({ status: "In Progress", assignees: ["someone-else"], viewer: "bot" });
  try {
    // assigneeFilter default (true): the issue's assignee must be the viewer login.
    const jobs = await adapter({ assigneeFilter: true }).processEvents(
      /** @type {any} */ (evt({ action: "created", projects_v2_item: { node_id: "PVTI_42", content_type: "Issue" } })),
    );
    assert.equal(jobs.length, 0);
  } finally {
    restore();
  }
});

test("advance sets the Status single-select to the SUCCESS option (updateProjectV2ItemFieldValue)", async () => {
  const { captured, restore } = stubGraphql();
  try {
    await adapter().advance("42", "code", { outcome: "advance" });
  } finally {
    restore();
  }
  assert.ok(captured.mutation, "expected an updateProjectV2ItemFieldValue mutation");
  assert.equal(captured.mutation.project, PROJECT_ID);
  assert.equal(captured.mutation.item, "PVTI_42");
  assert.equal(captured.mutation.field, STATUS_FIELD_ID);
  assert.equal(captured.mutation.option, STATUS_OPTIONS["In Review"]);
});

test("advance maps fail → failureStatus option", async () => {
  const { captured, restore } = stubGraphql();
  try {
    await adapter().advance("42", "code", { outcome: "fail" });
  } finally {
    restore();
  }
  assert.equal(captured.mutation.option, STATUS_OPTIONS["Blocked"]);
});

test("advance is a no-op when the target status has no matching Status option", async () => {
  const { captured, restore } = stubGraphql();
  try {
    // holdStatus isn't set on the step → outcome hold resolves to no status → no mutation.
    await adapter().advance("42", "code", { outcome: "hold" });
  } finally {
    restore();
  }
  assert.equal(captured.mutation, null);
});

test("advance refuses to move an item whose issue isn't ours (fail-closed)", async () => {
  const { captured, restore } = stubGraphql({ assignees: ["someone-else"], viewer: "bot" });
  try {
    await assert.rejects(adapter({ assigneeFilter: true }).advance("42", "code", { outcome: "advance" }), (e) => e instanceof MoveRefusedError && e.reason === "not_ours");
  } finally {
    restore();
  }
  assert.equal(captured.mutation, null);
});

test("fetchTask maps the project item's issue to neutral Task fields", async () => {
  const { restore } = stubGraphql({ status: "In Progress" });
  let task;
  try {
    task = await adapter().fetchTask("42");
  } finally {
    restore();
  }
  assert.equal(task.ref, "42");
  assert.equal(task.name, "Wire up the thing");
  assert.equal(task.description, "do it");
  assert.equal(task.completed, false);
  assert.equal(task.url, "https://github.com/acme/repo/issues/42");
});

test("listResting yields one job per open issue resting in a step's source Status", async () => {
  const { restore } = stubGraphql({ status: "In Progress" });
  let jobs;
  try {
    jobs = await adapter().listResting();
  } finally {
    restore();
  }
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].stepId, "code");
  assert.equal(jobs[0].dedupKey, "reconcile:code:42");
});

test("forgeCatchup exposes the matched step when the item rests in a source Status", async () => {
  const { restore } = stubGraphql({ status: "In Progress" });
  let forged;
  try {
    forged = await adapter().forgeCatchup?.("42");
  } finally {
    restore();
  }
  assert.equal(forged?.stepId, "code");
  assert.equal(forged?.dedupKey, "step:code:42");
  assert.equal(forged?.path, "/github-projects/");
  // The forged event is a `created` projects_v2_item carrying the item's node id.
  const ev = JSON.parse(String(forged?.body));
  assert.equal(ev.action, "created");
  assert.equal(ev.projects_v2_item.node_id, "PVTI_42");
});

test("forgeCatchup leaves stepId undefined when the item's Status maps to no step (catchup detects the no-op)", async () => {
  const { restore } = stubGraphql({ status: "Done" });
  let forged;
  try {
    forged = await adapter().forgeCatchup?.("42");
  } finally {
    restore();
  }
  assert.equal(forged?.stepId, undefined);
  assert.equal(forged?.dedupKey, "issue:42:created");
});
