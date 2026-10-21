import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// Merge catch-up (#517): `runMergeCatchup` replays the `merge` job for agent PRs merged while
// the receiver was down — oldest first, deduped on the live webhook's `merged:<pr>` key, behind a
// watermark — and runs only from reconcile / reconcile-on-boot / the control ops.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { runMergeCatchup, MERGE_LOOKBACK_MS } from "../src/commands/reconcile.js";
import { createStore } from "../src/store.js";
import { createDispatcher } from "../src/dispatch.js";
import { createOps } from "../src/ops.js";
import { createQueue } from "../src/queue.js";
import { createServe } from "../src/engine/boot.js";

const pipeline = [
  { id: "code", sourceSectionGid: "S1" },
  { id: "done", manual: true, completeOnMerge: true, drainWorktree: true, sourceSectionGid: "S9" },
];

/**
 * A temp store + config, a recording tracker stub, and the engine's dedup semantics for
 * intake (skip a seen key unless forced, then mark it) collecting the accepted jobs.
 * @param {{completed?: Record<string, boolean>, fetchThrows?: string[]}} [o]
 */
function harness(o = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-merge-catchup-"));
  const cfg = /** @type {any} */ ({ name: "t", provider: "github", stateDir: dir, dataDir: dir, pipeline, repoPath: dir });
  const store = createStore(dir);
  /** @type {string[]} */
  const calls = [];
  /** @type {any} */
  const adapter = {
    describe: () => ({ platform: "Stub", taskNoun: "task", trigger: "@agent", commentHowTo: "" }),
    fetchTask: async (/** @type {string} */ ref) => {
      calls.push(`fetch ${ref}`);
      if (o.fetchThrows?.includes(ref)) throw new Error("boom");
      return { ref, name: `Task ${ref}`, url: `u/${ref}`, completed: !!o.completed?.[ref], assignedToUs: true };
    },
    enterStage: async (/** @type {string} */ ref, /** @type {string} */ stepId) => void calls.push(`enter ${ref} ${stepId}`),
    complete: async (/** @type {string} */ ref) => void calls.push(`complete ${ref}`),
    advance: async () => {},
  };
  /** @type {any[]} */
  const jobs = [];
  /** @type {any[]} */
  const intakeOpts = [];
  const intake = (/** @type {any[]} */ js, /** @type {any} */ opts) => {
    intakeOpts.push(opts);
    store.reloadSeen();
    let n = 0;
    for (const j of js) {
      if (!opts?.force && store.hasSeen(j.dedupKey)) continue;
      store.markSeen(j.dedupKey);
      jobs.push(j);
      n++;
    }
    return n;
  };
  /** @type {string[]} */
  const lines = [];
  const log = (/** @type {string} */ m) => void lines.push(m);
  return { dir, cfg, store, adapter, calls, jobs, intake, intakeOpts, lines, log };
}

/** @param {any[] | (() => never)} prs */
function fakeForge(prs) {
  /** @type {string[]} */
  const sinces = [];
  return {
    sinces,
    describe: () => ({ name: "github" }),
    listMergedAgentPrs: async (/** @type {string} */ since) => {
      sinces.push(since);
      if (typeof prs === "function") return prs();
      return prs;
    },
  };
}

test("merge catch-up: a PR merged after the watermark for an open, ours task → one merge job; running it moves + completes; watermark advances", async () => {
  const h = harness();
  h.store.setMergeWatermark("2026-10-01T00:00:00Z");
  const forge = fakeForge([{ pr: 42, ref: "7", mergedAt: "2026-10-02T10:00:00Z" }]);
  const r = await runMergeCatchup(h.cfg, { store: h.store, adapter: h.adapter, forge: /** @type {any} */ (forge), intake: h.intake, log: h.log });
  assert.deepEqual(r, { merged: 1, skipped: 0 });
  assert.deepEqual(forge.sinces, ["2026-10-01T00:00:00Z"]);
  assert.deepEqual(h.jobs, [{ kind: "merge", ref: "7", stepId: "done", dedupKey: "merged:42" }]);
  assert.equal(h.intakeOpts[0]?.force, undefined, "no force: the live webhook's dedup key still gates it");
  assert.equal(h.store.getMergeWatermark(), "2026-10-02T10:00:00Z");

  // The intaken job is the live webhook's job unchanged: dispatch's runMerge handles it.
  const run = createDispatcher(h.cfg, h.adapter, undefined, h.store, () => {});
  await run(h.jobs[0]);
  assert.deepEqual(h.calls, ["fetch 7", "fetch 7", "enter 7 done", "complete 7"]);
  assert.equal(h.store.getRefMeta("7")?.prState, "merged");
});

test("merge catch-up: no watermark → looks back 7 days; PRs replay oldest first", async () => {
  const h = harness();
  const now = Date.parse("2026-10-21T00:00:00Z");
  const forge = fakeForge([
    { pr: 9, ref: "b", mergedAt: "2026-10-20T00:00:00Z" },
    { pr: 8, ref: "a", mergedAt: "2026-10-19T00:00:00Z" },
  ]);
  await runMergeCatchup(h.cfg, { store: h.store, adapter: h.adapter, forge: /** @type {any} */ (forge), intake: h.intake, log: h.log, now: () => now });
  assert.deepEqual(forge.sinces, [new Date(now - MERGE_LOOKBACK_MS).toISOString()]);
  assert.deepEqual(h.jobs.map((j) => j.dedupKey), ["merged:8", "merged:9"]);
  assert.equal(h.store.getMergeWatermark(), "2026-10-20T00:00:00Z");
});

test("merge catch-up: an already-seen merge is not re-enqueued; a completed task or a failed fetch is skipped", async () => {
  const h = harness({ completed: { done1: true }, fetchThrows: ["gone"] });
  h.store.markSeen("merged:1"); // handled live
  const forge = fakeForge([
    { pr: 1, ref: "live", mergedAt: "2026-10-20T01:00:00Z" },
    { pr: 2, ref: "done1", mergedAt: "2026-10-20T02:00:00Z" },
    { pr: 3, ref: "gone", mergedAt: "2026-10-20T03:00:00Z" },
    { pr: 4, ref: "new", mergedAt: "2026-10-20T04:00:00Z" },
  ]);
  const r = await runMergeCatchup(h.cfg, { store: h.store, adapter: h.adapter, forge: /** @type {any} */ (forge), intake: h.intake, log: h.log });
  assert.deepEqual(r, { merged: 1, skipped: 3 });
  assert.deepEqual(h.jobs.map((j) => j.dedupKey), ["merged:4"]);
  assert.ok(h.lines.some((l) => l.includes("PR #1") && l.includes("already handled")));
  assert.ok(h.lines.some((l) => l.includes("PR #2") && l.includes("already completed")));
  assert.ok(h.lines.some((l) => l.includes("PR #3") && l.includes("fetch failed")));
  // The failed fetch holds the watermark just below PR #3, so the next scan lists it again.
  assert.equal(h.store.getMergeWatermark(), "2026-10-20T02:00:00Z");
});

test("merge catch-up: a failed fetch on the oldest PR leaves the watermark unchanged", async () => {
  const h = harness({ fetchThrows: ["gone"] });
  h.store.setMergeWatermark("2026-10-01T00:00:00Z");
  const forge = fakeForge([
    { pr: 4, ref: "new", mergedAt: "2026-10-20T04:00:00Z" },
    { pr: 3, ref: "gone", mergedAt: "2026-10-20T03:00:00Z" },
  ]);
  const r = await runMergeCatchup(h.cfg, { store: h.store, adapter: h.adapter, forge: /** @type {any} */ (forge), intake: h.intake, log: h.log });
  assert.deepEqual(r, { merged: 1, skipped: 1 });
  assert.equal(h.store.getMergeWatermark(), "2026-10-01T00:00:00Z");
});

test("merge catch-up: a forge error logs, leaves the watermark unchanged and never throws", async () => {
  const h = harness();
  h.store.setMergeWatermark("2026-10-01T00:00:00Z");
  const forge = fakeForge(() => {
    throw new Error("list closed PRs 502");
  });
  const r = await runMergeCatchup(h.cfg, { store: h.store, adapter: h.adapter, forge: /** @type {any} */ (forge), intake: h.intake, log: h.log });
  assert.deepEqual(r, { merged: 0, skipped: 0 });
  assert.equal(h.store.getMergeWatermark(), "2026-10-01T00:00:00Z");
  assert.ok(h.lines.some((l) => l.includes("list closed PRs 502") && l.includes("watermark unchanged")));
});

test("merge catch-up: no forge, or a forge without listMergedAgentPrs → logs and skips", async () => {
  const h = harness();
  assert.deepEqual(await runMergeCatchup(h.cfg, { store: h.store, adapter: h.adapter, forge: null, intake: h.intake, log: h.log }), { merged: 0, skipped: 0 });
  const bare = /** @type {any} */ ({ describe: () => ({ name: "gitlab" }) });
  assert.deepEqual(await runMergeCatchup(h.cfg, { store: h.store, adapter: h.adapter, forge: bare, intake: h.intake, log: h.log }), { merged: 0, skipped: 0 });
  assert.deepEqual(h.lines, ["merge catch-up skipped — no forge configured.", 'merge catch-up skipped — forge "gitlab" cannot list merged PRs.']);
  assert.equal(h.store.getMergeWatermark(), null);
});

/** Control ops over the harness: an in-process tracker (listResting, no forgeCatchup). @param {any} forge */
function opsFor(forge) {
  const h = harness();
  h.adapter.listResting = async () => [];
  const ops = createOps({
    cfg: h.cfg, store: h.store, forge, adapter: h.adapter,
    queue: createQueue(1, () => new Promise(() => {})),
    cancelRun: () => false, intake: h.intake, emit: () => {}, heartbeat: { update: () => {} },
    pull: async () => {}, isLocked: () => false,
  });
  return { h, ops };
}

test("ops: `reconcile` also runs the merge catch-up (adds `merged`); `reconcile_merges` runs only it", async () => {
  const { h, ops } = opsFor(fakeForge([{ pr: 5, ref: "9", mergedAt: "2026-10-20T00:00:00Z" }]));
  const r = await ops.reconcile({});
  assert.equal(r.merged, 1);
  assert.equal(r.replayed, 0);
  assert.deepEqual(h.jobs.map((j) => j.dedupKey), ["merged:5"]);
  assert.ok(r.log.some((/** @type {string} */ l) => l.startsWith("merge catch-up done")));
  const again = await ops.reconcile_merges({});
  assert.deepEqual([again.merged, again.skipped], [0, 1], "seen on the second pass");
});

test("ops: a failing listMergedAgentPrs leaves reconcile's result intact", async () => {
  const { h, ops } = opsFor(fakeForge(() => {
    throw new Error("boom");
  }));
  const r = await ops.reconcile({});
  assert.deepEqual([r.replayed, r.merged], [0, 0]);
  assert.equal(h.store.getMergeWatermark(), null);
});

/** A boot over stubs (see engine-boot-retry.test.js) with a counting forge. @param {boolean} reconcileOnBoot @param {any} forge */
async function boot(reconcileOnBoot, forge) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-merge-boot-"));
  const cfg = /** @type {any} */ ({
    name: "p", stateKey: "p", provider: "local", stateDir: dir, dataDir: dir, logDir: path.join(dir, "logs"), port: 0, pipeline,
    publicUrlFile: path.join(dir, "public_url.txt"), pidFile: path.join(dir, "server.pid"), controlSock: path.join(dir, "c.sock"),
  });
  const state = /** @type {any} */ ({ server: http.createServer(), control: null });
  /** @type {any[]} */
  const intaken = [];
  const serve = createServe(/** @type {any} */ ({
    cfg, state, store: createStore(dir), sandbox: null, emit: () => {}, startedAt: new Date().toISOString(), reconcileOnBoot,
    adapter: {
      registerWebhook: async () => {}, unregisterWebhooks: async () => {}, advance: async () => {},
      listResting: async () => [],
      fetchTask: async (/** @type {string} */ ref) => ({ ref, completed: false, assignedToUs: true }),
    },
    forge: { ...forge, registerWebhook: async () => {}, unregisterWebhooks: async () => {} },
    intake: (/** @type {any[]} */ jobs) => (intaken.push(...jobs), jobs.length),
    ingress: { describe: () => ({ name: "manual", ephemeral: false }), up: async () => ({ url: "https://x" }), down: async () => {} },
    heartbeat: { update: () => {} },
    queue: { enqueue: () => true },
    puller: { pull: async () => {} },
    quotaPacer: { reading: () => {} },
    restart: async () => ({}), decommission: async () => ({}), ops: {}, shutdown: () => {},
  }));
  const before = { SIGINT: process.listeners("SIGINT"), SIGTERM: process.listeners("SIGTERM") };
  const { log, error } = console;
  /** @type {string[]} */
  const lines = [];
  console.log = console.error = (/** @type {any[]} */ ...a) => void lines.push(a.join(" "));
  try {
    await serve();
  } finally {
    console.log = log;
    console.error = error;
    for (const sig of /** @type {const} */ (["SIGINT", "SIGTERM"])) for (const l of process.listeners(sig)) if (!before[sig].includes(l)) process.removeListener(sig, l);
    state.control?.close();
    state.server.close();
  }
  return { intaken, lines };
}

test("boot: a plain boot never asks the forge for merged PRs; reconcile-on-boot asks exactly once", async () => {
  const plain = fakeForge([{ pr: 3, ref: "4", mergedAt: "2026-10-20T00:00:00Z" }]);
  const p = await boot(false, plain);
  assert.equal(plain.sinces.length, 0);
  assert.equal(p.intaken.length, 0);

  const re = fakeForge([{ pr: 3, ref: "4", mergedAt: "2026-10-20T00:00:00Z" }]);
  const r = await boot(true, re);
  assert.equal(re.sinces.length, 1);
  assert.deepEqual(r.intaken, [{ kind: "merge", ref: "4", stepId: "done", dedupKey: "merged:3" }]);
  assert.ok(r.lines.includes("[boot] post-restart merge catch-up — 1 replayed, 0 skipped"));
});

test("boot: a forge error during the reconcile-on-boot merge catch-up does not abort boot", async () => {
  const bad = fakeForge(() => {
    throw new Error("list closed PRs 500");
  });
  const r = await boot(true, bad);
  assert.equal(bad.sinces.length, 1);
  assert.ok(r.lines.some((l) => l.includes("list closed PRs 500")));
  assert.ok(r.lines.includes("[boot] post-restart merge catch-up — 0 replayed, 0 skipped"));
});
