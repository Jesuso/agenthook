import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createReloadRequester } from "../src/engine/controllers.js";
import { createQueue } from "../src/queue.js";

const step = (o = {}) => ({ id: "code", sourceLabel: "s", successLabel: "d", harness: "h", model: "sonnet", ...o });
/** A minimal live config. @param {any} [o] */
const cfg = (o = {}) => ({
  name: "t",
  stateId: "t",
  repoPath: "/tmp/r",
  maxConcurrent: 4,
  quota: { pauseAboveSevenDay: 0.9 },
  tracker: { type: "github", owner: "o", repo: "r" },
  pipeline: [step()],
  sandbox: undefined,
  harnesses: { h: { command: ["claude"] } },
  ...o,
});

/**
 * A reload requester wired with fakes, over a real queue. `loadNext` produces the freshly-loaded
 * config (defaults to a deep-equal clone of the live one, i.e. a no-op).
 * @param {{overrides?: any, locked?: boolean, loadNext?: () => any, checkImages?: (next: any) => Promise<{ok: boolean, reason?: string}>}} [o]
 */
function setup({ overrides = {}, locked = false, loadNext, checkImages } = {}) {
  const live = cfg();
  /** @type {any} */
  let stored = structuredClone(overrides);
  /** @type {any[]} */
  const events = [];
  /** @type {any[]} */
  const heartbeats = [];
  /** @type {any[]} */
  const thresholds = [];
  const run = (/** @type {any} */ j) => Promise.resolve({ kind: j.kind, ref: j.ref, name: j.ref, url: "", code: 0 });
  const queue = createQueue(live.maxConcurrent, run);
  const reload = createReloadRequester({
    cfg: live,
    loadConfig: loadNext ?? (() => structuredClone(live)),
    isLocked: () => locked,
    store: { getOverrides: () => structuredClone(stored), setOverrides: (o) => (stored = o) },
    queue,
    quotaPacer: { setThresholds: (t) => thresholds.push(t) },
    heartbeat: { update: (p) => heartbeats.push(p) },
    emit: (event, ref, stepId, extra) => events.push({ event, extra }),
    ...(checkImages ? { checkImages } : {}),
  });
  return { reload, live, stored: () => stored, events, heartbeats, thresholds, queue };
}

test("reload: a changed reloadable key applies and emits exactly one config_reloaded", async () => {
  const s = setup({ loadNext: () => ({ ...cfg(), maxConcurrent: 8 }) });
  const r = await s.reload();
  assert.deepEqual(r, { changed: ["maxConcurrent"], note: "reloaded 1 key(s)" });
  assert.equal(s.live.maxConcurrent, 8, "the live cfg is updated");
  assert.equal(s.events.length, 1);
  assert.equal(s.events[0].event, "config_reloaded");
  assert.deepEqual(s.events[0].extra, { changed: ["maxConcurrent"] });
  assert.deepEqual(s.thresholds, [s.live.quota], "the no-harness pacer re-checked its last reading");
});

test("reload: a no-op applies nothing, emits none and is not heartbeated", async () => {
  const s = setup();
  assert.deepEqual(await s.reload(), { changed: [], note: "no changes" });
  assert.equal(s.events.length, 0);
  assert.equal(s.heartbeats.length, 0);
});

test("reload: refused while a restart/decommission/shutdown is pending", async () => {
  const s = setup({ locked: true, loadNext: () => ({ ...cfg(), maxConcurrent: 8 }) });
  await assert.rejects(s.reload(), /restart\/decommission\/shutdown is pending/);
  assert.equal(s.live.maxConcurrent, 4, "nothing applied");
  assert.equal(s.events.length, 0);
});

test("reload: an invalid config applies nothing", async () => {
  const s = setup({ loadNext: () => { throw new Error("bad config"); } });
  await assert.rejects(s.reload(), /bad config/);
  assert.equal(s.live.maxConcurrent, 4, "the previous config survives");
  assert.equal(s.events.length, 0);
});

test("reload: a restart-required key applies nothing and names the key", async () => {
  const s = setup({ loadNext: () => ({ ...cfg(), name: "other" }) });
  await assert.rejects(s.reload(), /restart required for: name/);
  assert.equal(s.live.name, "t", "nothing applied");
  assert.equal(s.events.length, 0);
});

test("reload: removing a harness drops its override from the store and the heartbeat overrides", async () => {
  const s = setup({
    loadNext: () => cfg({ harnesses: { h: { command: ["claude"] } } }),
    overrides: { harnesses: { h: 1, g: 5 } },
  });
  // The live config must actually have `g` for the diff to see its removal as a change.
  s.live.harnesses = { h: { command: ["claude"] }, g: { command: ["cursor"] } };
  const r = await s.reload();
  assert.deepEqual(r.changed, ["harnesses.g"]);
  assert.deepEqual(s.stored(), { harnesses: { h: 1 } }, "the override for the removed harness g was dropped");
  const last = s.heartbeats.at(-1);
  assert.deepEqual(last.overrides, { harnesses: { h: { value: 1, config: null } } }, "heartbeat overrides no longer list g");
  assert.equal(s.events.length, 1);
});

test("reload: a sandbox check failure applies nothing", async () => {
  const s = setup({
    loadNext: () => ({ ...cfg(), maxConcurrent: 8 }),
    checkImages: async () => ({ ok: false, reason: "image missing" }),
  });
  await assert.rejects(s.reload(), /sandbox check failed: image missing/);
  assert.equal(s.live.maxConcurrent, 4, "nothing applied");
  assert.equal(s.events.length, 0);
});
