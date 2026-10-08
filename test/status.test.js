import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// `agenthook status` — pure-unit coverage for mapping a run-log filename back to its
// ref (so the recent-runs list can show the human id / PR / title from refmeta).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { registryDir } from "../src/config.js";
import { provenanceLines, refForLog, status } from "../src/commands/status.js";

test("refForLog resolves the ref from a run-log filename among known refs", () => {
  const refs = ["94", "1218828631775704", "ABC-7"];
  assert.equal(refForLog("2026-09-24T10-00-00-000Z-step-code-94.log", refs), "94");
  assert.equal(refForLog("2026-09-24T10-00-00-000Z-step-self-review-1218828631775704.log", refs), "1218828631775704");
  assert.equal(refForLog("2026-09-24T10-00-00-000Z-step-code-ABC-7.log", refs), "ABC-7");
});

test("refForLog prefers the longest match and returns undefined when unknown", () => {
  assert.equal(refForLog("2026-09-24T10-00-00-000Z-step-code-194.log", ["94", "194"]), "194");
  assert.equal(refForLog("2026-09-24T10-00-00-000Z-step-code-555.log", ["94"]), undefined);
});

test("provenanceLines: full config path (+ missing), created date, last seen; ghost → one 'never ran' line", () => {
  const base = { stateKey: "k", name: "K", createdAt: "2026-01-02T03:04:05.000Z", lastSeenAt: null, ghost: false, configMissing: false };
  const lines = provenanceLines({ ...base, configPath: "/home/u/proj/agenthook.config.json" });
  assert.equal(lines[0], "config  : /home/u/proj/agenthook.config.json");
  assert.match(lines[1], /^created : 2026-01-02 \(\d+d ago\)$/);
  assert.equal(lines[2], "last seen: never");
  assert.equal(provenanceLines({ ...base, configPath: "/x.json", configMissing: true })[0], "config  : /x.json (missing)");
  assert.equal(provenanceLines({ ...base, configPath: null })[0], "config  : ?");
  assert.deepEqual(provenanceLines({ ...base, configPath: null, ghost: true }), [
    "config  : — never ran (created 2026-01-02); created by a command that read a config named K; safe to remove (ah remove k)",
  ]);
});

/** Run `status <name>` and capture its stdout lines. @param {string} name */
async function runStatus(name) {
  const out = [];
  const log = console.log;
  console.log = (/** @type {any} */ l) => out.push(String(l));
  try {
    await status({ _: [name] });
  } finally {
    console.log = log;
  }
  return out;
}

test("status: a cleanly-stopped profile (marker only) is shown, not 'no such profile'; a ghost says never ran", async () => {
  const dir = path.join(registryDir, "status-stopped");
  fs.mkdirSync(dir, { recursive: true });
  const cfgFile = path.join(registryDir, "status-stopped.config.json");
  fs.writeFileSync(path.join(dir, "profile.json"), JSON.stringify({ name: "Stopped", stateKey: "status-stopped", configPath: cfgFile, createdAt: "2026-01-02T00:00:00.000Z", updatedAt: "2026-01-03T00:00:00.000Z" }));
  const out = await runStatus("Stopped");
  assert.equal(out[0], "profile : Stopped (state status-stopped)");
  assert.equal(out[1], "status  : down");
  assert.equal(out[2], `config  : ${cfgFile} (missing)`);
  assert.match(out[3], /^created : 2026-01-02 /);
  assert.match(out[4], /^last seen: \d+d ago$/);

  fs.mkdirSync(path.join(registryDir, "status-ghost", "logs"), { recursive: true });
  const ghost = await runStatus("status-ghost");
  assert.equal(ghost.length, 3);
  assert.match(ghost[2], /^config  : — never ran \(created \d{4}-\d\d-\d\d\); .*safe to remove \(ah remove status-ghost\)$/);

  assert.deepEqual(await runStatus("status-nope"), ['no such profile "status-nope" (nothing under ~/.agenthook/status-nope).']);
});
