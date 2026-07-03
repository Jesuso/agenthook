import { test } from "node:test";
import assert from "node:assert/strict";
import { renderEvent } from "../src/commands/events.js";

// Unit tests for the events command's pure helpers.
// The read/filter path is exercised via renderEvent + the inline filter logic
// (I/O side-effects tested through the emitter in events.test.js).

test("renderEvent formats a basic enqueued event", () => {
  const ev = { ts: "2026-07-03T10:00:00.000Z", event: "enqueued", ref: "42", step: "code" };
  const out = renderEvent(ev);
  assert.ok(out.includes("enqueued"), "event name present");
  assert.ok(out.includes("ref=42"), "ref present");
  assert.ok(out.includes("step=code"), "step present");
  assert.ok(out.includes("2026-07-03 10:00:00Z"), "timestamp formatted");
});

test("renderEvent includes model for run_start", () => {
  const ev = { ts: "2026-07-03T10:00:01.000Z", event: "run_start", ref: "42", step: "code", model: "claude-opus-4-8" };
  const out = renderEvent(ev);
  assert.ok(out.includes("model=claude-opus-4-8"), "model included");
});

test("renderEvent includes outcome and cost for run_end", () => {
  const ev = { ts: "2026-07-03T10:05:00.000Z", event: "run_end", ref: "42", step: "code", outcome: "advance", costUsd: 0.1234 };
  const out = renderEvent(ev);
  assert.ok(out.includes("outcome=advance"), "outcome included");
  assert.ok(out.includes("cost=$0.1234"), "cost included");
});

test("renderEvent includes reason for blocked and failed", () => {
  const blocked = { ts: "2026-07-03T10:01:00.000Z", event: "blocked", ref: "7", step: "triage", reason: "unclear spec" };
  assert.ok(renderEvent(blocked).includes("reason=unclear spec"));

  const failed = { ts: "2026-07-03T10:02:00.000Z", event: "failed", ref: "7", step: "code", reason: "non-zero exit" };
  assert.ok(renderEvent(failed).includes("reason=non-zero exit"));
});

test("renderEvent handles missing fields gracefully", () => {
  const ev = {};
  const out = renderEvent(ev);
  assert.ok(typeof out === "string", "returns string for empty object");
  assert.ok(out.includes("?"), "uses ? for unknown fields");
});

test("renderEvent pads event name to align columns", () => {
  const short = renderEvent({ ts: "2026-07-03T10:00:00.000Z", event: "enqueued", ref: "1", step: "s" });
  const long = renderEvent({ ts: "2026-07-03T10:00:00.000Z", event: "pipeline_done", ref: "1", step: "s" });
  // The ref= should appear at the same column offset in both
  const shortRefPos = short.indexOf("ref=");
  const longRefPos = long.indexOf("ref=");
  assert.equal(shortRefPos, longRefPos, "ref= aligned after padded event name");
});
