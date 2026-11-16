import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// ops.js read/cache surface: board + prs (and their shared cache invalidation on writes), digest,
// summary, and epics — the cached, read-mostly side of the operator surface (control-plane
// mutations like pause/cancel/retry live in ops-control.test.js, tickets in ops-misc.test.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createOps } from "../src/ops.js";
import { createEpicChanged } from "../src/epic-changed.js";
import { createStore } from "../src/store.js";
import { createQueue } from "../src/queue.js";
import { setup } from "./_ops-helpers.js";

test("board: resting + backlog per step with refmeta labels, cached; prs needs a forge", async () => {
  let calls = 0;
  const s = setup({
    adapter: {
      listResting: async () => { calls++; return [{ kind: "pipeline", ref: "1", stepId: "code" }, { kind: "pipeline", ref: "2", stepId: "triage" }]; },
      listQueued: async () => ["3"],
    },
  });
  s.store.setRefMeta("1", { displayId: "#1", title: "One" });
  const b = await s.ops.board({});
  assert.deepEqual(b.steps.map((x) => x.step), ["triage", "code"], "manual steps excluded");
  assert.deepEqual(b.steps[1].resting, [{ ref: "1", id: "#1", title: "One" }]);
  assert.deepEqual(b.steps[0].backlog, [{ ref: "3" }]);
  await s.ops.board({});
  assert.equal(calls, 1, "cached");
  await s.ops.board({ fresh: true });
  assert.equal(calls, 2);
  await assert.rejects(() => s.ops.prs({}), /no forge/);
  const withForge = setup({ forge: { listAgentPrs: async () => [{ number: 4, ref: "1", ci: "success" }] } });
  assert.equal((await withForge.ops.prs({})).prs[0].number, 4);
});
test("writes drop the cached board/prs, so the next read sees the post-write board", async () => {
  let calls = 0;
  const s = setup({
    adapter: { listResting: async () => { calls++; return []; }, advance: async () => {} },
    forge: { listAgentPrs: async () => [] },
  });
  await s.ops.board({});
  await s.ops.board({});
  assert.equal(calls, 1, "cached");
  s.store.setHeld("H", { stepId: "code", heldAt: "x" });
  await s.ops.cancel({ ref: "H" });
  await s.ops.board({});
  assert.equal(calls, 2, "cancel invalidated the cache");
});
test("board fetches the per-step backlogs in parallel", async () => {
  let inFlight = 0;
  let peak = 0;
  const s = setup({
    pipeline: [{ id: "a", queueLabel: "qa" }, { id: "b", queueLabel: "qb" }, { id: "c", queueLabel: "qc" }, { id: "done", manual: true }],
    adapter: {
      listResting: async () => [],
      listQueued: async () => { inFlight++; peak = Math.max(peak, inFlight); await new Promise((r) => setTimeout(r, 15)); inFlight--; return []; },
    },
  });
  await s.ops.board({});
  assert.equal(peak, 3);
});
test("prs: marks mine from adapter.ownership; a non-fresh repeat within 5 min does not re-resolve; fresh:true does", async () => {
  /** @type {string[]} */
  const calls = [];
  const adapter = {
    ownership: async (/** @type {string} */ ref) => {
      calls.push(ref);
      return ref === "1" ? "ours" : "not_ours";
    },
  };
  const forge = { listAgentPrs: async () => [{ number: 1, ref: "1", ci: "success" }, { number: 2, ref: "2", ci: "success" }] };
  const s = setup({ adapter, forge });
  const r1 = await s.ops.prs({});
  assert.deepEqual(r1.prs.map((/** @type {any} */ p) => p.mine), [true, false]);
  assert.deepEqual(calls, ["1", "2"]);
  s.store.setHeld("ZZ", { stepId: "code", heldAt: "x" }); // bust the 30s board/prs ttl without fresh
  await s.ops.cancel({ ref: "ZZ" });
  await s.ops.prs({});
  assert.deepEqual(calls, ["1", "2"], "within 5 min, a repeat uncached-board read still reuses the ownership cache");
  await s.ops.prs({ fresh: true });
  assert.deepEqual(calls, ["1", "2", "1", "2"], "fresh:true clears the ownership cache and re-resolves");
});
test("prs: learns merged/closed for known PRs missing from the open list; open ones are not looked up; a failed lookup changes nothing", async () => {
  /** @type {number[]} */
  const looked = [];
  const forge = {
    listAgentPrs: async () => [{ number: 1, ref: "1", ci: "success" }],
    prState: async (/** @type {number} */ n) => {
      looked.push(n);
      if (n === 4) throw new Error("boom");
      return n === 2 ? "merged" : n === 3 ? "closed" : "open";
    },
  };
  const s = setup({ forge });
  s.store.setRefMeta("1", { pr: 1, title: "open one" });
  s.store.setRefMeta("2", { pr: 2, title: "merged one" });
  s.store.setRefMeta("3", { pr: 3 });
  s.store.setRefMeta("4", { pr: 4, title: "lookup fails" });
  s.store.setRefMeta("5", { pr: 5 });
  s.store.setRefMeta("6", { pr: 6, prState: "merged" });
  s.store.setRefMeta("7", { title: "no PR" });
  const r = await s.ops.prs({});
  assert.deepEqual(r.prs.map((/** @type {any} */ p) => p.number), [1]);
  assert.deepEqual(looked.sort(), [2, 3, 4, 5], "open (#1), already-terminal (#6) and PR-less refs are not looked up");
  const meta = s.store.listRefMeta();
  assert.deepEqual(meta["2"], { pr: 2, title: "merged one", prState: "merged" });
  assert.equal(meta["3"].prState, "closed");
  assert.deepEqual(meta["4"], { pr: 4, title: "lookup fails" });
  assert.equal(meta["5"].prState, undefined, "still open → nothing written");
  looked.length = 0;
  await s.ops.prs({ fresh: true });
  assert.deepEqual(looked.sort(), [4, 5], "terminal states are not re-looked up");
});
test("prs: a learned terminal state whose PR shows open again (reopened) is dropped", async () => {
  const s = setup({ forge: { listAgentPrs: async () => [{ number: 1, ref: "1", ci: "success" }], prState: async () => "closed" } });
  s.store.setRefMeta("1", { pr: 1, title: "reopened", prState: "closed" });
  await s.ops.prs({});
  assert.deepEqual(s.store.getRefMeta("1"), { pr: 1, title: "reopened" });
});
test("prs: a forge without prState still lists PRs; lookups are bounded per fill", async () => {
  const plain = setup({ forge: { listAgentPrs: async () => [] } });
  plain.store.setRefMeta("1", { pr: 1 });
  assert.deepEqual((await plain.ops.prs({})).prs, []);
  let n = 0;
  const s = setup({ forge: { listAgentPrs: async () => [], prState: async () => (n++, "open") } });
  for (let i = 1; i <= 30; i++) s.store.setRefMeta(String(i), { pr: i });
  await s.ops.prs({});
  assert.equal(n, 20);
});
test("prs: fresh:true clears the ownership cache so a reassignment is re-resolved", async () => {
  /** @type {string[]} */
  const calls = [];
  let flip = "ours";
  const adapter = { ownership: async (/** @type {string} */ ref) => (calls.push(ref), flip) };
  const forge = { listAgentPrs: async () => [{ number: 1, ref: "1", ci: "success" }] };
  const s = setup({ adapter, forge });
  assert.equal((await s.ops.prs({})).prs[0].mine, true);
  flip = "not_ours";
  assert.equal((await s.ops.prs({})).prs[0].mine, true, "cached within 5 min, old board cache too");
  assert.equal((await s.ops.prs({ fresh: true })).prs[0].mine, false, "fresh clears both caches");
  assert.equal(calls.length, 2);
});
test("prs: check_failed (or a thrown error) omits mine and is never cached", async () => {
  let fail = true;
  const adapter = {
    ownership: async (/** @type {string} */ ref) => {
      if (fail) throw new Error("boom");
      return "ours";
    },
  };
  const forge = { listAgentPrs: async () => [{ number: 1, ref: "1", ci: "success" }] };
  const s = setup({ adapter, forge });
  const r1 = await s.ops.prs({});
  assert.equal("mine" in r1.prs[0], false);
  fail = false;
  const r2 = await s.ops.prs({ fresh: true });
  assert.equal(r2.prs[0].mine, true, "a failed lookup was not cached, so the retry succeeds");
});
test("prs: assigneeFilter:false or no adapter.ownership omits mine on every row", async () => {
  const forge = { listAgentPrs: async () => [{ number: 1, ref: "1", ci: "success" }] };
  const scopedOff = setup({ adapter: { ownership: async () => "ours" }, forge, tracker: { assigneeFilter: false } });
  assert.equal("mine" in (await scopedOff.ops.prs({})).prs[0], false);
  const noMethod = setup({ adapter: {}, forge });
  assert.equal("mine" in (await noMethod.ops.prs({})).prs[0], false);
});
test("prs: {mine:true}/{mine:false} filter after the cache; unfiltered cache is reused", async () => {
  const adapter = { ownership: async (/** @type {string} */ ref) => (ref === "1" ? "ours" : "not_ours") };
  const forge = { listAgentPrs: async () => [{ number: 1, ref: "1", ci: "success" }, { number: 2, ref: "2", ci: "success" }] };
  const s = setup({ adapter, forge });
  const mine = await s.ops.prs({ mine: true });
  assert.deepEqual(mine.prs.map((/** @type {any} */ p) => p.number), [1]);
  const notMine = await s.ops.prs({ mine: false });
  assert.deepEqual(notMine.prs.map((/** @type {any} */ p) => p.number), [2]);
});
test("prs: attaches review from the newest review-kind step's summary (receiver keys win), fresh outside the cache; absent → unchanged", async () => {
  const forge = { listAgentPrs: async () => [{ number: 1, ref: "1", ci: "success" }, { number: 2, ref: "2", ci: "success" }] };
  const s = setup({ forge, pipeline: [{ id: "code" }, { id: "review", kind: "review" }, { id: "audit", kind: "review" }, { id: "done", manual: true }] });
  const r0 = await s.ops.prs({});
  assert.ok(r0.prs.every((/** @type {any} */ p) => !("review" in p)));
  s.store.setSummary("1", "code", { summary: { tier: "code" }, outcome: "advance", run: "c", at: "2026-01-01T00:00:09Z" });
  s.store.setSummary("1", "review", { summary: { tier: "low", outcome: "spoof", at: "spoof" }, outcome: "advance", run: "r", at: "2026-01-01T00:00:02Z" });
  s.store.setSummary("1", "audit", { summary: { tier: "high" }, outcome: "hold", run: "a", at: "2026-01-01T00:00:01Z" });
  const r1 = await s.ops.prs({}); // still inside the ttl — the summary read is not cached
  assert.deepEqual(r1.prs[0].review, { tier: "low", outcome: "advance", at: "2026-01-01T00:00:02Z" });
  assert.equal("review" in r1.prs[1], false);
  s.store.clearSummaries("1");
  assert.equal("review" in (await s.ops.prs({})).prs[0], false);
});
test("cancel of a waiting/held ref clears its summaries", async () => {
  const s = setup({ adapter: { advance: async () => {} } });
  s.store.setHeld("H", { stepId: "code", heldAt: "x" });
  s.store.setSummary("H", "code", { summary: { a: 1 }, outcome: "hold", run: "r", at: "t" });
  await s.ops.cancel({ ref: "H" });
  assert.equal(s.store.getSummaries("H"), undefined);
});
test("digest: delegates to the digester, audited; no digester → refused; not a board write", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthook-ops-"));
  const cfg = /** @type {any} */ ({ name: "t", provider: "github", stateDir: dir, dataDir: dir, pipeline: [{ id: "code" }] });
  const store = createStore(dir);
  const queue = createQueue(1, () => new Promise(() => {}), undefined, {});
  const base = { cfg, store, forge: null, queue, leavePipeline() {}, adapter: /** @type {any} */ ({}), cancelRun: () => false, intake: () => 0, emit() {}, heartbeat: { update() {} }, pull: async () => {}, isLocked: () => false };
  const rec = { text: "hi", generatedAt: "t", basedOnEvents: 0, needsYou: 0 };
  const ok = createOps({ ...base, digester: { request: async () => rec } });
  assert.deepEqual(await ok.digest({ actor: "ui" }), rec);
  const none = createOps(base);
  await assert.rejects(none.digest({}), /not available/);
  const lines = fs.readFileSync(path.join(dir, "control-audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => [l.cmd, l.ok, l.actor]), [["digest", true, "ui"], ["digest", false, "unknown"]]);
});
test("digest {lang}: canonicalized and forwarded; an invalid lang is refused before the digester", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthook-ops-"));
  const cfg = /** @type {any} */ ({ name: "t", provider: "github", stateDir: dir, dataDir: dir, pipeline: [{ id: "code" }] });
  const store = createStore(dir);
  const queue = createQueue(1, () => new Promise(() => {}), undefined, {});
  /** @type {any[]} */ const asked = [];
  const ops = createOps({ cfg, store, forge: null, queue, leavePipeline() {}, adapter: /** @type {any} */ ({}), cancelRun: () => false, intake: () => 0, emit() {}, heartbeat: { update() {} }, pull: async () => {}, isLocked: () => false, digester: { request: async (o) => (asked.push(o), { text: "x" }) } });
  await ops.digest({});
  await ops.digest({ lang: "ES" });
  await assert.rejects(ops.digest({ lang: "no way!" }), /BCP-47/);
  assert.deepEqual(asked, [{}, { lang: "es" }]);
});
test("summary: validates ref + lang, forwards canonical lang, refusals readable; not a write (no audit, no board-cache reset)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthook-ops-"));
  const cfg = /** @type {any} */ ({ name: "t", provider: "github", stateDir: dir, dataDir: dir, pipeline: [{ id: "code" }] });
  const store = createStore(dir);
  const queue = createQueue(1, () => new Promise(() => {}), undefined, {});
  let boardReads = 0;
  const adapter = /** @type {any} */ ({ listResting: async () => (boardReads++, []) });
  /** @type {any[]} */ const asked = [];
  const summarizer = {
    request: async (/** @type {any} */ o) => {
      asked.push(o);
      if (o.ref === "theirs") throw new Error("theirs is not assigned to us");
      return { ref: o.ref, lang: o.lang, text: "Resumen", generatedAt: "t" };
    },
  };
  const base = { cfg, store, forge: null, queue, leavePipeline() {}, adapter, cancelRun: () => false, intake: () => 0, emit() {}, heartbeat: { update() {} }, pull: async () => {}, isLocked: () => false };
  const ops = createOps({ ...base, summarizer });
  await ops.board({});
  assert.deepEqual(await ops.summary({ ref: "7", lang: "es-mx", actor: "ui" }), { ref: "7", lang: "es-MX", text: "Resumen", generatedAt: "t" });
  await assert.rejects(ops.summary({ ref: "7", lang: "<script>" }), /BCP-47/);
  await assert.rejects(ops.summary({ ref: "7" }), /BCP-47/);
  await assert.rejects(ops.summary({ ref: 7, lang: "en" }), /ref is required/);
  await assert.rejects(ops.summary({ ref: "theirs", lang: "en" }), /not assigned to us/);
  assert.equal(asked.length, 2, "invalid args never reach the summarizer");
  await ops.board({});
  assert.equal(boardReads, 1, "the board cache survived the summary calls");
  assert.ok(!fs.existsSync(path.join(dir, "control-audit.jsonl")), "not audited");
  await assert.rejects(createOps(base).summary({ ref: "7", lang: "en" }), /not available/);
});
/** A fake epic-capable adapter counting its tracker reads. */
function epicAdapter() {
  const calls = { listEpics: 0, listEpicTickets: /** @type {string[]} */ ([]) };
  /** @type {Record<string, any[]>} */
  const members = {
    E1: [
      { ref: "11", name: "a", completed: false, stage: "Backlog" },
      { ref: "12", name: "b", completed: true, stage: "Done" },
    ],
    E2: [{ ref: "21", name: "c", completed: false, stage: null }],
  };
  return {
    calls,
    adapter: {
      async listEpics() {
        calls.listEpics++;
        return [
          { ref: "E1", name: "Epic one", url: "u1", status: null, completed: false },
          { ref: "E2", name: "Epic two", url: "u2", status: "On track", completed: false },
        ];
      },
      /** @param {string} ref */
      async listEpicTickets(ref) {
        calls.listEpicTickets.push(ref);
        return members[ref];
      },
    },
  };
}

test("epics: one EpicStats per listed epic, total = its listEpicTickets length", async () => {
  const { adapter, calls } = epicAdapter();
  const { ops } = setup({ adapter });
  const r = await ops.epics({});
  assert.equal(r.live, true);
  assert.equal(r.supported, true);
  assert.deepEqual(r.epics.map((/** @type {any} */ e) => [e.ref, e.total]), [["E1", 2], ["E2", 1]]);
  assert.deepEqual(r.epics[0].byStage, { backlog: 1, running: 0, needsYou: 0, done: 1, untracked: 0 });
  assert.equal(r.epics[1].status, "On track");
  assert.deepEqual(calls.listEpicTickets.sort(), ["E1", "E2"], "fans out to every epic");
});
test("epics: cached within the TTL, fresh refetches, a write invalidates", async () => {
  const { adapter, calls } = epicAdapter();
  const { ops } = setup({ adapter });
  await ops.epics({});
  await ops.epics({ ref: "E1" });
  assert.equal(calls.listEpics, 1, "second call is served from the cache");
  await ops.epics({ fresh: true });
  assert.equal(calls.listEpics, 2);
  await ops.pause({});
  await ops.epics({});
  assert.equal(calls.listEpics, 3, "a write drops the cached read");
});
test("epics: onEpicChanged hands over a cache reset that is not a control op", async () => {
  const { adapter, calls } = epicAdapter();
  /** @type {(() => void) | undefined} */
  let reset;
  const { ops } = setup({ adapter, onEpicChanged: (r) => { reset = r; } });
  assert.equal(typeof reset, "function");
  // harness_reset is a real op (the health breaker), not a cache invalidation.
  assert.ok(!Object.keys(ops).some((k) => k !== "harness_reset" && /epic_?changed|reset|invalidate/i.test(k)), "no invalidation own property on the commands map");
  await ops.epics({});
  await ops.epics({});
  assert.equal(calls.listEpics, 1);
  reset?.();
  await ops.epics({});
  assert.equal(calls.listEpics, 2, "the next epics call refetches from the tracker");
});
test("epic_changed (engine wiring): one emit, never queued, redelivery deduped, next epics call refetches, no tracker write", async () => {
  const { adapter, calls } = epicAdapter();
  /** @type {string[]} */ const writes = [];
  for (const m of ["advance", "enterStage", "complete", "registerWebhook"]) /** @type {any} */ (adapter)[m] = async () => void writes.push(m);
  /** @type {(() => void) | undefined} */
  let reset;
  const { ops, store, queue, events } = setup({ adapter, onEpicChanged: (r) => { reset = r; } });
  const epicChanged = createEpicChanged({ store, emit: (e, ref, step, x) => events.push([e, ref, step, x]), invalidate: () => reset?.() });
  await ops.epics({});
  const job = { kind: /** @type {const} */ ("epic_changed"), ref: "E1", stepId: "", dedupKey: "epic:guid-1" };
  assert.equal(epicChanged(job), true);
  assert.equal(epicChanged({ ...job }), false, "a redelivery with the same dedupKey emits nothing");
  assert.deepEqual(events, [["epic_changed", "E1", "", undefined]]);
  assert.equal(queue.state().queued, 0);
  assert.equal(queue.state().active, 0);
  assert.equal(store.listQueued().length, 0);
  await ops.epics({});
  assert.equal(calls.listEpics, 2, "the cached epics read was dropped");
  assert.deepEqual(writes, []);
});
test("epics: the local join is fresh on every call (outside the cache)", async () => {
  const { adapter } = epicAdapter();
  const { ops, store } = setup({ adapter });
  assert.equal((await ops.epics({})).epics[0].byStage.running, 0);
  store.setRunning("11", { stepId: "code", dedupKey: "k", startedAt: new Date().toISOString() });
  const r = await ops.epics({});
  assert.equal(r.epics[0].byStage.running, 1);
  assert.equal(r.epics[0].byStage.backlog, 0);
});
test("epics: an adapter without epic readers → supported:false, no throw", async () => {
  const { ops } = setup({ adapter: {} });
  const list = await ops.epics({});
  assert.deepEqual({ ...list, at: undefined }, { at: undefined, live: true, supported: false, epics: [] });
  const one = await ops.epics({ ref: "E1" });
  assert.deepEqual({ ...one, at: undefined }, { at: undefined, live: true, supported: false, epic: null });
});
test("epics {ref}: per-ticket bucket + status; unknown ref → no epic; unsafe ref never reaches the adapter", async () => {
  const { adapter, calls } = epicAdapter();
  const { ops, store } = setup({ adapter });
  store.setRunning("11", { stepId: "code", dedupKey: "k", startedAt: new Date().toISOString() });
  const r = await ops.epics({ ref: "E1" });
  assert.equal(r.epic.ref, "E1");
  assert.equal(r.epic.total, 2);
  assert.deepEqual(r.epic.tickets.map((/** @type {any} */ t) => [t.ref, t.bucket, t.status]), [["11", "running", "running"], ["12", "done", null]]);
  await assert.rejects(ops.epics({ ref: "E9" }), /no epic E9/);
  const before = calls.listEpics;
  await assert.rejects(ops.epics({ ref: "../x" }), /invalid epic ref/);
  await assert.rejects(ops.epics({ ref: 7 }), /invalid epic ref/);
  await assert.rejects(ops.epics({ tz: 9999 }), /invalid tz/);
  assert.equal(calls.listEpics, before, "adapter never called for a bad ref");
});

