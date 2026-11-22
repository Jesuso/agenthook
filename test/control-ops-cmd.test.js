import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// `agenthook cancel` / `release` / `dismiss` / `retry` / `pull` / `harness-reset` / `set-concurrency` —
// the shell front-end of the run-control ops (src/ops.js). A real fake control socket (like
// test/pause-cmd.test.js) records each `{cmd, args}` so the exact op name and payload are asserted,
// and `--json` stdout is compared against the canned reply.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { registryDir } from "../src/config.js";
import { controlSockPath } from "../src/paths.js";
import { cancel, release, dismiss, retry, pull, harnessReset } from "../src/commands/control-ops.js";
import { concurrency } from "../src/commands/pause.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ah-control-ops-"));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

/** @param {any} v */
const json = (v) => JSON.stringify(v, null, 2) + "\n";

/** A profile with a config file + state dir + live pidfile and a fake control socket that records
 * each request (`{cmd, args}`) and replies `result` — or `{ok:false, error}` when `error` is given.
 * @param {string} stateKey @param {any} result @param {string} [error]
 */
async function profile(stateKey, result, error) {
  const stateDir = path.join(registryDir, stateKey);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "server.pid"), String(process.pid));
  const configPath = path.join(root, stateKey, "agenthook.config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, json({ name: stateKey, repoPath: "/repo", tracker: { type: "github", pipeline: [{ id: "code" }] } }));
  const sockPath = controlSockPath(stateDir, stateKey);
  /** @type {any[]} */ const requests = [];
  const server = net.createServer((socket) => {
    socket.write(JSON.stringify({ type: "hello", name: stateKey, pid: 1, startedAt: "t" }) + "\n");
    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        const req = JSON.parse(line);
        if (req.type === "hello") continue;
        requests.push({ cmd: req.cmd, args: req.args });
        socket.write(JSON.stringify(error ? { id: req.id, ok: false, error } : { id: req.id, ok: true, result }) + "\n");
      }
    });
    socket.on("error", () => {});
  });
  await new Promise((r) => server.listen(sockPath, () => r(undefined)));
  return { configPath, stateDir, server, requests };
}

/** A profile whose receiver is down: state dir + config, no pidfile, no socket. @param {string} stateKey */
function downProfile(stateKey) {
  const stateDir = path.join(registryDir, stateKey);
  fs.mkdirSync(stateDir, { recursive: true });
  const configPath = path.join(root, stateKey, "agenthook.config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, json({ name: stateKey, repoPath: "/repo", tracker: { type: "github", pipeline: [{ id: "code" }] } }));
  return { configPath, stateDir, requests: /** @type {any[]} */ ([]) };
}

/** Run one command, capturing stdout/stderr and the exit code.
 * @param {(args: any) => Promise<any>} fn @param {Record<string, unknown>} args @param {string} configPath
 */
async function run(fn, args, configPath) {
  const out = /** @type {string[]} */ ([]);
  const err = /** @type {string[]} */ ([]);
  const origLog = console.log;
  const origErr = console.error;
  console.log = (m) => out.push(String(m));
  console.error = (m) => err.push(String(m));
  const before = process.exitCode;
  process.exitCode = undefined;
  try {
    await fn({ ...args, config: configPath });
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  const exitCode = process.exitCode;
  process.exitCode = before;
  return { exitCode, out: out.join("\n"), err: err.join("\n") };
}

const RESULT = {
  cancel: { ref: "5", killed: true, dequeued: [] },
  release: { ref: "5", step: "code", queued: true },
  dismiss: { ref: "5", dismissed: true },
  retry: { ref: "5", step: "code", queued: true },
  pull: { active: 1, queued: 2, capped: 1 },
  harness_reset: { harness: "h", reset: true, active: 0, queued: 0 },
  set_concurrency: { maxConcurrent: 3, note: "persists until reset", active: 0, queued: 0 },
};

test("cancel sends {cmd:\"cancel\", args:{ref}}; --json round-trips the reply; a refusal exits 1 with the op error", async () => {
  const p = await profile("op-cancel", RESULT.cancel);
  try {
    let r = await run(cancel, { _: ["5"] }, p.configPath);
    assert.equal(r.exitCode, undefined);
    assert.deepEqual(p.requests, [{ cmd: "cancel", args: { ref: "5" } }]);
    assert.match(r.out, /^5: killed its run$/);
    r = await run(cancel, { _: ["5"], json: true }, p.configPath);
    assert.deepEqual(JSON.parse(r.out), RESULT.cancel);
  } finally {
    await new Promise((r) => p.server.close(r));
  }
  const e = await profile("op-cancel-err", null, "5 is not running, queued or held here");
  try {
    const r = await run(cancel, { _: ["5"] }, e.configPath);
    assert.equal(r.exitCode, 1);
    assert.match(r.err, /^cancel: 5 is not running, queued or held here$/);
  } finally {
    await new Promise((r) => e.server.close(r));
  }
  const d = downProfile("op-cancel-down");
  const r = await run(cancel, { _: ["5"] }, d.configPath);
  assert.equal(r.exitCode, 1);
  assert.match(r.out, /^"op-cancel-down" not running$/);
  assert.equal(d.requests.length, 0);
});

test("cancel with no <ref> exits 1 and sends no request", async () => {
  const p = await profile("op-cancel-noref", RESULT.cancel);
  try {
    const r = await run(cancel, { _: [] }, p.configPath);
    assert.equal(r.exitCode, 1);
    assert.match(r.err, /^usage: agenthook cancel <ref>$/);
    assert.equal(p.requests.length, 0);
  } finally {
    await new Promise((r) => p.server.close(r));
  }
});

test("release joins the remaining words as comment; with none, no comment key; --json; refusal", async () => {
  const p = await profile("op-release", RESULT.release);
  try {
    let r = await run(release, { _: ["5", "please", "do", "X"] }, p.configPath);
    assert.deepEqual(p.requests, [{ cmd: "release", args: { ref: "5", comment: "please do X" } }]);
    assert.match(r.out, /^5: queued for step "code"$/);
    r = await run(release, { _: ["5"] }, p.configPath);
    const noComment = p.requests[1];
    assert.deepEqual(noComment, { cmd: "release", args: { ref: "5" } });
    assert.equal("comment" in noComment.args, false);
    r = await run(release, { _: ["5"], json: true }, p.configPath);
    assert.deepEqual(JSON.parse(r.out), RESULT.release);
  } finally {
    await new Promise((r) => p.server.close(r));
  }
  const e = await profile("op-release-err", null, "5 cannot be released");
  try {
    const r = await run(release, { _: ["5", "why?"] }, e.configPath);
    assert.equal(r.exitCode, 1);
    assert.match(r.err, /^release: 5 cannot be released$/);
  } finally {
    await new Promise((r) => e.server.close(r));
  }
  const d = downProfile("op-release-noref");
  const r = await run(release, { _: [] }, d.configPath);
  assert.equal(r.exitCode, 1);
  assert.match(r.err, /^usage: agenthook release <ref> \[comment…\]$/);
  assert.equal(d.requests.length, 0);
});

test("dismiss sends {cmd:\"dismiss\", args:{ref}}; --json; refusal; no <ref> sends nothing", async () => {
  const p = await profile("op-dismiss", RESULT.dismiss);
  try {
    let r = await run(dismiss, { _: ["5"] }, p.configPath);
    assert.deepEqual(p.requests, [{ cmd: "dismiss", args: { ref: "5" } }]);
    assert.match(r.out, /^5 dismissed$/);
    r = await run(dismiss, { _: ["5"], json: true }, p.configPath);
    assert.deepEqual(JSON.parse(r.out), RESULT.dismiss);
    r = await run(dismiss, { _: [] }, p.configPath);
    assert.equal(r.exitCode, 1);
    assert.match(r.err, /^usage: agenthook dismiss <ref>$/);
    assert.equal(p.requests.length, 2);
  } finally {
    await new Promise((r) => p.server.close(r));
  }
  const e = await profile("op-dismiss-err", null, "5 is running — nothing to dismiss");
  try {
    const r = await run(dismiss, { _: ["5"] }, e.configPath);
    assert.equal(r.exitCode, 1);
    assert.match(r.err, /^dismiss: 5 is running — nothing to dismiss$/);
  } finally {
    await new Promise((r) => e.server.close(r));
  }
});

test("retry sends {cmd:\"retry\", args:{ref}}; --json; refusal", async () => {
  const p = await profile("op-retry", RESULT.retry);
  try {
    let r = await run(retry, { _: ["5"] }, p.configPath);
    assert.deepEqual(p.requests, [{ cmd: "retry", args: { ref: "5" } }]);
    assert.match(r.out, /^5: step "code" queued$/);
    r = await run(retry, { _: ["5"], json: true }, p.configPath);
    assert.deepEqual(JSON.parse(r.out), RESULT.retry);
    r = await run(retry, { _: [] }, p.configPath);
    assert.equal(r.exitCode, 1);
    assert.match(r.err, /^usage: agenthook retry <ref>$/);
  } finally {
    await new Promise((r) => p.server.close(r));
  }
  const e = await profile("op-retry-err", null, "5 is not failed — nothing to retry (start it with run)");
  try {
    const r = await run(retry, { _: ["5"] }, e.configPath);
    assert.equal(r.exitCode, 1);
    assert.match(r.err, /^retry: 5 is not failed — nothing to retry \(start it with run\)$/);
  } finally {
    await new Promise((r) => e.server.close(r));
  }
});

test("pull sends {cmd:\"pull\", args:{}}; --json; refusal; plain shows slots active/queued", async () => {
  const p = await profile("op-pull", RESULT.pull);
  try {
    let r = await run(pull, { _: [] }, p.configPath);
    assert.deepEqual(p.requests, [{ cmd: "pull", args: {} }]);
    assert.match(r.out, /slots: 1 active, 2 queued/);
    assert.match(r.out, /1 capped/);
    r = await run(pull, { _: [], json: true }, p.configPath);
    assert.deepEqual(JSON.parse(r.out), RESULT.pull);
  } finally {
    await new Promise((r) => p.server.close(r));
  }
  const e = await profile("op-pull-err", null, "no queue stage on this profile");
  try {
    const r = await run(pull, { _: [] }, e.configPath);
    assert.equal(r.exitCode, 1);
    assert.match(r.err, /^pull: no queue stage on this profile$/);
  } finally {
    await new Promise((r) => e.server.close(r));
  }
});

test("harness-reset sends {cmd:\"harness_reset\", args:{harness}}; --json; refusal; no <name> sends nothing", async () => {
  const p = await profile("op-hres", RESULT.harness_reset);
  try {
    let r = await run(harnessReset, { _: ["h"] }, p.configPath);
    assert.deepEqual(p.requests, [{ cmd: "harness_reset", args: { harness: "h" } }]);
    assert.match(r.out, /^harness "h": reset$/);
    r = await run(harnessReset, { _: ["h"], json: true }, p.configPath);
    assert.deepEqual(JSON.parse(r.out), RESULT.harness_reset);
    // a harness that was already up: the plain line says so, still exit 0
    const up = await profile("op-hres-up", { harness: "h", reset: false, active: 2, queued: 0 });
    r = await run(harnessReset, { _: ["h"] }, up.configPath);
    assert.equal(r.exitCode, undefined);
    assert.match(r.out, /^harness "h": already up$/);
    await new Promise((r) => up.server.close(r));
    r = await run(harnessReset, { _: [] }, p.configPath);
    assert.equal(r.exitCode, 1);
    assert.match(r.err, /^usage: agenthook harness-reset <name>$/);
    assert.equal(p.requests.length, 2);
  } finally {
    await new Promise((r) => p.server.close(r));
  }
  const e = await profile("op-hres-err", null, 'no harness "x" (have: h)');
  try {
    const r = await run(harnessReset, { _: ["x"] }, e.configPath);
    assert.equal(r.exitCode, 1);
    assert.match(r.err, /^harness_reset: no harness "x" \(have: h\)$/);
  } finally {
    await new Promise((r) => e.server.close(r));
  }
});

test("set-concurrency: exactly one of <n> or --reset; --json; refusal", async () => {
  const p = await profile("op-setc", RESULT.set_concurrency);
  try {
    // neither a number nor --reset: exit 1, no request
    let r = await run(concurrency, { _: [] }, p.configPath);
    assert.equal(r.exitCode, 1);
    assert.match(r.err, /^usage: agenthook concurrency <n\|reset> \[--reset\] \[--harness <name>\] \[--json\]$/);
    assert.equal(p.requests.length, 0);
    // both a number and --reset: exit 1, still no request
    r = await run(concurrency, { _: ["3"], reset: true }, p.configPath);
    assert.equal(r.exitCode, 1);
    assert.equal(p.requests.length, 0);
    // a number, and --reset with --harness
    r = await run(concurrency, { _: ["3"] }, p.configPath);
    assert.equal(r.exitCode, undefined);
    assert.deepEqual(p.requests[0], { cmd: "set_concurrency", args: { max: 3 } });
    r = await run(concurrency, { _: [], reset: true, harness: "h" }, p.configPath);
    assert.deepEqual(p.requests[1], { cmd: "set_concurrency", args: { reset: true, harness: "h" } });
    // --json round-trips the reply
    r = await run(concurrency, { _: ["3"], json: true }, p.configPath);
    assert.deepEqual(JSON.parse(r.out), RESULT.set_concurrency);
  } finally {
    await new Promise((r) => p.server.close(r));
  }
  const e = await profile("op-setc-err", null, "a restart is pending — concurrency changes are refused");
  try {
    const r = await run(concurrency, { _: ["3"] }, e.configPath);
    assert.equal(r.exitCode, 1);
    assert.match(r.err, /^set_concurrency: a restart is pending — concurrency changes are refused$/);
  } finally {
    await new Promise((r) => e.server.close(r));
  }
});

test("a down receiver prints \"<name> not running\" and exits 1 (pull, harness-reset, release)", async () => {
  const d = downProfile("op-down");
  let r = await run(pull, { _: [] }, d.configPath);
  assert.equal(r.exitCode, 1);
  assert.match(r.out, /^"op-down" not running$/);
  r = await run(harnessReset, { _: ["h"] }, d.configPath);
  assert.equal(r.exitCode, 1);
  assert.match(r.out, /^"op-down" not running$/);
  r = await run(release, { _: ["5", "why?"] }, d.configPath);
  assert.equal(r.exitCode, 1);
  assert.match(r.out, /^"op-down" not running$/);
  assert.equal(d.requests.length, 0);
});
