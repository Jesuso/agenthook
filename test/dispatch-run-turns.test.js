import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// Unit tests for verdict.js's peekVerdict/isNoValidVerdict (#864): the guarded-read pair every
// turn in runStep (step.js) shares, pulled out of five inline call sites.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { peekVerdict, isNoValidVerdict, NO_VALID_VERDICT } from "../src/dispatch/verdict.js";

test("peekVerdict: the sandbox guard (oversize file removal) runs only for a non-host executor", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthook-peek-verdict-"));
  const verdictFile = path.join(dir, "verdict.json");
  // Bigger than MAX_SANDBOX_VERDICT_BYTES (1 MiB) — guardSandboxVerdict rm's it, a host read
  // never looks at the size at all.
  fs.writeFileSync(verdictFile, "x".repeat(1024 * 1024 + 1));
  const readVerdict = (code, file) => ({ outcome: fs.existsSync(file) ? "advance" : "hold", reason: fs.existsSync(file) ? undefined : NO_VALID_VERDICT });

  const hostRc = { executor: { name: "host" }, localVerdictFile: verdictFile, step: {}, agent: {}, readVerdict };
  assert.equal(peekVerdict(hostRc, 0).outcome, "advance", "host never guards — the oversize file survives");
  assert.ok(fs.existsSync(verdictFile));

  const sandboxRc = { ...hostRc, executor: { name: "sandbox" } };
  assert.equal(peekVerdict(sandboxRc, 0).outcome, "hold", "sandbox guards — the oversize file is removed first");
  assert.ok(!fs.existsSync(verdictFile));
});

test("isNoValidVerdict: true only for hold + NO_VALID_VERDICT, false for every other verdict", () => {
  assert.equal(isNoValidVerdict({ outcome: "hold", reason: NO_VALID_VERDICT }), true);
  assert.equal(isNoValidVerdict({ outcome: "hold", reason: "something else" }), false);
  assert.equal(isNoValidVerdict({ outcome: "advance" }), false);
  assert.equal(isNoValidVerdict({ outcome: "fail", reason: NO_VALID_VERDICT }), false);
});
