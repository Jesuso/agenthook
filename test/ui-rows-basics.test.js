import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// `ah ui` view model — buildRows' core status precedence and field derivation, plus the
// low-level state readers (readEventsTail / readProfileState) it's built on.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { buildRows, readEventsTail, readProfileState } from "../src/reader/rows.js";
import { tmp, writeState, state, row } from "./_ui-rows-helpers.js";

test("buildRows: one status per source, with precedence running > queued > board done > held > failed > idle", () => {
  const rows = buildRows(
    "p",
    state({
      running: { r1: { stepId: "code", startedAt: "2026-10-01T00:00:00Z", model: "opus" }, r6: { stepId: "review", startedAt: "t" } },
      queue: [{ kind: "pipeline", ref: "r2", stepId: "review", dedupKey: "k" }],
      held: { r3: { stepId: "triage", reason: "which db?", heldAt: "t" }, r6: { stepId: "code", heldAt: "t" } },
      refmeta: { r7: { displayId: "#7", title: "Seven" } },
      events: [
        { ts: "a", event: "run_start", ref: "r4", step: "code", model: "sonnet" },
        { ts: "b", event: "run_end", ref: "r4", step: "code", outcome: "fail" },
        { ts: "c", event: "failed", ref: "r4", step: "code", reason: "x", name: "Four" },
        { ts: "d", event: "pipeline_done", ref: "r5", step: "done", name: "Five" },
        { ts: "d", event: "board_done", ref: "r5", step: "", name: "Five" },
        { ts: "e", event: "merged", ref: "r8", step: "", name: "Eight" },
      ],
    }),
  );
  assert.equal(row(rows, "r1").status, "running");
  assert.equal(row(rows, "r1").step, "code");
  assert.equal(row(rows, "r1").model, "opus");
  assert.equal(row(rows, "r1").startedAt, "2026-10-01T00:00:00Z");
  assert.equal(row(rows, "r2").status, "queued");
  assert.equal(row(rows, "r2").step, "review");
  assert.equal(row(rows, "r3").status, "held");
  assert.equal(row(rows, "r3").heldReason, "which db?");
  assert.equal(row(rows, "r3").step, "triage");
  assert.equal(row(rows, "r4").status, "failed");
  assert.equal(row(rows, "r4").model, "sonnet");
  assert.equal(row(rows, "r4").startedAt, "a");
  assert.equal(row(rows, "r4").title, "Four");
  assert.equal(row(rows, "r5").status, "done");
  assert.equal(row(rows, "r5").step, "done");
  assert.equal(row(rows, "r8").status, "idle", "a merged PR alone is never done (ADR 0008)");
  assert.equal(row(rows, "r8").prState, "merged");
  assert.equal(row(rows, "r6").status, "running"); // running beats held
  assert.equal(row(rows, "r6").step, "review");
  assert.equal(row(rows, "r7").status, "idle");
  assert.equal(row(rows, "r7").step, null);
  assert.equal(rows.length, 8);
});

test("buildRows: ctx/ctxMax come from a running row, only while present (#658)", () => {
  const rows = buildRows(
    "p",
    state({
      running: {
        r1: { stepId: "code", startedAt: "t", model: "opus", ctx: 54000, ctxMax: 200000 },
        r2: { stepId: "code", startedAt: "t", model: "opus" },
      },
    }),
  );
  assert.deepEqual([row(rows, "r1").ctx, row(rows, "r1").ctxMax], [54000, 200000]);
  assert.equal(Object.hasOwn(row(rows, "r2"), "ctx"), false);
  assert.equal(Object.hasOwn(row(rows, "r2"), "ctxMax"), false);
});

test("buildRows: up:false reads running as interrupted and queued as stalled; held/terminal/idle unchanged", () => {
  const s = state({
    running: { r1: { stepId: "code", startedAt: "t" } },
    queue: [{ kind: "pipeline", ref: "r2", stepId: "review", dedupKey: "k" }],
    held: { r3: { stepId: "triage", reason: "?", heldAt: "t" } },
    events: [{ ts: "a", event: "pipeline_done", ref: "r5", step: "done", name: "Five" }, { ts: "b", event: "board_done", ref: "r5", step: "" }],
  });
  const down = buildRows("p", s, { up: false });
  assert.equal(row(down, "r1").status, "interrupted");
  assert.equal(row(down, "r2").status, "stalled");
  assert.equal(row(down, "r3").status, "held");
  assert.equal(row(down, "r5").status, "done");

  const explicitUp = buildRows("p", s, { up: true });
  assert.equal(row(explicitUp, "r1").status, "running");
  assert.equal(row(explicitUp, "r2").status, "queued");

  const defaulted = buildRows("p", s);
  assert.equal(row(defaulted, "r1").status, "running");
  assert.equal(row(defaulted, "r2").status, "queued");
});

test("buildRows: a terminal event followed by a re-run no longer counts", () => {
  const rows = buildRows(
    "p",
    state({
      events: [
        { ts: "a", event: "failed", ref: "r", step: "code" },
        { ts: "b", event: "run_start", ref: "r", step: "code" },
        { ts: "c", event: "run_end", ref: "r", step: "code", outcome: "advance" },
      ],
    }),
  );
  assert.equal(row(rows, "r").status, "idle");
});

test("buildRows: displayId falls back to ref; costUsd sums run_end; trackerUrl only from refmeta.url", () => {
  const rows = buildRows(
    "p",
    state({
      refmeta: { a: { displayId: "#94", title: "T" }, b: { url: "https://app.asana.com/0/1/2" }, c: { url: "javascript:alert(1)" } },
      events: [
        { ts: "1", event: "run_end", ref: "a", step: "code", costUsd: 1.25 },
        { ts: "2", event: "run_end", ref: "a", step: "review", costUsd: 0.5 },
        { ts: "3", event: "run_end", ref: "a", step: "review" },
        { ts: "4", event: "run_start", ref: "b", step: "code" },
      ],
    }),
  );
  assert.equal(row(rows, "a").displayId, "#94");
  assert.equal(row(rows, "a").title, "T");
  assert.equal(row(rows, "a").costUsd, 1.75);
  assert.equal(row(rows, "a").trackerUrl, null);
  assert.equal(row(rows, "b").displayId, "b");
  assert.equal(row(rows, "b").costUsd, 0);
  assert.equal(row(rows, "b").trackerUrl, "https://app.asana.com/0/1/2");
  assert.equal(row(rows, "c").trackerUrl, null); // non-http(s) is never a link
});

test("buildRows: prUrl needs both a well-formed repository and refmeta.pr", () => {
  const s = state({ refmeta: { a: { pr: 12 }, b: {} } });
  assert.equal(row(buildRows("p", s, { repository: "Jesuso/agenthook" }), "a").prUrl, "https://github.com/Jesuso/agenthook/pull/12");
  assert.equal(row(buildRows("p", s, { repository: "Jesuso/agenthook" }), "b").prUrl, null);
  assert.equal(row(buildRows("p", s), "a").prUrl, null);
  assert.equal(row(buildRows("p", s, { repository: "evil.com/x/y" }), "a").prUrl, null);
  assert.equal(row(buildRows("p", s, { repository: "a/b?x" }), "a").prUrl, null);
});

test("buildRows: epic from refmeta.epic — name falls back to ref, non-http url dropped, malformed → null", () => {
  const rows = buildRows(
    "p",
    state({
      refmeta: {
        a: { epic: { ref: "E1", name: "Epics", url: "https://app.asana.com/0/1/E1" } },
        b: { epic: { ref: "E2", url: "javascript:alert(1)" } },
        c: { title: "no epic" },
        d: { epic: { ref: "", name: "empty ref" } },
        e: { epic: "E3" },
        f: { epic: { ref: 7, name: "numeric ref" } },
        g: { epic: { ref: "E4", name: 9, url: 9 } },
      },
    }),
  );
  assert.deepEqual(row(rows, "a").epic, { ref: "E1", name: "Epics", url: "https://app.asana.com/0/1/E1" });
  assert.deepEqual(row(rows, "b").epic, { ref: "E2", name: "E2", url: null });
  for (const ref of ["c", "d", "e", "f"]) assert.equal(row(rows, ref).epic, null, ref);
  assert.deepEqual(row(rows, "g").epic, { ref: "E4", name: "E4", url: null });
});

test("buildRows: prototype-named refs don't resolve through Object.prototype", () => {
  const rows = buildRows("p", state({ events: [{ ts: "1", event: "run_end", ref: "constructor", step: "code" }] }));
  assert.equal(row(rows, "constructor").status, "idle");
});

test("readEventsTail parses only the tail and drops the partial first line", () => {
  const dir = tmp();
  const file = path.join(dir, "events.jsonl");
  const lines = [];
  for (let i = 0; i < 200; i++) lines.push(JSON.stringify({ ts: String(i), event: "enqueued", ref: `r${i}`, step: "code" }));
  fs.writeFileSync(file, lines.join("\n") + "\n");
  const lineLen = lines[150].length + 1;
  // A byte budget that lands mid-line: the 50 last full lines plus a fragment of the one before.
  const tail = readEventsTail(file, lineLen * 50 + 5);
  assert.equal(tail.length, 50);
  assert.equal(tail[0].ref, "r150");
  assert.equal(tail.at(-1)?.ref, "r199");
  // Exactly on a line boundary the first line is complete and kept.
  const exact = readEventsTail(file, lines.slice(150).join("\n").length + 1);
  assert.equal(exact[0].ref, "r150");
  assert.equal(exact.length, 50);
});

test("readEventsTail skips garbage lines; missing file → []", () => {
  const dir = tmp();
  const file = path.join(dir, "events.jsonl");
  fs.writeFileSync(file, `not json\n${JSON.stringify({ ts: "1", event: "run_start", ref: "a" })}\n[1,2]\n{"ts":"2"}\n{"ref":`);
  const ev = readEventsTail(file);
  assert.deepEqual(ev.map((e) => e.ref), ["a"]);
  assert.deepEqual(readEventsTail(path.join(dir, "nope.jsonl")), []);
});

test("readProfileState: missing or garbage state files read as empty without throwing", () => {
  const dir = tmp();
  assert.deepEqual(readProfileState(dir), { running: {}, queue: [], held: {}, refmeta: {}, quota: null, events: [] });
  writeState(dir, { "running.json": "{oops", "queue.json": { not: "array" }, "held.json": [1], "refmeta.json": "null", "quota.json": [1], "events.jsonl": "\0\0\0" });
  assert.deepEqual(readProfileState(dir), { running: {}, queue: [], held: {}, refmeta: {}, quota: null, events: [] });
  writeState(dir, { "queue.json": [null, 3, { ref: "q", stepId: "code" }] });
  assert.deepEqual(readProfileState(dir).queue, [{ ref: "q", stepId: "code" }]);
});
