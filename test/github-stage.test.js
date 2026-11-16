import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// GitHub adapter (split from the former github.test.js): enterStage rework through a real
// crash-safe re-entry loop, forgeCatchup, the #506 stale-payload-snapshot cases, advance's
// add-before-remove ordering and not_ours guard, and currentStage.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createGithubAdapter } from "../src/trackers/github.js";
import { MoveRefusedError } from "../src/trackers/owner.js";
import { createStore } from "../src/store.js";
import { adapter, evt, makeStore, withDeps } from "./_github-helpers.js";

test("rework reaches done twice: run --force back to code, then re-advance into agent:done, fires a fresh labeled delivery each time (#672)", async () => {
  const pl = [
    { id: "code", sourceLabel: "agent:code", successLabel: "agent:review" },
    { id: "review", sourceLabel: "agent:review", successLabel: "agent:done" },
    { id: "done", sourceLabel: "agent:done", manual: true },
  ];
  // The fake issue: labels kept as a set, starting mid-pipeline in "agent:review".
  const labels = new Set(["agent:review"]);
  /** @type {any[]} */
  const doneJobs = [];
  let deliverySeq = 0;
  /** @type {any} */
  let a;
  const orig = global.fetch;
  // @ts-ignore - test stub
  global.fetch = async (/** @type {any} */ url, /** @type {any} */ init = {}) => {
    const u = decodeURIComponent(String(url));
    const method = init.method || "GET";
    if (u.endsWith("/user")) return /** @type {any} */ ({ ok: true, status: 200, json: async () => ({ login: "bot" }) });
    if (method === "GET" && /\/issues\/42$/.test(u)) {
      return /** @type {any} */ ({ ok: true, status: 200, json: async () => ({ state: "open", labels: [...labels].map((name) => ({ name })), assignees: [{ login: "bot" }] }) });
    }
    if (method === "POST" && u.endsWith("/issues/42/labels")) {
      const body = JSON.parse(init.body);
      // Real GitHub fires a `labeled` webhook only for a label NEWLY added to the issue.
      for (const name of body.labels) {
        if (labels.has(name)) continue;
        labels.add(name);
        deliverySeq++;
        const jobs = await a.processEvents(
          /** @type {any} */ (
            evt(
              { action: "labeled", label: { name }, issue: { number: 42, labels: [...labels].map((n) => ({ name: n })), assignees: [{ login: "bot" }] } },
              { "x-github-delivery": `guid-${deliverySeq}` },
            )
          ),
        );
        if (name === "agent:done") doneJobs.push(...jobs);
      }
      return /** @type {any} */ ({ ok: true, status: 200, json: async () => ({}) });
    }
    if (method === "POST" && u.endsWith("/issues/42/assignees")) return /** @type {any} */ ({ ok: true, status: 201, json: async () => ({}) });
    if (method === "DELETE") {
      labels.delete(decodeURIComponent(u.split("/").pop() || ""));
      return /** @type {any} */ ({ ok: true, status: 200, json: async () => ({}) });
    }
    return /** @type {any} */ ({ ok: true, status: 200, json: async () => [] });
  };
  try {
    a = createGithubAdapter(/** @type {any} */ ({ trigger: "@agent", pipeline: pl, providerConfig: { type: "github", token: "t", repository: "o/r", assigneeFilter: false } }), /** @type {any} */ (makeStore()));
    // review finishes — the issue's FIRST genuine arrival at agent:done.
    await a.advance("42", "review", { outcome: "advance" });
    assert.equal(doneJobs.length, 1, "the first arrival at agent:done produced its own job");
    assert.equal(doneJobs[0].stepId, "done");

    // `agenthook run 42 code --force`: enters "code" and must drop the stale agent:done.
    await a.enterStage("42", "code", { assign: false });
    assert.ok(!labels.has("agent:done"), "agent:done must be dropped on re-entry into code");
    // review finishes again and advances back into agent:done — a fresh label add this time.
    await a.advance("42", "review", { outcome: "advance" });
    assert.equal(doneJobs.length, 2, "the second arrival at agent:done produced its own job");
    assert.equal(doneJobs[1].stepId, "done");
    assert.notEqual(doneJobs[1].dedupKey, doneJobs[0].dedupKey, "a fresh delivery id, not the first done arrival's");

    // Same x-github-delivery delivered twice yields the identical dedupKey intake's `seen`
    // store dedups on — i.e. a re-delivered webhook (not a genuine re-entry) stays coalesced.
    const sameDelivery = doneJobs[1].dedupKey.slice("secmove:".length);
    const replay = await a.processEvents(
      /** @type {any} */ (
        evt({ action: "labeled", label: { name: "agent:done" }, issue: { number: 42, labels: [...labels].map((n) => ({ name: n })), assignees: [{ login: "bot" }] } }, { "x-github-delivery": sameDelivery })
      ),
    );
    assert.equal(replay[0].dedupKey, doneJobs[1].dedupKey);

    // Drive both deliveries through the real dedup gate `intake` uses (disk-backed
    // seen store): the genuine second arrival is accepted, the replayed delivery is not.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-github-672-"));
    const store = createStore(dir);
    const accept = (/** @type {any} */ job) => {
      if (!job.dedupKey || store.hasSeen(job.dedupKey)) return false;
      store.markSeen(job.dedupKey);
      return true;
    };
    assert.equal(accept(doneJobs[1]), true, "the second genuine done arrival is accepted");
    assert.equal(accept(replay[0]), false, "the re-delivered webhook (same x-github-delivery) is dropped");
  } finally {
    global.fetch = orig;
  }
});

test("forgeCatchup exposes the matched step when the issue rests in a source label", async () => {
  const orig = global.fetch;
  // @ts-ignore - test stub
  global.fetch = async (url) => {
    if (String(url).includes("/issues/42")) {
      return /** @type {any} */ ({ ok: true, status: 200, json: async () => ({ number: 42, labels: [{ name: "agent:code" }], assignees: [] }) });
    }
    return /** @type {any} */ ({ ok: true, status: 200, json: async () => ({}) });
  };
  try {
    const forged = await adapter().forgeCatchup?.("42");
    assert.equal(forged?.stepId, "code");
    assert.equal(forged?.dedupKey, "step:code:42");
  } finally {
    global.fetch = orig;
  }
});

test("forgeCatchup leaves stepId undefined when the issue is in no source label (catchup detects the no-op)", async () => {
  const orig = global.fetch;
  // @ts-ignore - test stub
  global.fetch = async (url) => {
    if (String(url).includes("/issues/7")) {
      return /** @type {any} */ ({ ok: true, status: 200, json: async () => ({ number: 7, labels: [{ name: "wontfix" }], assignees: [] }) });
    }
    return /** @type {any} */ ({ ok: true, status: 200, json: async () => ({}) });
  };
  try {
    const forged = await adapter().forgeCatchup?.("7");
    assert.equal(forged?.stepId, undefined);
    assert.equal(forged?.dedupKey, "issue:7:opened");
  } finally {
    global.fetch = orig;
  }
});

// --- #506: delayed delivery with a stale payload label/assignee snapshot ---

const triagePipeline = [
  { id: "triage", sourceLabel: "agent:triage", successLabel: "agent:code" },
  { id: "code", sourceLabel: "agent:code", successLabel: "agent:review", failureLabel: "agent:blocked" },
  { id: "review", sourceLabel: "agent:review", successLabel: "agent:done" },
];
/** Adapter with a 3-step pipeline (triage -> code -> review), assigneeFilter off. */
function triageAdapter() {
  return createGithubAdapter(
    /** @type {any} */ ({ trigger: "@agent", pipeline: triagePipeline, providerConfig: { type: "github", token: "t", repository: "o/r", assigneeFilter: false } }),
    /** @type {any} */ (makeStore()),
  );
}

test("assigned event ignores a stale payload label snapshot and routes by the live issue", async () => {
  const restore = withDeps((u) =>
    u.endsWith("/issues/501") ? /** @type {any} */ ({ ok: true, status: 200, json: async () => ({ state: "open", labels: [{ name: "agent:code" }] }) }) : null,
  );
  try {
    const jobs = await triageAdapter().processEvents(
      /** @type {any} */ (evt({ action: "assigned", issue: { number: 501, labels: [{ name: "agent:triage" }], assignees: [] } })),
    );
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].stepId, "code");
    assert.equal(jobs[0].dedupKey, "step:code:501");
  } finally {
    restore();
  }
});

test("opened event: a closed live issue yields no job", async () => {
  const restore = withDeps((u) =>
    u.endsWith("/issues/55") ? /** @type {any} */ ({ ok: true, status: 200, json: async () => ({ state: "closed", labels: [{ name: "agent:code" }] }) }) : null,
  );
  try {
    const jobs = await adapter().processEvents(/** @type {any} */ (evt({ action: "opened", issue: { number: 55, labels: [{ name: "agent:code" }], assignees: [] } })));
    assert.equal(jobs.length, 0);
  } finally {
    restore();
  }
});

test("assigned event: a live issue no longer assigned to us (assigneeFilter on) yields no job", async () => {
  const a = adapter({ assigneeFilter: true, assigneeLogin: "bot" });
  const restore = withDeps((u) =>
    u.endsWith("/issues/56")
      ? /** @type {any} */ ({ ok: true, status: 200, json: async () => ({ state: "open", labels: [{ name: "agent:code" }], assignees: [{ login: "someone-else" }] }) })
      : null,
  );
  try {
    const jobs = await a.processEvents(/** @type {any} */ (evt({ action: "assigned", issue: { number: 56, labels: [{ name: "agent:code" }], assignees: [{ login: "bot" }] } })));
    assert.equal(jobs.length, 0);
  } finally {
    restore();
  }
});

test("opened event: a failed live fetch (500) yields no job (fail closed)", async () => {
  const restore = withDeps((u) => (u.endsWith("/issues/57") ? /** @type {any} */ ({ ok: false, status: 500, json: async () => ({}) }) : null));
  try {
    const jobs = await adapter().processEvents(/** @type {any} */ (evt({ action: "opened", issue: { number: 57, labels: [{ name: "agent:code" }], assignees: [] } })));
    assert.equal(jobs.length, 0);
  } finally {
    restore();
  }
});

test("replay-then-webhook ordering: a forged catchup and a late assigned webhook share the dedupKey while the step is live; once the issue has moved on, the late webhook is a no-op", async () => {
  const a = adapter();
  const restoreUser = withDeps(() => null); // lets ourLogin()'s /user call in forgeCatchup resolve harmlessly
  /** @type {any} */
  let forged;
  try {
    forged = await a.forgeCatchup("99", "code");
  } finally {
    restoreUser();
  }
  assert.equal(forged.dedupKey, "step:code:99");

  const restoreLive = withDeps((u) =>
    u.endsWith("/issues/99") ? /** @type {any} */ ({ ok: true, status: 200, json: async () => ({ state: "open", labels: [{ name: "agent:code" }], assignees: [] }) }) : null,
  );
  try {
    const jobs = await a.processEvents(/** @type {any} */ (evt({ action: "assigned", issue: { number: 99, labels: [{ name: "agent:code" }], assignees: [] } })));
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].dedupKey, forged.dedupKey);
  } finally {
    restoreLive();
  }

  const restoreMoved = withDeps((u) =>
    u.endsWith("/issues/99") ? /** @type {any} */ ({ ok: true, status: 200, json: async () => ({ state: "open", labels: [{ name: "agent:review" }], assignees: [] }) }) : null,
  );
  try {
    const jobs = await a.processEvents(/** @type {any} */ (evt({ action: "assigned", issue: { number: 99, labels: [{ name: "agent:code" }], assignees: [] } })));
    assert.equal(jobs.length, 0);
  } finally {
    restoreMoved();
  }
});

test("advance adds the target label before removing the source (crash-safe)", async () => {
  /** @type {string[]} */
  const calls = [];
  const orig = global.fetch;
  // @ts-ignore - test stub
  global.fetch = async (url, init = {}) => {
    calls.push(`${init.method || "GET"} ${url}`);
    return /** @type {any} */ ({ ok: true, status: 200, json: async () => ({}) });
  };
  try {
    await adapter().advance("42", "code", { outcome: "advance" });
  } finally {
    global.fetch = orig;
  }
  const add = calls.findIndex((c) => c.startsWith("POST") && c.includes("/issues/42/labels"));
  const del = calls.findIndex((c) => c.startsWith("DELETE") && c.includes("/issues/42/labels/agent%3Acode"));
  assert.ok(add >= 0, `expected an add-label POST; got:\n${calls.join("\n")}`);
  assert.ok(del >= 0, `expected a remove-label DELETE; got:\n${calls.join("\n")}`);
  assert.ok(add < del, `add must precede remove; got:\n${calls.join("\n")}`);
});

test("advance throws not_ours (and never relabels) for an issue assigned to someone else", async () => {
  /** @type {string[]} */
  const calls = [];
  const orig = global.fetch;
  // @ts-ignore - test stub
  global.fetch = async (url, init = {}) => {
    calls.push(`${init.method || "GET"} ${url}`);
    return /** @type {any} */ ({ ok: true, status: 200, json: async () => ({ assignees: [{ login: "someone-else" }] }) });
  };
  try {
    await assert.rejects(
      adapter({ assigneeFilter: true, assigneeLogin: "bot" }).advance("42", "code", { outcome: "advance" }),
      (e) => e instanceof MoveRefusedError && e.reason === "not_ours",
    );
  } finally {
    global.fetch = orig;
  }
  assert.ok(!calls.some((c) => !c.startsWith("GET")), `expected no mutation; got:\n${calls.join("\n")}`);
});

test("currentStage returns ANY pipeline label the issue carries (not just source) — backs run's guard", async () => {
  const orig = global.fetch;
  // The issue rests in the SUCCESS label (agent:review), not the source — still in-flight.
  // @ts-ignore - test stub
  global.fetch = async () => /** @type {any} */ ({ ok: true, status: 200, json: async () => ({ labels: [{ name: "agent:review" }, { name: "bug" }] }) });
  try {
    assert.equal(await adapter().currentStage?.("42"), "agent:review");
  } finally {
    global.fetch = orig;
  }
});

test("currentStage is null when the issue carries no pipeline label (clean backlog item)", async () => {
  const orig = global.fetch;
  // @ts-ignore - test stub
  global.fetch = async () => /** @type {any} */ ({ ok: true, status: 200, json: async () => ({ labels: [{ name: "wontfix" }] }) });
  try {
    assert.equal(await adapter().currentStage?.("7"), null);
  } finally {
    global.fetch = orig;
  }
});

