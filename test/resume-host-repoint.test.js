import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// The resume re-point guard (src/commands/resume.js) can only fire when the SESSION carries the
// host the run actually used — `listSessions` now reads `rec.host ?? <config host>` (#829).
// Before the sessions.js fix the entry always carried TODAY's config host, so editing
// `harnesses.<name>.remote.host` after a run let `resume` target the WRONG worker.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { createStore } from "../src/store/index.js";
import { resume } from "../src/commands/resume.js";

let n = 0;
const madeState = [];
/** @param {{pipeline?: any[], harnesses?: (p: any) => any}} o */
function makeProfile(o = {}) {
  n++;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `ah-rhr-${n}-`));
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  const file = path.join(root, "agenthook.config.json");
  const prof = { root, file, stateKey: `rr${n}` };
  fs.writeFileSync(
    file,
    JSON.stringify({
      name: `rr${n}`,
      stateId: `rr${n}`,
      repoPath: repo,
      tracker: { type: "asana", pipeline: o.pipeline ?? [{ id: "code" }] },
      ...(o.harnesses ? { harnesses: o.harnesses(prof) } : {}),
    }),
  );
  madeState.push(prof.stateKey);
  return prof;
}
test.after(() => {
  for (const k of madeState) {
    try {
      fs.rmSync(path.join(process.env.AGENTHOOK_HOME ?? path.join(os.homedir(), ".agenthook"), k), { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

/** @param {any} cfg */
function storeFor(cfg) {
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  return createStore(cfg.dataDir);
}
/** @param {() => Promise<void>} fn @returns {Promise<string>} */
async function withLogs(fn) {
  const out = [];
  const orig = console.log;
  console.log = (...a) => out.push(a.join(" "));
  try {
    await fn();
  } finally {
    console.log = orig;
  }
  return out.join("\n");
}
/** @param {any} store @param {string} host */
function recordRemoteUsage(store, host) {
  store.recordUsage({
    ref: "7", stepId: "code", sessionId: "rs-1", startedAt: new Date().toISOString(),
    agent: "claude", harness: "worker", host, remoteCwd: "/w/7",
  });
}

test("resume refuses when the harness's host changed after the run — the session carries the run's host", async () => {
  const prof = makeProfile({
    pipeline: [{ id: "code", createsWorktree: true }],
    harnesses: () => ({ worker: { remote: { host: "worker.test", workDir: "/w" } } }),
  });
  const store = storeFor(loadConfig({ configPath: prof.file }));
  recordRemoteUsage(store, "repointed.test"); // the run happened on a DIFFERENT host
  await assert.rejects(
    withLogs(() => resume({ config: prof.file, _: ["7", "rs-1"] })),
    /harness "worker" \(host "repointed\.test"\) is no longer in the config/,
    "hosts differ (run's host vs today's config) → refuse instead of reaching the wrong worker",
  );
});

test("resume does NOT refuse when the recorded host matches today's config", async () => {
  const prof = makeProfile({
    pipeline: [{ id: "code", createsWorktree: true }],
    harnesses: () => ({ worker: { remote: { host: "worker.test", workDir: "/w" } } }),
  });
  const store = storeFor(loadConfig({ configPath: prof.file }));
  recordRemoteUsage(store, "worker.test");
  const err = /** @type {Error} */ (await withLogs(() => resume({ config: prof.file, _: ["7", "rs-1"] })).then(() => null, (e) => e));
  // Whatever the ssh outcome (the fake host is unreachable in CI), it must NOT be the re-point refusal.
  assert.ok(!/no longer in the config/.test(err?.message ?? ""), `got: ${err?.message}`);
});
