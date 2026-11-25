import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// The outbox copy-back on the remote (ssh) run's exit (#825, #681 phase 5a): `done()` pulls ONLY
// outbox/pr.json and comment.md (per-file size cap, never symlinks/FIFOs) from the worker next to
// the hub verdict file, where finish.js parses it BEFORE its rmSync; and a resume (verdict-repair)
// launch keeps the verdict dir — so the outbox survives to the last turn's copy-back — while a
// fresh launch still wipes it.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, execSync } from "node:child_process";
import { createSshExecutor, launcherScript, framePayload } from "../src/dispatch/executor-ssh.js";
import { withFakeSsh } from "./_ssh-helpers.js";
import { OUTBOX_COPY_CAP_BYTES } from "../src/dispatch/outbox.js";

const LAUNCH = { runId: "r1", ref: "42", stepId: "code", bin: "x", args: ["-p", "hi"], prompt: "hi", env: {} };

test("ssh done() copies back only outbox/pr.json + comment.md (unknown names, over-cap files, symlinks and FIFOs excluded)", async () => {
  const ssh = withFakeSsh();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-ssh-outbox-"));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ah-ssh-outbox-hub-"));
  const hubOutbox = path.join(root, "outbox");
  const hubVerdictFile = path.join(root, "hub-verdict.json");
  try {
    const executor = createSshExecutor({ stateKey: "p", remote: { host: "worker.test", workDir }, spawnPaths: { sandboxVerdictPathFor: () => hubVerdictFile } });
    const verdictDir = path.join(workDir, ".agenthook", "p", "verdicts", "run-42-code");
    const box = path.join(verdictDir, "outbox");
    fs.mkdirSync(box, { recursive: true });

    const launch = () => executor.launch(LAUNCH);

    // 1) The normal case: the two known files land on the hub, next to the hub verdict file.
    fs.writeFileSync(path.join(box, "pr.json"), JSON.stringify({ title: "t", body: "b" }));
    fs.writeFileSync(path.join(box, "comment.md"), "the worker's findings");
    fs.writeFileSync(path.join(box, "extra.txt"), "not an outbox file");
    await (await launch()).done();
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(hubOutbox, "pr.json"), "utf8")), { title: "t", body: "b" });
    assert.equal(fs.readFileSync(path.join(hubOutbox, "comment.md"), "utf8"), "the worker's findings");
    assert.ok(!fs.existsSync(path.join(hubOutbox, "extra.txt")), "unknown names are never copied");

    // 2) Over the cap → the file is dropped (it never reaches the hub at all).
    fs.rmSync(hubOutbox, { recursive: true, force: true });
    fs.writeFileSync(path.join(box, "comment.md"), "z".repeat(OUTBOX_COPY_CAP_BYTES + 1));
    await (await launch()).done();
    assert.ok(!fs.existsSync(path.join(hubOutbox, "comment.md")), "an over-cap comment.md is not copied");

    // 3) A symlink and a FIFO are never OPENED (the -L/-f guards) — nothing hangs, nothing escapes the box.
    fs.rmSync(hubOutbox, { recursive: true, force: true });
    fs.rmSync(path.join(box, "comment.md"));
    fs.writeFileSync(path.join(workDir, "target.txt"), "target outside the box");
    fs.symlinkSync(path.join(workDir, "target.txt"), path.join(box, "comment.md"));
    fs.writeFileSync(path.join(box, "pr.json"), JSON.stringify({ title: "t2", body: "b2" }));
    execSync(`mkfifo ${JSON.stringify(path.join(box, "pr.json.fifo"))}`);
    await (await launch()).done();
    assert.ok(!fs.existsSync(path.join(hubOutbox, "comment.md")), "a symlink is not followed");
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(hubOutbox, "pr.json"), "utf8")), { title: "t2", body: "b2" }, "a FIFO sibling never blocks the copy of the real files");

    // 4) The outbox dir itself a symlink → the whole copy is refused.
    fs.rmSync(hubOutbox, { recursive: true, force: true });
    fs.rmSync(path.join(box, "pr.json"));
    fs.rmSync(path.join(box, "comment.md"));
    fs.rmSync(path.join(box, "pr.json.fifo"));
    const realBox = path.join(workDir, "elsewhere");
    fs.mkdirSync(realBox, { recursive: true });
    fs.writeFileSync(path.join(realBox, "pr.json"), JSON.stringify({ title: "sneaky", body: "b" }));
    fs.rmSync(box, { recursive: true, force: true });
    fs.symlinkSync(realBox, box);
    await (await launch()).done();
    assert.ok(!fs.existsSync(hubOutbox), "a symlinked outbox dir copies nothing");
  } finally {
    ssh.restore();
    fs.rmSync(workDir, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a resume launch keeps the outbox and only clears verdict.json; a fresh launch wipes the verdict dir", () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-ssh-launcher-"));
  try {
    const verdictDir = path.join(workDir, "verdicts", "run-42-code");
    fs.mkdirSync(path.join(verdictDir, "outbox"), { recursive: true });
    fs.writeFileSync(path.join(verdictDir, "outbox", "comment.md"), "turn 1's findings");
    fs.writeFileSync(path.join(verdictDir, "verdict.json"), "junk from turn 1");

    /** Run the launcher script exactly the way remote ssh would: `sh -c <script>` with the
     * framed payload on stdin and the real env (fake `cat` as the agent). */
    const runLauncher = (resume) => {
      const runsDir = path.join(workDir, "runs");
      const script = launcherScript({ workDir, runsDir, pgidFile: path.join(runsDir, "r.pgid"), promptPipe: path.join(runsDir, "r.pipe"), verdictDir, configDir: undefined, hasFiles: false, execArgv: ["cat"], resume });
      return spawnSync("sh", ["-c", script], { input: framePayload({ P: "1" }, "prompt", []), timeout: 20000 });
    };

    // A resume turn: the outbox SURVIVES, the verdict does not (the agent rewrites it).
    assert.equal(runLauncher(true).status, 0);
    assert.equal(fs.readFileSync(path.join(verdictDir, "outbox", "comment.md"), "utf8"), "turn 1's findings", "the outbox must survive a resume turn");
    assert.ok(!fs.existsSync(path.join(verdictDir, "verdict.json")), "verdict.json is cleared so the repair turn rewrites it");

    // A fresh launch still wipes the whole dir (a new run starts clean).
    fs.writeFileSync(path.join(verdictDir, "verdict.json"), "junk again");
    assert.equal(runLauncher(false).status, 0);
    assert.ok(!fs.existsSync(path.join(verdictDir, "outbox")), "a fresh launch wipes the old outbox too");
    assert.ok(!fs.existsSync(path.join(verdictDir, "verdict.json")));
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});
