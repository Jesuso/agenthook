import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// Re-check + close-on-board (#598): a Needs-you PR row whose board_done / merged webhook was
// missed is cleared by asking the tracker and forge again (src/recheck.js, the `recheck` op), or
// by closing the ticket on the tracker (`close_on_board`); `reconcile` re-checks only the rows
// already flagged with `prNeeds`. Offline: stub adapter + forge, the real emitter and buildRows.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createOps } from "../src/ops.js";
import { createStore } from "../src/store.js";
import { createQueue } from "../src/queue.js";
import { createEmitter } from "../src/events.js";
import { buildRows, readProfileState } from "../src/ui/rows.js";
import { isNeedsYou } from "../src/epics.js";
import { recheckLine, recheckRequest } from "../src/commands/recheck.js";

/**
 * A profile with PR rows, the real event log, a stub tracker and forge.
 * @param {{tasks?: Record<string, {completed?: boolean, assignedToUs?: boolean}>, prs?: Record<number, string>, complete?: boolean, forge?: boolean}} [o]
 */
function setup(o = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-recheck-"));
  const cfg = /** @type {any} */ ({
    name: "t", provider: "github", stateDir: dir, dataDir: dir, forge: { provider: "github", repository: "o/r" },
    pipeline: [{ id: "code" }, { id: "done", manual: true, completeOnMerge: true }],
  });
  const store = createStore(dir);
  const emit = createEmitter(dir);
  /** @type {string[]} */
  const calls = [];
  const tasks = o.tasks ?? {};
  /** @type {any} */
  const adapter = {
    fetchTask: async (/** @type {string} */ ref) => {
      calls.push(`fetch ${ref}`);
      const t = tasks[ref];
      if (!t) throw new Error("404");
      return { ref, name: `T ${ref}`, url: `u/${ref}`, completed: !!t.completed, assignedToUs: t.assignedToUs !== false };
    },
    listResting: async () => [],
    advance: async () => {},
    ...(o.complete !== false ? { complete: async (/** @type {string} */ ref) => void calls.push(`complete ${ref}`) } : {}),
  };
  const prs = o.prs ?? {};
  const forge = o.forge === false ? null : /** @type {any} */ ({
    describe: () => ({ name: "github" }),
    prState: async (/** @type {number} */ n) => {
      calls.push(`prState ${n}`);
      if (!(n in prs)) throw new Error("PR 502");
      return prs[n];
    },
  });
  /** @type {any[]} */
  const intaken = [];
  const ops = createOps({
    cfg, store, adapter, forge, emit,
    queue: createQueue(1, () => new Promise(() => {})),
    cancelRun: () => false,
    intake: (jobs) => (intaken.push(...jobs), jobs.length),
    heartbeat: { update: () => {} },
    pull: async () => {},
    isLocked: () => false,
  });
  /** A finished run of `ref` with PR `pr` (an idle row whose board is known open). @param {string} ref @param {number} pr @param {Record<string, any>} [meta] */
  const ran = (ref, pr, meta = {}) => {
    store.setRefMeta(ref, { pr, ...meta });
    emit("run_start", ref, "code");
    emit("run_end", ref, "code", { outcome: "advance" });
  };
  const rows = () => buildRows(cfg.name, readProfileState(dir), { repository: "o/r" });
  const rowOf = (/** @type {string} */ ref) => rows().find((r) => r.ref === ref);
  const events = () => readProfileState(dir).events;
  return { dir, cfg, store, ops, calls, intaken, emit, ran, rows, rowOf, events };
}

test("recheck: a completed ticket with a merged PR leaves Needs you — board_done + prState + merged, all via recheck", async () => {
  const s = setup({ tasks: { A: { completed: true } }, prs: { 7: "merged" } });
  s.ran("A", 7);
  assert.equal(s.rowOf("A")?.prNeeds, "awaitingMerge");
  const r = await s.ops.recheck({ ref: "A", actor: "test" });
  assert.deepEqual(r, { ref: "A", changed: ["board_done", "prState:merged", "merged"], unchanged: false });
  const row = s.rowOf("A");
  assert.equal(row?.status, "done");
  assert.equal(row?.prState, "merged");
  assert.equal(row?.prNeeds, null);
  assert.equal(isNeedsYou(/** @type {any} */ (row), true), false);
  const added = s.events().filter((e) => e.via === "recheck").map((e) => [e.event, e.ref, e.step]);
  assert.deepEqual(added, [["board_done", "A", ""], ["merged", "A", ""]]);
});

test("recheck: nothing new → unchanged:true, no event; a repeat never duplicates merged or board_done", async () => {
  const s = setup({ tasks: { A: { completed: false }, B: { completed: true } }, prs: { 1: "open", 2: "merged" } });
  s.ran("A", 1);
  s.ran("B", 2);
  const before = s.events().length;
  assert.deepEqual(await s.ops.recheck({ ref: "A" }), { ref: "A", changed: [], unchanged: true });
  assert.equal(s.events().length, before, "a no-op emits nothing");

  await s.ops.recheck({ ref: "B" });
  const n = s.events().length;
  assert.deepEqual(await s.ops.recheck({ ref: "B" }), { ref: "B", changed: [], unchanged: true });
  assert.equal(s.events().length, n);
  // Even if the local row lost its done (state edited away), the seen key stops a second board_done.
  s.store.setRefMeta("B", { prState: null });
  const again = await s.ops.recheck({ ref: "B" });
  assert.deepEqual(again.changed, ["prState:merged"], "the PR fact is re-recorded, the merged event is not");
  assert.equal(s.events().filter((e) => e.ref === "B" && e.event === "merged").length, 1);
  assert.equal(s.events().filter((e) => e.ref === "B" && e.event === "board_done").length, 1);
});

test("recheck: a re-run after the recorded done lets a later recheck record it again", async () => {
  const s = setup({ tasks: { A: { completed: true } }, prs: { 7: "open" } });
  s.ran("A", 7);
  assert.deepEqual((await s.ops.recheck({ ref: "A" })).changed, ["board_done"]);
  await new Promise((r) => setTimeout(r, 5)); // the key is the re-run's ts (ms): keep the two apart
  s.emit("run_start", "A", "code"); // reopened and re-run: the done no longer stands
  s.emit("run_end", "A", "code", { outcome: "advance" });
  assert.equal(s.rowOf("A")?.status, "idle");
  assert.deepEqual((await s.ops.recheck({ ref: "A" })).changed, ["board_done"]);
});

test("recheck: the live merge key already seen → prState recorded, no second merged event; never marks merged:<pr> itself", async () => {
  const s = setup({ tasks: { A: { completed: false }, B: { completed: false } }, prs: { 7: "merged", 8: "merged" } });
  s.ran("A", 7);
  s.ran("B", 8);
  s.store.markSeen("merged:7");
  assert.deepEqual((await s.ops.recheck({ ref: "A" })).changed, ["prState:merged"]);
  assert.equal(s.rowOf("A")?.prNeeds, "mergedOpen", "board still open: the reason moves on, Close on board applies");
  await s.ops.recheck({ ref: "B" });
  s.store.reloadSeen();
  assert.equal(s.store.hasSeen("merged:8"), false, "a later merge job (the bridge) must not be deduped away");
});

test("recheck: not ours, or a failed fetch → error, nothing recorded; running / queued refused", async () => {
  const s = setup({ tasks: { A: { completed: true, assignedToUs: false } }, prs: { 7: "merged" } });
  s.ran("A", 7);
  s.ran("gone", 8);
  const before = fs.readFileSync(path.join(s.dir, "events.jsonl"), "utf8");
  await assert.rejects(() => s.ops.recheck({ ref: "A" }), /not assigned to us — nothing recorded/);
  await assert.rejects(() => s.ops.recheck({ ref: "gone" }), /fetching it failed/);
  assert.equal(fs.readFileSync(path.join(s.dir, "events.jsonl"), "utf8"), before);
  assert.equal(s.store.getRefMeta("A")?.prState, undefined, "no PR fact either");
  s.store.setRunning("R", /** @type {any} */ ({ stepId: "code" }));
  await assert.rejects(() => s.ops.recheck({ ref: "R" }), /running/);
  s.store.addQueued({ kind: "pipeline", ref: "Q", stepId: "code", dedupKey: "q" });
  await assert.rejects(() => s.ops.recheck({ ref: "Q" }), /queued/);
  await assert.rejects(() => s.ops.recheck({}), /ref is required/);
});

test("recheck: a failed PR lookup is reported and changes no PR fact; the board fact still lands", async () => {
  const s = setup({ tasks: { A: { completed: true } }, prs: {} });
  s.ran("A", 7);
  const r = await s.ops.recheck({ ref: "A" });
  assert.deepEqual(r.changed, ["board_done"]);
  assert.match(r.prError, /PR #7: PR 502/);
});

test("recheck {all}: only rows already flagged with prNeeds are asked; a failing ref is reported, the rest still run", async () => {
  const s = setup({ tasks: { A: { completed: true }, B: { completed: false, assignedToUs: false }, C: { completed: true } }, prs: { 1: "merged", 2: "open" } });
  s.ran("A", 1);
  s.ran("B", 2);
  s.store.setRefMeta("C", { pr: 3 }); // no run in the tail: no reason, never asked
  s.ran("D", 4);
  s.emit("dismissed", "D", "", { by: "operator" }); // dismissed: no reason, never asked
  const r = await s.ops.recheck({ all: true });
  assert.deepEqual(r.rechecked.map((/** @type {any} */ x) => x.ref).sort(), ["A", "B"]);
  assert.match(r.rechecked.find((/** @type {any} */ x) => x.ref === "B").error, /not assigned to us/);
  assert.ok(!s.calls.includes("fetch C") && !s.calls.includes("fetch D"));
  assert.equal(s.rowOf("A")?.prNeeds, null);
});

test("reconcile / reconcile_merges re-check the flagged rows after the merge catch-up, and nothing else", async () => {
  const s = setup({ tasks: { A: { completed: true } }, prs: { 1: "merged" } });
  s.ran("A", 1);
  s.store.setRefMeta("old", { pr: 9 });
  const r = await s.ops.reconcile({});
  assert.equal(r.rechecked, 1);
  assert.ok(r.log.some((/** @type {string} */ l) => l.startsWith("[recheck] A — recorded board_done")));
  assert.deepEqual(s.calls.filter((c) => c.startsWith("fetch")), ["fetch A"]);
  const m = await s.ops.reconcile_merges({});
  assert.equal(m.rechecked, 0, "A is no longer flagged");
});

test("dismiss on a PR row: accepted, nulls prNeeds (Needs you false), a later run brings it back", async () => {
  const s = setup();
  s.ran("A", 1);
  assert.equal(s.rowOf("A")?.prNeeds, "awaitingMerge");
  assert.deepEqual(await s.ops.dismiss({ ref: "A" }), { ref: "A", dismissed: true });
  assert.equal(s.rowOf("A")?.prNeeds, null);
  assert.equal(isNeedsYou(/** @type {any} */ (s.rowOf("A")), true), false);
  s.emit("run_start", "A", "code");
  s.emit("run_end", "A", "code", { outcome: "advance" });
  assert.equal(s.rowOf("A")?.prNeeds, "awaitingMerge");
});

test("close_on_board: completes a mergedOpen/openOnDone ticket once, emits nothing; refuses other rows, no complete(), not ours", async () => {
  const s = setup({ tasks: { M: {}, D: { completed: true }, W: {}, X: { assignedToUs: false } } });
  s.ran("M", 1, { prState: "merged" });
  s.ran("D", 2);
  s.emit("board_done", "D", "", { via: "flag" });
  s.ran("W", 3); // awaitingMerge
  s.ran("C", 4, { prState: "closed" }); // closedUnmerged
  s.ran("X", 5, { prState: "merged" });
  assert.equal(s.rowOf("D")?.prNeeds, "openOnDone");
  const before = s.events().length;
  const r = await s.ops.close_on_board({ ref: "M" });
  assert.equal(r.completed, true);
  await s.ops.close_on_board({ ref: "D" });
  assert.deepEqual(s.calls.filter((c) => c.startsWith("complete")), ["complete M", "complete D"]);
  assert.equal(s.events().length, before, "board_done comes from the tracker's webhook, not from here");
  await assert.rejects(() => s.ops.close_on_board({ ref: "W" }), /awaitingMerge/);
  await assert.rejects(() => s.ops.close_on_board({ ref: "C" }), /closedUnmerged/);
  await assert.rejects(() => s.ops.close_on_board({ ref: "nope" }), /nothing to close/);
  await assert.rejects(() => s.ops.close_on_board({ ref: "X" }), /not assigned to us/);
  assert.ok(!s.calls.includes("complete X"));

  const bare = setup({ tasks: { M: {} }, complete: false });
  bare.ran("M", 1, { prState: "merged" });
  await assert.rejects(() => bare.ops.close_on_board({ ref: "M" }), /cannot close tickets/);
  assert.ok(!bare.calls.includes("fetch M"));
});

test("CLI recheck: <ref> or --all, never both; one line per ref", () => {
  assert.deepEqual(recheckRequest({ _: ["12"] }), { ref: "12" });
  assert.deepEqual(recheckRequest({ _: [], all: true }), { all: true });
  assert.equal(recheckRequest({ _: [] }), null);
  assert.equal(recheckRequest({ _: ["12"], all: true }), null);
  assert.equal(recheckLine({ ref: "1", changed: [], unchanged: true }), "1: nothing new");
  assert.equal(recheckLine({ ref: "1", changed: ["board_done", "merged"], unchanged: false }), "1: recorded board_done, merged");
  assert.equal(recheckLine({ ref: "1", error: "1 is not assigned to us — nothing recorded" }), "1: 1 is not assigned to us — nothing recorded");
  assert.equal(recheckLine({ ref: "1", changed: [], unchanged: true, prError: "PR #3: 502" }), "1: nothing new (PR lookup failed: PR #3: 502)");
});
