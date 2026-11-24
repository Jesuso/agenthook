// Shared fixtures for the dispatch-executor-ssh-*.test.js files (split from the former
// dispatch-executor-ssh.test.js so no single test file costs ~40K tokens to read). Not matched
// by the `test/*.test.js` glob `npm test` runs, so it is never itself executed as a test file.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { shQuote } from "../src/dispatch/executor-ssh.js";
import { createSpawn } from "../src/dispatch/spawn.js";

/** A tiny git repo with one commit, for tests that exercise the full dispatcher (#690 syncs the
 * repo's HEAD to the worker before every remote run, so `cfg.repoPath` must be a real repo).
 * @param {string} dir */
export function initGitRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const g = (args) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  g(["init", "--quiet", "-b", "main"]);
  g(["config", "user.email", "a@example.test"]);
  g(["config", "user.name", "a"]);
  fs.writeFileSync(path.join(dir, "README.md"), "hi\n");
  g(["add", "README.md"]);
  g(["commit", "--quiet", "-m", "init"]);
}

/** A fake `ssh`: drops -T/-o/-p/-i/-l (+ value) and the host, then runs the remaining
 * (already shQuoted by the executor) argv joined with spaces through a real shell — exactly
 * how real ssh hands its trailing argv to the remote shell. Records the post-strip argv (one
 * JSON line per invocation) so a test can assert nothing sensitive reached it. */
const FAKE_SSH = `#!/usr/bin/env node
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

/** A fake `ssh` that never connects: records its full raw argv (one line per invocation) and
 * exits 255 with `stderrLine` on stderr — how real ssh reports a refused/timed-out/misconfigured
 * connection (#828). A plain shell script (one process, one fd) so an EPIPE on the client's stdin
 * behaves exactly as it does against real ssh. @param {string} stderrLine */
export function withFailingSsh(stderrLine) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-ssh-bin-"));
  const bin = path.join(dir, "ssh");
  const argvLog = path.join(dir, "argv.txt");
  fs.writeFileSync(bin, `#!/bin/sh\necho "$@" >> ${JSON.stringify(argvLog)}\necho ${JSON.stringify(stderrLine)} >&2\nexit 255\n`, { mode: 0o755 });
  const savedPath = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${savedPath}`;
  return {
    /** The raw argv of every ssh invocation (one string per call, args space-joined). */
    argvs: () => (fs.existsSync(argvLog) ? fs.readFileSync(argvLog, "utf8").trim().split("\n").filter(Boolean) : []),
    restore: () => {
      process.env.PATH = savedPath;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A fake `ssh` that lets the run start, prints `outputLine` to stdout, then drops the
 * connection mid-run: stderr `lostLine`, exit 255 (#828's mid-run-disconnect shape). */
export function withDroppingSsh(outputLine, lostLine) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-ssh-bin-"));
  const bin = path.join(dir, "ssh");
  fs.writeFileSync(bin, `#!/bin/sh\necho ${JSON.stringify(outputLine)}\necho ${JSON.stringify(lostLine)} >&2\nexit 255\n`, { mode: 0o755 });
  const savedPath = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${savedPath}`;
  return {
    restore: () => {
      process.env.PATH = savedPath;
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

/** A fake agent whose parser just renders stdout as log text and reports output>0 once it sees
 * any; `buildArgs` mimics claude's own shape (prompt at args[1]) — executor-ssh.js's launch()
 * relies on that position to pull the prompt off argv and onto stdin. */
export function fakeAgent() {
  const tally = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
  return {
    defaults: { bin: "claude" },
    buildArgs: ({ prompt }) => ["-p", prompt, "--output-format", "stream-json"],
    createParser: () => ({
      push: (chunk) => {
        tally.output += chunk.length;
        return chunk;
      },
      flush: () => "",
      tally,
      result: null,
      quota: null,
      pushStderr: () => {},
    }),
  };
}

/** A fake worktree-step agent (its launcher cwd IS the synced worktree, #690): drains stdin,
 * commits one new/changed file under a distinct name per run (so a second round never collides
 * with "nothing to commit"), writes a verdict, exits 0.
 * @param {string} dir @param {string} filename */
export function writeCommitAgent(dir, filename) {
  const p = path.join(dir, "commit-agent.sh");
  fs.writeFileSync(
    p,
    `#!/bin/sh\ncat > /dev/null\ngit config user.email a@test.local\ngit config user.name a\necho hi > ${shQuote(filename)}\ngit add ${shQuote(filename)}\ngit commit --quiet -m ${shQuote(`worker commit ${filename}`)}\nmkdir -p "$(dirname "$AGENTHOOK_VERDICT_FILE")"\necho '{"outcome":"advance","reason":"ok"}' > "$AGENTHOOK_VERDICT_FILE"\nexit 0\n`,
    { mode: 0o755 },
  );
  return p;
}

/** @param {string} repoPath @returns {string} the committed HEAD sha */
export function headOf(repoPath) {
  return execFileSync("git", ["-C", repoPath, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

/** A fake `git` on PATH that records its full argv (one JSON line per call) then execs the real
 * one — for asserting the exact argv a hub-side call built, not just its observable effect. The
 * fake ssh double already runs its remote script through the same PATH, so a worker-side `git`
 * call (inside the shell script executor-ssh.js sends over ssh) is ALSO recorded; callers filter
 * by `-C <path>` to tell hub calls (always hardened, #690) from worker-side ones (never wrapped
 * by `gitArgv` — only the hub is a HOST_GIT_SAFE concern). */
export function withArgvRecordingGit() {
  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-git-bin-"));
  const bin = path.join(dir, "git");
  const record = path.join(dir, "record.jsonl");
  fs.writeFileSync(
    bin,
    `#!/usr/bin/env node\nimport fs from "node:fs";\nimport { spawnSync } from "node:child_process";\nconst args = process.argv.slice(2);\nfs.appendFileSync(${JSON.stringify(record)}, JSON.stringify(args) + "\\n");\nconst r = spawnSync(${JSON.stringify(realGit)}, args, { stdio: "inherit" });\nprocess.exit(r.status ?? 1);\n`,
    { mode: 0o755 },
  );
  const savedPath = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${savedPath}`;
  return {
    /** @param {string} forPath only calls with `-C <forPath>` */
    callsFor: (forPath) =>
      (fs.existsSync(record) ? fs.readFileSync(record, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []).filter(
        (a) => a[a.indexOf("-C") + 1] === forPath,
      ),
    restore: () => {
      process.env.PATH = savedPath;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
