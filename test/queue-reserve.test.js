import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createQueue } from "../src/queue.js";
import { buildHarnessing, exclusiveHarnesses } from "../src/engine/harnessing.js";
import { validateRawConfig } from "../src/config/validate/index.js";
import { harnessSlotLints } from "../src/commands/doctor.js";
import { readStatus } from "../src/agent-api/status.js";
import { readProfile } from "../src/heartbeat.js";

/** Minimal raw config with one harness (config-validate.test.js's `raw`/`hErrs` pattern). @param {any} h */
const harnessErrors = (h) => /** @type {any} */ (validateRawConfig({ name: "ah-reserve-test", repoPath: "/tmp/repo", tracker: { type: "asana", pipeline: [{ id: "code" }] }, harnesses: { x: h } })).errors;

/** @param {any} job */
const info = (job) => ({ kind: job.kind, ref: job.ref, name: job.ref, url: "", code: 0 });
const job = (ref, stepId = "s") => ({ kind: "pipeline", ref, stepId, dedupKey: `${ref}:${stepId}` });

/**
 * A queue whose jobs settle (or fail) only when the test says so, from `test/queue.test.js`'s
 * `harnessed` helper (its file is already at the ~25 KB cap, so #745's reserve/order tests live
 * here instead). `started` records `ref:harness` per start.
 * @param {number} max @param {any} harnessing @param {Record<string, number>} [caps]
 */
function harnessed(max, harnessing, caps = {}) {
  /** @type {Map<string, {ok: () => void, fail: () => void}>} */ const settle = new Map();
  /** @type {string[]} */ const started = [];
  const run = (/** @type {any} */ j) =>
    new Promise((resolve, reject) => {
      started.push(`${j.ref}:${j.harness ?? "-"}`);
      settle.set(j.ref, { ok: () => resolve(info(j)), fail: () => reject(new Error("boom")) });
    });
  const q = createQueue(max, run, undefined, undefined, caps, harnessing);
  const done = async (/** @type {string} */ ref, /** @type {"ok"|"fail"} */ how = "ok") => {
    const err = console.error;
    console.error = () => {};
    try {
      settle.get(ref)?.[how]();
      settle.delete(ref);
      await new Promise((r) => setImmediate(r));
    } finally {
      console.error = err;
    }
  };
  return { q, started, done };
}

// code lists [deepseek, claude] (first-free); triage and review each name claude alone — claude
// is exclusive and used as an alternative by code, so it gets the automatic reserve of 1.
const SPILL = { steps: { code: { harnesses: ["deepseek", "claude"], routing: "first-free" }, review: { harnesses: ["claude"] } }, caps: { deepseek: 1, claude: 2 }, reserves: { claude: 1 }, exclusive: ["claude"] };

test("exclusiveHarnesses: a harness some step lists alone is exclusive; its reserve is 1 only when another step lists it as an alternative", () => {
  const cfg = /** @type {any} */ ({
    pipeline: [
      { id: "code", harness: ["deepseek", "claude"] },
      { id: "review", harness: "claude" },
      { id: "triage", harness: "opus" },
    ],
  });
  assert.deepEqual(exclusiveHarnesses(cfg), {
    claude: { reserve: 1, automatic: true, usedAsAlt: true },
    opus: { reserve: 0, automatic: true, usedAsAlt: false },
  });
  const overridden = /** @type {any} */ ({ ...cfg, harnesses: { claude: { reserve: 0 }, opus: { reserve: 3 } } });
  assert.deepEqual(exclusiveHarnesses(overridden), {
    claude: { reserve: 0, automatic: false, usedAsAlt: true },
    opus: { reserve: 3, automatic: false, usedAsAlt: false },
  });
});

test("buildHarnessing: reserves/exclusive reflect the pipeline; a manual step is never the sole user", () => {
  const cfg = /** @type {any} */ ({
    harnesses: { claude: {}, deepseek: {} },
    pipeline: [
      { id: "code", harness: ["deepseek", "claude"] },
      { id: "review", harness: "claude" },
      { id: "manual", manual: true, harness: "deepseek" },
    ],
  });
  const shape = buildHarnessing(cfg);
  assert.deepEqual(shape.reserves, { claude: 1 });
  assert.deepEqual(shape.exclusive.sort(), ["claude"]);
});

test("reserve (#745): a spilling job never takes a reserved harness's last slot; a job with no alternative can", async () => {
  const { q, started, done } = harnessed(5, SPILL);
  q.enqueue(job("A1", "code"));
  q.enqueue(job("A2", "code")); // deepseek (cap 1) is now full, spills toward claude
  assert.deepEqual(started, ["A1:deepseek", "A2:claude"], "claude has 2 slots, 1 reserved — one spill fits");
  q.enqueue(job("A3", "code")); // a second spill would take claude's last slot — reserved
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(started.slice(2), [], "A3 waits: claude's remaining slot is reserved against a spiller");
  assert.deepEqual(q.state().reserved, [{ ref: "A3", stepId: "code", harnesses: ["deepseek", "claude"] }], "A3 is waiting only on the reserve — claude still has a free slot");
  q.enqueue(job("R1", "review")); // review has no alternative — takes the reserved slot
  assert.deepEqual(started.slice(2), ["R1:claude"]);
  // Free both of claude's occupants (A1 stays running, so deepseek stays full — A3 can't just
  // prefer its first-listed harness once it frees): only once claude is fully idle again does the
  // reserve rule (active+1 <= cap-reserve) let the long-waiting spiller in.
  for (const r of ["A2", "R1"]) await done(r);
  assert.deepEqual(started.slice(3), ["A3:claude"], "claude's slot freed → the long-waiting spiller finally starts");
  await done("A1");
  await done("A3");
  await q.onIdle();
});

test("reserve (#745): a 1-slot exclusive harness never takes a spill at all", async () => {
  const oneSlot = { steps: { code: { harnesses: ["deepseek", "claude"] }, review: { harnesses: ["claude"] } }, caps: { deepseek: 1, claude: 1 }, reserves: { claude: 1 }, exclusive: ["claude"] };
  const { q, started, done } = harnessed(4, oneSlot);
  q.enqueue(job("A1", "code"));
  q.enqueue(job("A2", "code")); // deepseek full; claude's only slot is fully reserved
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(started, ["A1:deepseek"], "A2 never lands on claude — the reserve equals the cap");
  await done("A1");
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(started.slice(1), ["A2:deepseek"], "A2 starts once deepseek frees — still never spilled to claude");
  await done("A2");
  await q.onIdle();
});

test("reserve (#745): Rule 2 order — a job with no alternative jumps a longer-queued spiller for the same slot", async () => {
  // claude's reserve is 0 here — the reserve alone would let A1 spill in; the order rule still
  // prefers B1 (no alternative) for the one claude slot, FIFO order notwithstanding.
  const twoSlots = { steps: { code: { harnesses: ["deepseek", "claude"] }, review: { harnesses: ["claude"] } }, caps: { deepseek: 1, claude: 1 }, reserves: {}, exclusive: ["claude"] };
  const { q, started, done } = harnessed(2, twoSlots);
  q.enqueue(job("D1", "code")); // takes deepseek's one slot, so a later code job's only room is claude
  q.enqueue(job("O1")); // an unrelated, unrouted job — takes the 2nd (and last) global slot
  assert.deepEqual(started, ["D1:deepseek", "O1:-"]);
  q.enqueue(job("A1", "code")); // global max reached — queued behind O1, not started
  q.enqueue(job("B1", "review")); // queued behind A1
  await done("O1"); // frees a global slot: pump() now picks among [A1, B1] together
  assert.deepEqual(started.slice(2), ["B1:claude"], "B1 (no alternative) is preferred over the longer-queued A1 (a spiller)");
  await done("B1");
  assert.deepEqual(started.slice(3), ["A1:claude"], "A1 starts once nothing without an alternative is waiting");
  await done("D1");
  await done("A1");
  await q.onIdle();
});

test("reserve (#745): a down/drained alternative is no alternative — the spiller may use every slot, first come first served", async () => {
  const down = {
    steps: { code: { harnesses: ["deepseek", "claude"] }, review: { harnesses: ["claude"] } },
    caps: { deepseek: 1, claude: 2 },
    reserves: { claude: 1 },
    exclusive: ["claude"],
    health: { deepseek: { until: new Date(Date.now() + 60_000).toISOString(), strikes: 1, reason: "down for the test" } },
  };
  const { q, started, done } = harnessed(5, down);
  q.enqueue(job("A1", "code"));
  q.enqueue(job("A2", "code"));
  assert.deepEqual(started, ["A1:claude", "A2:claude"], "deepseek is down, so A has no open alternative — it may fill both claude slots");
  q.enqueue(job("B1", "review"));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(started.slice(2), [], "B1 waits FIFO behind A1/A2 — no reordering once A has no alternative");
  await done("A1");
  assert.deepEqual(started.slice(2), ["B1:claude"]);
  await done("A2");
  await done("B1");
  await q.onIdle();
});

test("reserve (#745): reserve: 0 keeps the order rule but allows a full spill; reserve >= cap blocks every spill", async () => {
  const zero = { steps: { code: { harnesses: ["deepseek", "claude"] }, review: { harnesses: ["claude"] } }, caps: { deepseek: 1, claude: 2 }, reserves: {}, exclusive: ["claude"] };
  const z = harnessed(5, zero);
  z.q.enqueue(job("A1", "code"));
  z.q.enqueue(job("A2", "code"));
  assert.deepEqual(z.started, ["A1:deepseek", "A2:claude"], "no reserve → the second spill is allowed");
  for (const r of ["A1", "A2"]) await z.done(r);
  await z.q.onIdle();

  const maxed = { ...zero, caps: { deepseek: 1, claude: 2 }, reserves: { claude: 2 }, exclusive: ["claude"] };
  const m = harnessed(5, maxed);
  m.q.enqueue(job("A1", "code"));
  m.q.enqueue(job("A2", "code"));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(m.started, ["A1:deepseek"], "reserve equals the cap → A2 never spills to claude at all");
  await m.done("A1"); // frees deepseek — A2 starts there (never on claude) and the queue drains
  assert.deepEqual(m.started.slice(1), ["A2:deepseek"]);
  await m.done("A2");
  await m.q.onIdle();
});

test("reserve (#745): no step names exactly one harness → unchanged (no reserve, no reordering)", async () => {
  const shared = { steps: { code: { harnesses: ["a", "b"] }, review: { harnesses: ["a", "b"] } }, caps: { a: 1, b: 1 }, reserves: {}, exclusive: [] };
  const { q, started, done } = harnessed(5, shared);
  q.enqueue(job("A1", "code"));
  q.enqueue(job("B1", "review"));
  assert.deepEqual(started, ["A1:a", "B1:b"], "plain first-free spill, same as before #745");
  assert.equal(q.state().reserved, undefined);
  await done("A1");
  await done("B1");
  await q.onIdle();
});

test("reconfigure (#745): a reload changing which harness is exclusive, or its reserve, takes effect without a restart", async () => {
  const noReserve = { steps: { code: { harnesses: ["deepseek", "claude"] }, review: { harnesses: ["claude"] } }, caps: { deepseek: 1, claude: 1 }, reserves: {}, exclusive: ["claude"] };
  const { q, started, done } = harnessed(4, noReserve);
  q.enqueue(job("D1", "code")); // takes deepseek's only slot
  q.enqueue(job("A1", "code")); // deepseek full but open — spills to claude, no reserve yet
  assert.deepEqual(started, ["D1:deepseek", "A1:claude"]);
  await done("A1");
  await done("D1");
  await q.onIdle();

  q.reconfigure({ steps: noReserve.steps, caps: noReserve.caps, reserves: { claude: 1 }, exclusive: ["claude"] });
  q.enqueue(job("D2", "code")); // deepseek free again
  q.enqueue(job("A2", "code")); // the same spill the reload's reserve now blocks
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(started.slice(2), ["D2:deepseek"], "the reloaded reserve now blocks the spill it let through before");
  q.enqueue(job("B1", "review")); // no alternative — still free to take claude's one slot
  assert.deepEqual(started.slice(3), ["B1:claude"]);
  await done("B1");
  await done("D2"); // deepseek frees — A2 never spilled to claude under the new reserve, waits for its own slot
  assert.deepEqual(started.slice(4), ["A2:deepseek"]);
  await done("A2");
  await q.onIdle();
});

// --- config validation (config-validate.test.js is already well past the file-size cap) ---

test("config: harnesses.<name>.reserve must be an integer >= 0", () => {
  assert.equal(harnessErrors({ reserve: 0 }), undefined);
  assert.equal(harnessErrors({ reserve: 3 }), undefined);
  for (const v of [-1, 1.5, "2"]) {
    assert.deepEqual(harnessErrors({ reserve: v }), [`config: harness "x" reserve must be an integer >= 0.`], `reserve ${JSON.stringify(v)}`);
  }
});

// --- doctor (doctor-harness.test.js is already past the file-size cap) ---

test("harnessSlotLints (#745): an ℹ line per exclusive harness naming its reserve, who it's kept for, and the room left to spill into", () => {
  const cfg = /** @type {any} */ ({
    harnesses: { claude: { maxConcurrent: 2 }, deepseek: { maxConcurrent: 1 } },
    pipeline: [
      { id: "code", harness: ["deepseek", "claude"] },
      { id: "review", harness: "claude" },
    ],
  });
  const lints = harnessSlotLints(cfg);
  assert.ok(lints.some((l) => l.level === "info" && l.label === `harness "claude" reserve` && /^1 \(automatic\), kept for review; code may spill into at most 1$/.test(l.note)), JSON.stringify(lints));
});

test("harnessSlotLints (#745): a reserve on a non-exclusive or uncapped harness gets a no-effect note", () => {
  const notExclusive = /** @type {any} */ ({ harnesses: { a: { reserve: 1 } }, pipeline: [{ id: "code", harness: ["a", "b"] }] });
  assert.ok(harnessSlotLints(notExclusive).some((l) => l.label === `harness "a" reserve` && /no effect/.test(l.note)));

  const uncapped = /** @type {any} */ ({ harnesses: { a: { reserve: 1 } }, pipeline: [{ id: "code", harness: "a" }] });
  assert.ok(harnessSlotLints(uncapped).some((l) => l.label === `harness "a" reserve` && /uncapped — no effect/.test(l.note)));
});

// --- agent-api (agent-api.test.js is already past the file-size cap) ---

test("readStatus (#745): a queue entry matching hb.queue.reserved gets `why`, naming the harness, its reserve, and the step it's kept for", () => {
  const reg = fs.mkdtempSync(path.join(os.tmpdir(), "agenthook-reserve-status-"));
  const dir = path.join(reg, "p");
  fs.mkdirSync(path.join(dir, "logs"), { recursive: true });
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthook-reserve-cfg-"));
  const configPath = path.join(configDir, "agenthook.config.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      name: "p",
      repoPath: "/tmp",
      tracker: {
        type: "github",
        owner: "x",
        repo: "y",
        pipeline: [
          { id: "code", harness: ["deepseek", "claude"], sourceLabel: "agent:code", successLabel: "agent:review" },
          { id: "review", harness: "claude", sourceLabel: "agent:review", successLabel: "agent:done" },
        ],
      },
      harnesses: { claude: {}, deepseek: {} },
    }),
  );
  fs.writeFileSync(
    path.join(dir, "heartbeat.json"),
    JSON.stringify({
      name: "p",
      configPath,
      maxConcurrent: 3,
      tracker: "github",
      queue: {
        active: 2,
        queued: 2,
        harnesses: { claude: { active: 0, max: 2, state: "up", reserve: 1 }, deepseek: { active: 1, max: 1, state: "up" } },
        reserved: [{ ref: "A3", stepId: "code", harnesses: ["deepseek", "claude"] }],
      },
    }),
  );
  fs.writeFileSync(path.join(dir, "server.pid"), String(process.pid));
  fs.writeFileSync(path.join(dir, "running.json"), JSON.stringify({}));
  fs.writeFileSync(
    path.join(dir, "queue.json"),
    JSON.stringify([
      { kind: "pipeline", ref: "A3", stepId: "code", dedupKey: "k-a3" },
      { kind: "pipeline", ref: "B1", stepId: "review", dedupKey: "k-b1" },
    ]),
  );
  fs.writeFileSync(path.join(dir, "held.json"), JSON.stringify({}));
  fs.writeFileSync(path.join(dir, "refmeta.json"), JSON.stringify({}));

  const out = readStatus(readProfile("p", reg));
  const a3 = out.queue.find((q) => q.ref === "A3");
  const b1 = out.queue.find((q) => q.ref === "B1");
  assert.equal(a3?.why, "reserve: claude keeps 1 slot(s) for review");
  assert.equal(b1?.why, undefined, "B1 isn't in hb.queue.reserved — no why");
});
