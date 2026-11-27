import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// #829 flake: spawn.js's run-log stream opens lazily on the threadpool. Under CI load, a test's
// cleanup (rm of the run's tmp dir) can land before the open is serviced, and the stream emitted
// an unhandled `error` — an uncaught exception that kills the process (and would kill the
// receiver). The stream must swallow its own open/write failures: the run proceeds, only the
// log is lost.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnCtx, fakeAgent } from "./_ssh-helpers.js";

test("spawnAgent: a run-log stream that cannot open does not crash the process", async () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-log-run-"));
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-log-dir-"));
  const agentScript = path.join(runDir, "agent.sh");
  fs.writeFileSync(agentScript, `#!/bin/sh\necho '{"type":"assistant"}'\nexit 0\n`, { mode: 0o755 });
  try {
    // Remove the dir synchronously before awaiting anything: the stream's lazy open of
    // <logDir>/run.log then hits ENOENT deterministically, not on a race.
    fs.rmdirSync(logDir);
    const { spawnAgent } = spawnCtx();
    const result = await spawnAgent({
      agent: fakeAgent(),
      prompt: "hi",
      cwd: runDir,
      logPath: path.join(logDir, "run.log"),
      bin: agentScript,
    });
    // The run itself is unaffected: the agent ran to a clean exit.
    assert.equal(result.code, 0);
    assert.equal(result.spawnError, undefined);
    assert.equal(fs.existsSync(path.join(logDir, "run.log")), false, "the log never existed — nothing was written to it");
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});
