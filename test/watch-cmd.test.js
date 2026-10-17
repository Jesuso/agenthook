import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// `agenthook watch` / `agenthook tick` over the isolated registry: the single-profile output
// shape stays exactly as before, and the multi-profile mode (#348) is `--all` / ≥2 names only.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { registryDir } from "../src/config.js";
import { watch } from "../src/commands/watch.js";
import { tick } from "../src/commands/tick.js";

/** A stopped profile (no pidfile: no live board/PR calls) with the given event lines. */
function profile(key, lines = []) {
  const dir = path.join(registryDir, key);
  fs.mkdirSync(path.join(dir, "logs"), { recursive: true });
  fs.writeFileSync(path.join(dir, "heartbeat.json"), JSON.stringify({ name: key, maxConcurrent: 2, tracker: "github" }));
  for (const f of ["running.json", "held.json", "refmeta.json"]) fs.writeFileSync(path.join(dir, f), "{}");
  fs.writeFileSync(path.join(dir, "queue.json"), "[]");
  fs.writeFileSync(path.join(dir, "events.jsonl"), lines.map((l) => JSON.stringify(l) + "\n").join(""));
  return dir;
}

profile("solo", [{ ts: "2026-01-01T00:00:00.000Z", event: "run_end", ref: "7", step: "code", outcome: "advance", extra: "x" }]);
profile("pa", [{ ts: "2026-01-01T00:00:02.000Z", event: "failed", ref: "1", step: "code", reason: "boom" }]);
profile("pb", [{ ts: "2026-01-01T00:00:01.000Z", event: "enqueued", ref: "2", step: "triage" }]);
const size = (k) => fs.statSync(path.join(registryDir, k, "events.jsonl")).size;

/** Run a command, capturing stdout/stderr lines and the exit code (then reset). @param {() => Promise<any>} fn */
async function run(fn) {
  const out = [];
  const err = [];
  const log = console.log;
  const error = console.error;
  console.log = (...a) => out.push(a.join(" "));
  console.error = (...a) => err.push(a.join(" "));
  try {
    await fn();
  } finally {
    console.log = log;
    console.error = error;
  }
  const code = process.exitCode ?? 0;
  process.exitCode = 0;
  return { out, err, code };
}

test("watch (one profile): --json and text output are unchanged — no profile tag, numeric cursor", async () => {
  const j = await run(() => watch({ _: ["solo"], json: true, cursor: "0", timeout: "1" }));
  assert.deepEqual(j.out, [`{"events":[{"ts":"2026-01-01T00:00:00.000Z","e":"run_end","ref":"7","step":"code","outcome":"advance"}],"cursor":${size("solo")}}`]);
  assert.equal(j.code, 0);
  const t = await run(() => watch({ _: ["solo"], cursor: "0", timeout: "1" }));
  assert.deepEqual(t.out, ["2026-01-01T00:00:00.000Z run_end 7/code → advance", `cursor ${size("solo")}`]);
  const quiet = await run(() => watch({ _: ["solo"], json: true, timeout: "0.05" }));
  assert.deepEqual(quiet.out, [`{"events":[],"cursor":${size("solo")},"timedOut":true}`]);
  assert.equal(quiet.code, 2);
});

test("watch a b: union, every event tagged with its profile, object cursor; text prefixes the state key", async () => {
  const j = await run(() => watch({ _: ["pa", "pb"], json: true, cursor: '{"pa":0,"pb":0}', timeout: "1" }));
  assert.equal(j.code, 0);
  const r = JSON.parse(j.out[0]);
  assert.deepEqual(r.events.map((e) => `${e.profile}:${e.e}:${e.ref}`), ["pb:enqueued:2", "pa:failed:1"], "merged by ts");
  assert.deepEqual(r.cursor, { pa: size("pa"), pb: size("pb") });
  const t = await run(() => watch({ _: ["pa", "pb"], cursor: '{"pa":0}', timeout: "1" }));
  assert.deepEqual(t.out, ["pa 2026-01-01T00:00:02.000Z failed 1/code (boom)", `cursor {"pa":${size("pa")},"pb":${size("pb")}}`]);
});

test("watch --all: timeout exits 2 with the object cursor; malformed --cursor and unknown names exit 1", async () => {
  const q = await run(() => watch({ _: [], all: true, json: true, timeout: "0.05" }));
  assert.equal(q.code, 2);
  assert.deepEqual(JSON.parse(q.out[0]), { events: [], cursor: { pa: size("pa"), pb: size("pb"), solo: size("solo") }, timedOut: true });
  const bad = await run(() => watch({ _: ["pa", "pb"], cursor: "12" }));
  assert.equal(bad.code, 1);
  assert.match(bad.err[0], /bad --cursor/);
  const unknown = await run(() => watch({ _: ["pa", "nope"] }));
  assert.equal(unknown.code, 1);
  assert.match(unknown.err[0], /unknown profile "nope"; known: pa, pb, solo/);
});

test("tick a b / --all: a JSON array of per-profile payloads (own etag + numeric cursor); text = one digest per profile", async () => {
  const j = await run(() => tick({ _: ["pa", "pb"], json: true, cursor: '{"pa":0}' }));
  const ticks = JSON.parse(j.out[0]);
  assert.deepEqual(ticks.map((t) => t.profile), ["pa", "pb"]);
  assert.deepEqual(ticks.map((t) => t.cursor), [size("pa"), size("pb")]);
  assert.deepEqual(ticks[0].events.map((e) => e.ref), ["1"]);
  assert.deepEqual(ticks[1].events, [], "missing key = from now");
  assert.ok(ticks.every((t) => typeof t.etag === "string"));
  const t = await run(() => tick({ _: [], all: true }));
  assert.equal(t.out.length, 1);
  const blocks = t.out[0].split("\n\n");
  assert.equal(blocks.length, 3);
  assert.match(blocks[0], /^pa DOWN/);
  const single = await run(() => tick({ _: ["solo"], json: true }));
  assert.equal(JSON.parse(single.out[0]).profile, "solo", "one name = the single-profile object");
  const bad = await run(() => tick({ _: [], all: true, cursor: "x" }));
  assert.equal(bad.code, 1);
});
