// Shared fixtures for the ssh-executor test files (test/dispatch-executor-ssh.test.js keeps its
// own copies — this file exists so a NEW ssh-executor test file (e.g.
// test/dispatch-executor-ssh-opencode.test.js, #739) doesn't have to duplicate them again).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSpawn } from "../src/dispatch/spawn.js";

/** A fake `ssh`: drops -T/-o/-p/-i/-l (+ value) and the host, then runs the remaining
 * (already shQuoted by the executor) argv joined with spaces through a real shell — exactly
 * how real ssh hands its trailing argv to the remote shell. Records the post-strip argv (one
 * JSON line per invocation) so a test can assert nothing sensitive reached it. */
export const FAKE_SSH = `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
const args = process.argv.slice(2);
const valued = new Set(["-o", "-p", "-i", "-l"]);
let i = 0;
while (i < args.length) {
  const a = args[i];
  if (a === "-T") { i++; continue; }
  if (valued.has(a)) { i += 2; continue; }
  break;
}
i++; // the host
const remoteArgv = args.slice(i);
if (process.env.SSH_RECORD) fs.appendFileSync(process.env.SSH_RECORD, JSON.stringify({ all: args, remote: remoteArgv }) + "\\n");
const cmdLine = remoteArgv.join(" ");
const r = spawnSync("sh", ["-c", cmdLine], { stdio: "inherit" });
process.exit(r.status ?? 1);
`;

/** Puts {@link FAKE_SSH} on PATH ahead of the real `ssh`; call `.restore()` in a `finally`. */
export function withFakeSsh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-ssh-bin-"));
  const bin = path.join(dir, "ssh");
  fs.writeFileSync(bin, FAKE_SSH, { mode: 0o755 });
  const record = path.join(dir, "record.jsonl");
  const savedPath = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${savedPath}`;
  process.env.SSH_RECORD = record;
  return {
    record: () => (fs.existsSync(record) ? fs.readFileSync(record, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []),
    restore: () => {
      process.env.PATH = savedPath;
      delete process.env.SSH_RECORD;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A minimal spawnAgent ctx (see src/dispatch/spawn.js createSpawn's destructure). */
export function spawnCtx(extra = {}) {
  return createSpawn(/** @type {any} */ ({
    cfg: {}, children: new Set(), killGraceMs: 300, killTimers: new Map(), meta: {}, forge: null, sandbox: null,
    executorRuns: new Map(), cancelled: new Set(), ...extra,
  }));
}
