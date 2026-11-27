import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// ops.js ticket_add and harness_reset — creating new tickets through the adapter and the
// harness health breaker (clearing a down harness and starting its waiting job).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createOps } from "../src/ops.js";
import { createStore } from "../src/store/index.js";
import { createQueue } from "../src/queue.js";
import { startControl } from "../src/control/server.js";
import { controlRequest } from "../src/control/client.js";
import { setup } from "./_ops-helpers.js";

test("ticket_add: creates the item through adapter.createTask; audit logs the body's length, never its text", async () => {
  /** @type {any[]} */
  const created = [];
  const s = setup({
    adapter: {
      createTask: async (/** @type {any} */ t) => (created.push(t), { ref: "4", stage: "review", stepId: t.stepId ?? "code" }),
    },
  });
  const r = await s.ops.ticket_add({ actor: "cli", title: "  fix the thing ", body: "secret spec text", step: "review" });
  assert.deepEqual(r, { ref: "4", step: "review", stage: "review" });
  assert.deepEqual(created, [{ name: "fix the thing", description: "secret spec text", stepId: "review" }]);
  // blockedBy: only strings pass through; the adapter's open blockers come back on the result.
  const b = setup({ adapter: { createTask: async (/** @type {any} */ t) => (created.push(t), { ref: "5", stage: "code", stepId: "code", blockedBy: t.blockedBy }) } });
  assert.deepEqual(await b.ops.ticket_add({ title: "dep", blockedBy: ["3", 7, "4"] }), { ref: "5", step: "code", stage: "code", blockedBy: ["3", "4"] });
  assert.deepEqual(created.at(-1), { name: "dep", description: "", blockedBy: ["3", "4"] });
  const [line] = s.audit();
  assert.equal(line.cmd, "ticket_add");
  assert.equal(line.ok, true);
  assert.equal(line.args.bodyChars, 16);
  assert.equal(line.args.title, "  fix the thing ");
  assert.ok(!JSON.stringify(line).includes("secret spec text"), "body text must not reach the audit log");
});
test("ticket_add: refuses (exposed) without createTask or without a title; adapter errors surface", async () => {
  const none = setup();
  await assert.rejects(() => none.ops.ticket_add({ title: "x" }), (e) => e.expose === true && /has no ticket add/.test(e.message));
  assert.equal(none.audit()[0].ok, false);
  const s = setup({ adapter: { createTask: async () => { throw new Error('local: step "done" is manual'); } } });
  await assert.rejects(() => s.ops.ticket_add({ title: " " }), /title is required/);
  await assert.rejects(() => s.ops.ticket_add({ title: "x", step: "done" }), /is manual/);
});
test("harness_reset: clears a down harness (harness_up), starts its waiting job; errors on an unknown name or a profile without harnesses (MCP + control socket)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthook-ops-harness-"));
  const cfg = /** @type {any} */ ({ name: "t", provider: "github", stateDir: dir, dataDir: dir, pipeline: [{ id: "code", harness: "local" }], harnesses: { local: { maxConcurrent: 1 } } });
  const store = createStore(dir);
  /** @type {any[]} */ const events = [];
  /** @type {string[]} */ const started = [];
  const until = new Date(Date.now() + 10 * 60000).toISOString();
  const queue = createQueue(2, async (j) => (started.push(j.ref), new Promise(() => {})), undefined, undefined, {}, {
    steps: { code: { harnesses: ["local"] } },
    caps: { local: 1 },
    health: { local: { until, strikes: 1, reason: "spawn failed: ENOENT" } },
    onHarnessUp: (name) => events.push(["harness_up", name]),
  });
  const deps = /** @type {any} */ ({ cfg, store, forge: null, queue, adapter: {}, cancelRun: () => false, intake: () => 0, emit: () => {}, heartbeat: { update: () => {} }, pull: async () => {}, isLocked: () => false });
  const ops = createOps(deps);
  queue.enqueue({ kind: "pipeline", ref: "A", stepId: "code", dedupKey: "A:code" });
  assert.deepEqual(started, [], "local is down: A waits");
  assert.equal(queue.state().capped, 1);
  await assert.rejects(() => ops.harness_reset({ harness: "nope" }), /no harness "nope" \(have: local\)/);
  await assert.rejects(() => ops.harness_reset({}), /harness/);
  const sock = path.join(dir, "c.sock");
  const control = await startControl(/** @type {any} */ ({ name: "t", controlSock: sock, pidFile: path.join(dir, "pid") }), { startedAt: "x", commands: ops });
  try {
    const r = await controlRequest(sock, "harness_reset", { harness: "local", actor: "t" }, { timeoutMs: 2000 });
    assert.equal(r.ok, true);
    assert.equal(r.result.reset, true);
    assert.equal(r.result.harnesses.local.state, "up");
  } finally {
    control?.close();
  }
  assert.deepEqual(events, [["harness_up", "local"]]);
  assert.deepEqual(started, ["A"], "the waiting job started");
  assert.equal((await ops.harness_reset({ harness: "local" })).reset, false, "already up");
  const audit = fs.readFileSync(path.join(dir, "control-audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(audit.map((a) => [a.cmd, a.ok]), [["harness_reset", false], ["harness_reset", false], ["harness_reset", true], ["harness_reset", true]]);
  const plain = setup();
  await assert.rejects(() => plain.ops.harness_reset({ harness: "local" }), /this profile has no harnesses/);
});
