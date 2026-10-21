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

// ---- --follow (#505). These run last: they add profiles the `--all` tests above would count.

/** Append event lines to a profile's log. @param {string} key @param {Record<string, any>[]} lines */
const append = (key, lines) => fs.appendFileSync(path.join(registryDir, key, "events.jsonl"), lines.map((l) => JSON.stringify(l) + "\n").join(""));
const ev = (ref, event = "run_end", ts = "2026-01-02T00:00:00.000Z") => ({ ts, event, ref, step: "code" });

/** Start a `--follow` stream with stdout/stderr captured; `stop()` aborts it and resolves the captured run. */
function follow(args) {
  const out = [];
  const err = [];
  const log = console.log;
  const error = console.error;
  console.log = (...a) => out.push(a.join(" "));
  console.error = (...a) => err.push(a.join(" "));
  const ac = new AbortController();
  let settled = false;
  const done = watch({ follow: true, ...args }, { signal: ac.signal }).finally(() => {
    settled = true;
    console.log = log;
    console.error = error;
  });
  const result = async () => {
    await done;
    const code = process.exitCode ?? 0;
    process.exitCode = 0;
    return { out: out.map((l) => JSON.parse(l)), err, code };
  };
  return { out, err, settled: () => settled, result, stop: () => (ac.abort(), result()) };
}

/** Wait (bounded) for `pred` to hold. @param {() => boolean} pred */
async function until(pred, ms = 3000) {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("watch --follow: one JSON line per event with its exact cursor, stays attached; abort → watch_end, exit 0", async () => {
  profile("fsolo");
  const s = follow({ _: ["fsolo"], json: true });
  await new Promise((r) => setTimeout(r, 30));
  append("fsolo", [ev("1")]);
  const afterFirst = size("fsolo");
  append("fsolo", [ev("2")]);
  await until(() => s.out.length >= 2);
  assert.equal(s.settled(), false, "still streaming");
  const r = await s.stop();
  assert.equal(r.code, 0);
  assert.deepEqual(r.out.slice(0, 2).map((l) => [l.e, l.ref, l.cursor]), [["run_end", "1", afterFirst], ["run_end", "2", size("fsolo")]]);
  assert.deepEqual(r.out.at(-1), { e: "watch_end", cursor: size("fsolo") });
  assert.equal(r.out.length, 3);
});

test("watch --follow: a printed cursor resumes one-shot watch exactly, even with non-matching lines between", async () => {
  profile("fgap");
  const s = follow({ _: ["fgap"], event: "run_end" });
  await new Promise((r) => setTimeout(r, 30));
  append("fgap", [ev("1"), ev("x", "enqueued"), ev("y", "enqueued"), ev("2"), ev("z", "enqueued")]);
  await until(() => s.out.length >= 2);
  const r = await s.stop();
  const [first, second, end] = r.out;
  assert.deepEqual([first.ref, second.ref], ["1", "2"]);
  assert.ok(second.cursor < size("fgap"), "the event cursor sits before the trailing non-matching line");
  assert.deepEqual(end, { e: "watch_end", cursor: size("fgap") }, "the batch-end cursor ends the stream");
  const resumed = await run(() => watch({ _: ["fgap"], json: true, event: "run_end", cursor: String(first.cursor), timeout: "1" }));
  assert.deepEqual(JSON.parse(resumed.out[0]).events.map((e) => e.ref), ["2"], "exactly the second event, no dupes");
  const tail = await run(() => watch({ _: ["fgap"], json: true, event: "run_end", cursor: String(second.cursor), timeout: "0.05" }));
  assert.deepEqual(JSON.parse(tail.out[0]).events, [], "nothing after the last printed event");
  assert.equal(tail.code, 2);
});

test("watch --follow --timeout: watch_end carries timedOut, exit 2; --heartbeat prints keepalive lines", async () => {
  profile("fquiet");
  const t = await follow({ _: ["fquiet"], timeout: "0.1" }).result();
  assert.equal(t.code, 2);
  assert.deepEqual(t.out, [{ e: "watch_end", cursor: size("fquiet"), timedOut: true }]);
  const h = follow({ _: ["fquiet"], heartbeat: "0.03" });
  await until(() => h.out.length >= 2);
  const r = await h.stop();
  assert.equal(r.code, 0);
  assert.ok(r.out.slice(0, -1).length >= 2);
  for (const l of r.out.slice(0, -1)) assert.deepEqual(l, { e: "heartbeat", cursor: size("fquiet") });
  assert.equal(r.out.at(-1).e, "watch_end");
});

test("watch a b --follow: lines tagged with profile; each object cursor resumes exactly", async () => {
  profile("fa");
  profile("fb");
  const start = { fa: size("fa"), fb: size("fb") };
  const s = follow({ _: ["fa", "fb"], cursor: JSON.stringify(start) });
  await new Promise((r) => setTimeout(r, 30));
  append("fa", [ev("a1", "run_end", "2026-01-02T00:00:03.000Z")]);
  append("fb", [ev("b1", "run_end", "2026-01-02T00:00:01.000Z")]);
  await until(() => s.out.length >= 2);
  append("fa", [ev("a2", "run_end", "2026-01-02T00:00:05.000Z")]);
  await until(() => s.out.length >= 3);
  const r = await s.stop();
  const events = r.out.filter((l) => l.e === "run_end");
  assert.deepEqual(events.map((l) => `${l.profile}:${l.ref}`).sort(), ["fa:a1", "fa:a2", "fb:b1"]);
  assert.deepEqual(r.out.at(-1), { e: "watch_end", cursor: { fa: size("fa"), fb: size("fb") } });
  for (const [i, l] of events.entries()) {
    const rest = events.slice(i + 1).map((x) => `${x.profile}:${x.ref}`).sort();
    const q = await run(() => watch({ _: ["fa", "fb"], json: true, cursor: JSON.stringify(l.cursor), timeout: "0.05" }));
    const got = [];
    let cur = l.cursor;
    let res = JSON.parse(q.out[0]);
    while (res.events.length) {
      got.push(...res.events.map((e) => `${e.profile}:${e.ref}`));
      cur = res.cursor;
      const n = await run(() => watch({ _: ["fa", "fb"], json: true, cursor: JSON.stringify(cur), timeout: "0.05" }));
      res = JSON.parse(n.out[0]);
    }
    assert.deepEqual(got.sort(), rest, `resume from line ${i}`);
  }
});

test("parse: --follow/--stream are booleans, --heartbeat takes a value", async () => {
  const { parse } = await import("../bin/agenthook.js");
  const a = parse(["--follow", "--heartbeat", "5", "p"]); // the post-command args main() parses
  assert.equal(a.heartbeat, "5");
  assert.equal(a.follow, true);
  assert.deepEqual(a._, ["p"]);
  assert.equal(parse(["--stream", "p"]).stream, true);
});
