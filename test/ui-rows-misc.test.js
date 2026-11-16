import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// `ah ui` view model — recentRuns, profileView's harness/forge/unharnessed fields, the
// buildRows display-only fields (summary/plain/options), and the host/url helpers
// `ah ui` uses to print where it's listening.
import test from "node:test";
import assert from "node:assert/strict";
import { buildRows, profileView, recentRuns } from "../src/ui/rows.js";
import { uiHost, uiUrls } from "../src/commands/ui.js";
import { state, row } from "./_ui-rows-helpers.js";

test("recentRuns: run_end within 48 h with its outcome, oldest first; garbage ts or other events are skipped", () => {
  const now = Date.parse("2026-10-08T12:00:00Z");
  const events = [
    { ts: "2026-10-05T12:00:00Z", event: "run_end", outcome: "advance" }, // too old
    { ts: "2026-10-07T13:00:00Z", event: "run_end", outcome: "changes" },
    { ts: "garbage", event: "run_end", outcome: "advance" },
    { ts: "2026-10-08T11:00:00Z", event: "run_start" },
    { ts: "2026-10-08T11:30:00Z", event: "run_end" },
  ];
  assert.deepEqual(recentRuns(events, now), [
    { at: "2026-10-07T13:00:00.000Z", outcome: "changes" },
    { at: "2026-10-08T11:30:00.000Z", outcome: null },
  ]);
});

test("profileView: forge is the heartbeat's forge type, else null", () => {
  assert.equal(profileView({ name: "k", pid: 1, up: true, heartbeat: { forge: "github" } }).forge, "github");
  assert.equal(profileView({ name: "k", pid: 1, up: true, heartbeat: {} }).forge, null);
});

test("buildRows: summary comes from refmeta, is bounded, and is null for non-strings/absent", () => {
  const rows = buildRows(
    "p",
    state({ refmeta: { a: { summary: "What it is about." }, b: { summary: "x".repeat(900) }, c: { summary: 7 }, d: { title: "T" } } }),
  );
  const by = Object.fromEntries(rows.map((r) => [r.ref, r.summary]));
  assert.equal(by.a, "What it is about.");
  assert.equal(by.b?.length, 300);
  assert.equal(by.c, null);
  assert.equal(by.d, null);
});

test("buildRows: plain is the newest run_end's sentence only while its outcome matches the status (#563)", () => {
  const end = (/** @type {string} */ ref, /** @type {string} */ outcome, /** @type {string} */ ts, plain = `${ref} ${outcome}`) => ({ ts, event: "run_end", ref, step: "code", outcome, plain });
  const rows = buildRows(
    "p",
    state({
      running: { run: { stepId: "review", startedAt: "t" } },
      queue: [{ kind: "pipeline", ref: "q", stepId: "review", dedupKey: "k" }],
      held: { h: { stepId: "code", reason: "which db?" }, hx: { stepId: "code", reason: "cap" }, none: { stepId: "code" } },
      events: [
        end("run", "advance", "a"),
        end("q", "changes", "a"),
        end("h", "advance", "a", "older"),
        end("h", "hold", "b"),
        end("hx", "changes", "a"), // the changes cap turned it into a hold
        end("f", "fail", "a"),
        { ts: "b", event: "failed", ref: "f", step: "code", reason: "tests red" },
        end("fc", "fail", "a"),
        { ts: "b", event: "failed", ref: "fc", step: "code", reason: "cancelled by operator" },
        end("d", "advance", "a"),
        { ts: "b", event: "pipeline_done", ref: "d", step: "code" },
        { ts: "b", event: "board_done", ref: "d", step: "code" },
        end("dx", "advance", "a"),
        { ts: "b", event: "failed", ref: "dx", step: "code", reason: "move refused" },
        end("i", "advance", "a"),
        { ts: "a", event: "run_end", ref: "none", step: "code", outcome: "hold" },
      ],
    }),
  );
  assert.equal(row(rows, "run").plain, "run advance", "running: the previous step's sentence");
  assert.equal(row(rows, "q").plain, "q changes", "queued: any outcome");
  assert.equal(row(rows, "h").plain, "h hold", "the newest run_end wins");
  assert.equal(row(rows, "hx").plain, null, "held, but the run said changes");
  assert.equal(row(rows, "f").plain, "f fail");
  assert.equal(row(rows, "fc").status, "cancelled");
  assert.equal(row(rows, "fc").plain, null, "cancelled shows none");
  assert.equal(row(rows, "d").plain, "d advance");
  assert.equal(row(rows, "dx").plain, null, "failed, but the run said advance");
  assert.equal(row(rows, "i").status, "idle");
  assert.equal(row(rows, "i").plain, null, "idle shows none");
  assert.equal(row(rows, "none").status, "held");
  assert.equal(row(rows, "none").plain, null, "a matching run_end with no plain");
});

test("buildRows: options is the newest run_end's options only while held with a hold outcome; re-validated defensively (#565)", () => {
  const end = (/** @type {string} */ ref, /** @type {string} */ outcome, /** @type {any} */ options) => ({ ts: "a", event: "run_end", ref, step: "code", outcome, options });
  const rows = buildRows(
    "p",
    state({
      held: {
        h: { stepId: "code", reason: "which db?" },
        hx: { stepId: "code", reason: "cap" },
        hbad: { stepId: "code", reason: "x" },
        hnone: { stepId: "code", reason: "x" },
      },
      events: [
        end("h", "hold", ["Postgres", "SQLite"]),
        end("hx", "changes", ["Postgres", "SQLite"]), // the changes cap turned it into a hold without a matching run_end
        end("d", "advance", ["Postgres", "SQLite"]),
        end("hbad", "hold", ["only one"]),
        end("hbad2", "hold", "not an array"),
        end("hlong", "hold", ["x".repeat(90), "y".repeat(90)]),
      ],
    }),
  );
  assert.deepEqual(row(rows, "h").options, ["Postgres", "SQLite"], "held + hold outcome → kept");
  assert.equal(row(rows, "hx").status, "held");
  assert.equal(row(rows, "hx").options, null, "held, but the newest run_end outcome is \"changes\", not \"hold\" → null");
  assert.equal(row(rows, "d").status, "idle");
  assert.equal(row(rows, "d").options, null, "not held → null even with a hold-shaped run_end elsewhere");
  assert.equal(row(rows, "hnone").options, null, "held, no run_end options → null");
  assert.equal(row(rows, "hbad").options, null, "held, but options is 1 entry → null (re-validated)");
  assert.equal(row(rows, "hbad2").status, "idle", "no held record for this ref");
  assert.equal(row(rows, "hbad2").options, null, "not held → null regardless of the malformed run_end options");

  const longRows = buildRows("p", state({ held: { hlong: { stepId: "code", reason: "x" } }, events: [end("hlong", "hold", ["x".repeat(90), "y".repeat(90)])] }));
  assert.deepEqual(row(longRows, "hlong").options, ["x".repeat(80), "y".repeat(80)], "each entry sliced to 80 chars");
});

test("buildRows: a board_done alone makes no row; after a run it changes nothing (#585)", () => {
  const events = [
    { ts: "2026-10-27T00:00:00Z", event: "board_done", ref: "9", step: "", via: "flag" },
    { ts: "2026-10-27T00:00:00Z", event: "run_start", ref: "1", step: "code" },
    { ts: "2026-10-27T00:01:00Z", event: "pipeline_done", ref: "1", step: "done", name: "One" },
    { ts: "2026-10-27T00:01:00Z", event: "board_done", ref: "1", step: "", name: "One" },
    { ts: "2026-10-27T00:02:00Z", event: "board_done", ref: "1", step: "", via: "flag" },
  ];
  const rows = buildRows("p", state({ events }));
  assert.deepEqual(rows.map((r) => r.ref), ["1"]);
  assert.equal(row(rows, "1").status, "done");
  assert.equal(row(rows, "1").step, "done");
});

test("profileView: harnesses = heartbeat.queue.harnesses when up; no key when down or without harnesses (#620)", () => {
  const heartbeat = { maxConcurrent: 4, queue: { active: 1, queued: 0, harnesses: { qwen: { active: 1, max: 2 }, opus: { active: 0, max: null } } } };
  assert.deepEqual(profileView({ name: "p", pid: 1, up: true, heartbeat }).harnesses, { qwen: { active: 1, max: 2 }, opus: { active: 0, max: null } });
  assert.equal("harnesses" in profileView({ name: "p", pid: 1, up: false, heartbeat }), false);
  assert.equal("harnesses" in profileView({ name: "p", pid: 1, up: true, heartbeat: { queue: { active: 0, queued: 0 } } }), false);
});

test("profileView: harnesses keeps max: 0 (drained via set_concurrency, #640) instead of mapping it to null", () => {
  const heartbeat = { maxConcurrent: 4, queue: { active: 0, queued: 0, harnesses: { local: { active: 1, max: 0 } } } };
  assert.deepEqual(profileView({ name: "p", pid: 1, up: true, heartbeat }).harnesses, { local: { active: 1, max: 0 } });
});

test("profileView: unharnessed = heartbeat.queue.unharnessed when up; no key when down, empty, or absent (#726)", () => {
  const heartbeat = { maxConcurrent: 4, queue: { active: 1, queued: 0, unharnessed: { claude: 1 } } };
  assert.deepEqual(profileView({ name: "p", pid: 1, up: true, heartbeat }).unharnessed, { claude: 1 });
  assert.equal("unharnessed" in profileView({ name: "p", pid: 1, up: false, heartbeat }), false);
  assert.equal("unharnessed" in profileView({ name: "p", pid: 1, up: true, heartbeat: { queue: { active: 0, queued: 0 } } }), false);
  assert.equal("unharnessed" in profileView({ name: "p", pid: 1, up: true, heartbeat: { queue: { active: 0, queued: 0, unharnessed: {} } } }), false);
});

test("profileView: unharnessed drops a non-positive-integer entry", () => {
  const heartbeat = { queue: { active: 1, queued: 0, unharnessed: { claude: 1, cursor: 0, opencode: -1, hermes: 1.5 } } };
  assert.deepEqual(profileView({ name: "p", pid: 1, up: true, heartbeat }).unharnessed, { claude: 1 });
});

test("uiHost: default loopback; localhost → 127.0.0.1; ip literals pass; a DNS name or junk throws", () => {
  assert.equal(uiHost({}), "127.0.0.1");
  assert.equal(uiHost({ host: "localhost" }), "127.0.0.1");
  assert.equal(uiHost({ host: "0.0.0.0" }), "0.0.0.0");
  assert.equal(uiHost({ host: "192.168.68.2" }), "192.168.68.2");
  assert.equal(uiHost({ host: "::" }), "::");
  for (const bad of ["sarah.lan", "", true, "300.1.1.1"]) assert.throws(() => uiHost({ host: bad }), /invalid --host/, String(bad));
});

test("uiUrls: the bound address, or loopback for a wildcard bind (#737)", () => {
  assert.deepEqual(uiUrls("127.0.0.1", 4180, "t"), ["http://127.0.0.1:4180/?token=t"]);
  assert.deepEqual(uiUrls("192.168.68.2", 4180, "t"), ["http://192.168.68.2:4180/?token=t"]);
  assert.deepEqual(uiUrls("::1", 4180, "t"), ["http://[::1]:4180/?token=t"]);
  assert.deepEqual(uiUrls("0.0.0.0", 4180, "t"), ["http://127.0.0.1:4180/?token=t"]);
  assert.deepEqual(uiUrls("::", 4180, "t"), ["http://127.0.0.1:4180/?token=t"]);
});
