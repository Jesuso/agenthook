// `agenthook status` — pure-unit coverage for mapping a run-log filename back to its
// ref (so the recent-runs list can show the human id / PR / title from refmeta).
import test from "node:test";
import assert from "node:assert/strict";
import { refForLog } from "../src/commands/status.js";

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
