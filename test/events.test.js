import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createEmitter } from "../src/events.js";

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "agenthook-events-"));

/** Read and parse events.jsonl from a dir, returning array of objects. */
function readEvents(dir) {
  const file = path.join(dir, "events.jsonl");
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

test("emit appends one JSON line per call with ts, event, ref, step", () => {
  const dir = tmpDir();
  const emit = createEmitter(dir);
  emit("enqueued", "42", "code");
  emit("run_start", "42", "code", { model: "claude-opus-4-5" });

  const evs = readEvents(dir);
  assert.equal(evs.length, 2);
  assert.equal(evs[0].event, "enqueued");
  assert.equal(evs[0].ref, "42");
  assert.equal(evs[0].step, "code");
  assert.ok(evs[0].ts, "ts present");

  assert.equal(evs[1].event, "run_start");
  assert.equal(evs[1].model, "claude-opus-4-5");
});

test("emit appends run_end with outcome and optional costUsd", () => {
  const dir = tmpDir();
  const emit = createEmitter(dir);
  emit("run_end", "7", "review", { outcome: "advance", costUsd: 0.05 });

  const [ev] = readEvents(dir);
  assert.equal(ev.event, "run_end");
  assert.equal(ev.outcome, "advance");
  assert.equal(ev.costUsd, 0.05);
});

test("emit appends blocked and failed with reason", () => {
  const dir = tmpDir();
  const emit = createEmitter(dir);
  emit("blocked", "3", "triage", { reason: "ambiguous spec" });
  emit("failed", "3", "code", { reason: "non-zero exit (1)" });

  const evs = readEvents(dir);
  assert.equal(evs[0].event, "blocked");
  assert.equal(evs[0].reason, "ambiguous spec");
  assert.equal(evs[1].event, "failed");
  assert.equal(evs[1].reason, "non-zero exit (1)");
});

test("emit appends pipeline_done", () => {
  const dir = tmpDir();
  const emit = createEmitter(dir);
  emit("pipeline_done", "99", "done");

  const [ev] = readEvents(dir);
  assert.equal(ev.event, "pipeline_done");
  assert.equal(ev.ref, "99");
  assert.equal(ev.step, "done");
});

test("emit is best-effort: unwritable path logs warning and does not throw", (t) => {
  const dir = tmpDir();
  // Make events.jsonl a directory so appendFileSync fails
  fs.mkdirSync(path.join(dir, "events.jsonl"));
  const emit = createEmitter(dir);
  const warnings = [];
  const origWarn = console.warn;
  t.after(() => { console.warn = origWarn; });
  console.warn = (...args) => warnings.push(args.join(" "));

  assert.doesNotThrow(() => emit("enqueued", "1", "code"));
  assert.ok(warnings.some((w) => w.includes("[events]")), "warning emitted");
  // no events file content should exist (it's a dir)
  assert.deepEqual(readEvents(dir), []);
});

test("events.jsonl is append-only across emitter instances", () => {
  const dir = tmpDir();
  createEmitter(dir)("enqueued", "A", "code");
  createEmitter(dir)("run_start", "A", "code", { model: null });
  createEmitter(dir)("run_end", "A", "code", { outcome: "advance" });

  const evs = readEvents(dir);
  assert.equal(evs.length, 3);
  assert.deepEqual(evs.map((e) => e.event), ["enqueued", "run_start", "run_end"]);
});
