// Reusable `ah ui` fixture: a temp AGENTHOOK_HOME with one up profile and one down profile
// carrying stale running.json/queue.json (issue #222 — a down profile's leftovers must not
// read as live `running`/`queued`). Used by the visual check below and reusable for any other
// manual/visual pass over the dashboard.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** @param {string} dir @param {Record<string, any>} files */
function writeState(dir, files) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, v] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), typeof v === "string" ? v : JSON.stringify(v, null, 2));
  }
}

/** Seeds a fresh temp registry and returns its path.
 * @returns {string} */
export function seedFixtureRegistry() {
  const registry = fs.mkdtempSync(path.join(os.tmpdir(), "ah-ui-fixture-"));

  writeState(path.join(registry, "alive"), {
    "server.pid": String(process.pid), // this process stays alive for the fixture's lifetime
    "heartbeat.json": {
      name: "alive",
      pid: process.pid,
      port: 8787,
      tracker: "github",
      ingress: "ngrok",
      fullAuto: true,
      repository: "Jesuso/agenthook",
      startedAt: "2026-10-01T00:00:00Z",
      updatedAt: "2026-10-08T00:00:00Z",
      queue: { active: 1, queued: 1 },
    },
    "running.json": { 301: { stepId: "code", startedAt: "2026-10-08T09:00:00Z", model: "claude-opus-5-5" } },
    "queue.json": [{ kind: "pipeline", ref: "302", stepId: "review", dedupKey: "k1" }],
    "refmeta.json": {
      301: { displayId: "#301", title: "Add retry to webhook delivery", url: "https://github.com/Jesuso/agenthook/issues/301" },
      302: { displayId: "#302", title: "Trim stale ngrok tunnels on boot", url: "https://github.com/Jesuso/agenthook/issues/302" },
    },
  });

  writeState(path.join(registry, "down"), {
    "server.pid": "999999999", // not a live pid — the receiver is down
    "heartbeat.json": {
      name: "down",
      pid: 999999999,
      port: 8788,
      tracker: "github",
      ingress: "ngrok",
      fullAuto: true,
      repository: "Jesuso/agenthook",
      startedAt: "2026-09-10T00:00:00Z",
      updatedAt: "2026-09-14T00:00:00Z",
      queue: { active: 1, queued: 1 },
    },
    // Leftover from before the receiver died — crash recovery resolves these on next boot,
    // but until then the dashboard must not show them as live.
    "running.json": { 229: { stepId: "code", startedAt: "2026-09-14T00:00:00Z", model: "claude-sonnet-5-5" } },
    "queue.json": [{ kind: "pipeline", ref: "232", stepId: "review", dedupKey: "k2" }],
    "refmeta.json": {
      229: { displayId: "CAHUI-229", title: "Flaky retry on 502 from tracker", url: "https://example.atlassian.net/browse/CAHUI-229" },
      232: { displayId: "CAHUI-232", title: "Dedup key collision on re-enqueue", url: "https://example.atlassian.net/browse/CAHUI-232" },
    },
  });

  return registry;
}

// Runnable standalone: prints the seeded registry path for a quick manual look.
if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(seedFixtureRegistry());
}
