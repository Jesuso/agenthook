import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// Zero-setup quickstart (#418): `init --local` (the pure scaffold + the git guards), `ticket add|ls`
// helpers, the shared port probe, and the CLI flags/help that front them. No network; the only
// spawn is `git` in a throwaway repo (like worktree.test.js).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { init, localScaffold, sanitizeName } from "../src/commands/init.js";
import { ticket, ticketBody, ticketRows } from "../src/commands/ticket.js";
import { TICKET_BODY_MAX } from "../src/ops.js";
import { firstFreePort } from "../src/port.js";
import { loadConfig, registryDir } from "../src/config.js";
import { tildify } from "../src/profile.js";
import { parse, HELP } from "../bin/agenthook.js";

const tmp = (/** @type {string} */ p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
/** @param {string} dir @param {string[]} args */
const git = (dir, args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir, stdio: "ignore" });

/** Run `fn` with cwd = `dir`, console quiet. @template T @param {string} dir @param {() => Promise<T>} fn */
async function inDir(dir, fn) {
  const prev = process.cwd();
  const { log, warn } = console;
  process.chdir(dir);
  console.log = console.warn = () => {};
  try {
    return await fn();
  } finally {
    process.chdir(prev);
    Object.assign(console, { log, warn });
  }
}

test("localScaffold: code → review → done on the local tracker, loopback manual ingress; loadConfig accepts it", () => {
  const repo = tmp("ah-scaffold-");
  const { config, files } = localScaffold({ repoRoot: repo, name: "ah-scaffold-test", port: 4555, fullAuto: false, base: "trunk" });
  assert.equal(config.fullAuto, false);
  assert.deepEqual(config.ingress, { type: "manual", url: "http://127.0.0.1:4555" });
  assert.deepEqual(config.tracker.pipeline.map((/** @type {any} */ s) => s.id), ["code", "review", "done"]);
  assert.deepEqual(Object.keys(files), ["INSTRUCTIONS_CODE.md", "INSTRUCTIONS_REVIEW.md"]);
  assert.match(files["INSTRUCTIONS_REVIEW.md"], /git diff trunk\.\.\.HEAD/);

  const file = path.join(repo, "agenthook.config.json");
  fs.writeFileSync(file, JSON.stringify(config));
  for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(repo, f), text);
  const cfg = loadConfig({ configPath: file });
  assert.equal(cfg.provider, "local");
  assert.equal(cfg.pipeline?.[0].sourceStatus, "code");
});

test("sanitizeName keeps [A-Za-z0-9._-] and never returns empty", () => {
  assert.equal(sanitizeName("my repo (v2)"), "my-repo-v2");
  assert.equal(sanitizeName("a.b_c-d"), "a.b_c-d");
  assert.equal(sanitizeName("!!!"), "local");
});

test("firstFreePort skips busy ports", async () => {
  const busy = new Set([4123, 4124]);
  assert.equal(await firstFreePort(4123, { inUse: async (p) => busy.has(p) }), 4125);
  await assert.rejects(() => firstFreePort(1, { tries: 2, inUse: async () => true }), /no free port/);
});

test("init --local --yes in a git repo with a commit: writes config + instructions, fullAuto off, keeps existing files", async () => {
  const repo = tmp("ah-init-local-");
  git(repo, ["init", "-q"]);
  git(repo, ["commit", "-q", "--allow-empty", "-m", "first"]);
  fs.writeFileSync(path.join(repo, "INSTRUCTIONS_CODE.md"), "mine\n");
  const out = path.join(repo, "agenthook.config.json");
  await inDir(repo, () => init({ _: [], local: true, yes: true, name: "ah init test!", config: out }));

  const config = JSON.parse(fs.readFileSync(out, "utf8"));
  assert.equal(config.name, "ah-init-test");
  assert.equal(config.fullAuto, false);
  assert.equal(fs.realpathSync(config.repoPath), fs.realpathSync(repo));
  assert.equal(fs.readFileSync(path.join(repo, "INSTRUCTIONS_CODE.md"), "utf8"), "mine\n", "existing file untouched");
  assert.match(fs.readFileSync(path.join(repo, "INSTRUCTIONS_REVIEW.md"), "utf8"), /review/);
  assert.equal(loadConfig({ configPath: out }).provider, "local");

  await assert.rejects(() => inDir(repo, () => init({ _: [], local: true, yes: true, config: out })), /already exists/);
  await inDir(repo, () => init({ _: [], local: true, yes: true, force: true, "full-auto": true, config: out }));
  assert.equal(JSON.parse(fs.readFileSync(out, "utf8")).fullAuto, true, "--full-auto is the non-interactive opt-in");
});

test("init --local --yes summary prints the state dir under AGENTHOOK_HOME, not ~/.agenthook", async () => {
  const repo = tmp("ah-init-statedir-");
  git(repo, ["init", "-q"]);
  git(repo, ["commit", "-q", "--allow-empty", "-m", "first"]);
  const out = path.join(repo, "agenthook.config.json");
  const lines = [];
  const prev = process.cwd();
  const { log, warn } = console;
  process.chdir(repo);
  console.log = (...a) => lines.push(a.join(" "));
  console.warn = () => {};
  try {
    await init({ _: [], local: true, yes: true, name: "ah init statedir", config: out });
  } finally {
    process.chdir(prev);
    Object.assign(console, { log, warn });
  }

  const config = JSON.parse(fs.readFileSync(out, "utf8"));
  const expected = tildify(path.join(registryDir, config.name));
  assert.ok(lines.some((l) => l.includes(expected)), "summary should contain the AGENTHOOK_HOME-derived state dir");
  assert.ok(!lines.some((l) => l.includes("~/.agenthook/")), "summary should not hard-code ~/.agenthook");
});

let otherSeq = 0;
/** Register (marker + config) a stopped "other" profile claiming `port`, under its own stateKey.
 * Registers under the shared registryDir (this test file's AGENTHOOK_HOME), so callers must
 * `cleanup()` once done — other tests in this file share the same registry.
 * @param {number} port @returns {{ name: string, cleanup: () => void }} */
function registerOther(port) {
  const label = `ah-other-${process.pid}-${++otherSeq}`;
  const root = tmp(`ah-other-${label}-`);
  const file = path.join(root, "agenthook.config.json");
  fs.writeFileSync(file, JSON.stringify({ port }));
  const dir = path.join(registryDir, label);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "profile.json"), JSON.stringify({ configPath: file, stateKey: label, name: label }));
  return { name: label, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** Run `init({ ...opts, local: true })` in `repo`, capturing console.log lines. An injected
 * `inUse` (default: nothing is listening) keeps the port auto-pick independent of the host's
 * actual open ports. @param {string} repo @param {Record<string, any>} opts
 * @param {(port: number) => Promise<boolean>} [inUse] */
async function initLocalCapturing(repo, opts, inUse = async () => false) {
  /** @type {string[]} */
  const lines = [];
  const prev = process.cwd();
  const { log, warn } = console;
  process.chdir(repo);
  console.log = (/** @type {any[]} */ ...a) => lines.push(a.join(" "));
  console.warn = () => {};
  try {
    await init({ _: [], local: true, ...opts }, { inUse });
  } finally {
    process.chdir(prev);
    Object.assign(console, { log, warn });
  }
  return lines;
}

/** @param {string} prefix */
function freshRepo(prefix) {
  const repo = tmp(prefix);
  git(repo, ["init", "-q"]);
  git(repo, ["commit", "-q", "--allow-empty", "-m", "first"]);
  return repo;
}

test("init --local: a port claimed by a stopped registered profile is skipped, with a reason naming it", async () => {
  const { name, cleanup } = registerOther(4123);
  try {
    const repo = freshRepo("ah-init-claim-");
    const out = path.join(repo, "agenthook.config.json");
    const lines = await initLocalCapturing(repo, { yes: true, name: "ah-init-claim", config: out });
    const config = JSON.parse(fs.readFileSync(out, "utf8"));
    assert.equal(config.port, 4124);
    assert.ok(lines.some((l) => l.includes(`4123 claimed by profile "${name}"`)), lines.join("\n"));
  } finally {
    cleanup();
  }
});

test("init --local: nothing skipped prints a plain port line", async () => {
  const repo = freshRepo("ah-init-plain-");
  const out = path.join(repo, "agenthook.config.json");
  const lines = await initLocalCapturing(repo, { yes: true, name: "ah-init-plain", config: out });
  const config = JSON.parse(fs.readFileSync(out, "utf8"));
  assert.equal(config.port, 4123);
  const portLine = lines.find((l) => /^ {2}port /.test(l));
  assert.equal(portLine, `  port    4123`);
});

test("init --local --port <n>: writes the exact port when it's free and unclaimed", async () => {
  const repo = freshRepo("ah-init-port-");
  const out = path.join(repo, "agenthook.config.json");
  await initLocalCapturing(repo, { yes: true, name: "ah-init-port", port: "5000", config: out });
  assert.equal(JSON.parse(fs.readFileSync(out, "utf8")).port, 5000);
});

test("init --local --port <n>: errors (and writes nothing) when the port is listening", async () => {
  const repo = freshRepo("ah-init-port-busy-");
  const out = path.join(repo, "agenthook.config.json");
  const inUse = async (/** @type {number} */ p) => p === 5001;
  await assert.rejects(
    () => initLocalCapturing(repo, { yes: true, name: "ah-init-port-busy", port: "5001", config: out }, inUse),
    /is already in use/,
  );
  assert.ok(!fs.existsSync(out));
});

test("init --local --port <n>: errors (and writes nothing) when another registered profile claims it", async () => {
  const { name, cleanup } = registerOther(4123);
  try {
    const repo = freshRepo("ah-init-port-claimed-");
    const out = path.join(repo, "agenthook.config.json");
    await assert.rejects(
      () => initLocalCapturing(repo, { yes: true, name: "ah-init-port-claimed", port: "4123", config: out }),
      new RegExp(`claimed by profile "${name}" — pick another with --port <n>`),
    );
    assert.ok(!fs.existsSync(out));
  } finally {
    cleanup();
  }
});

test("init --local --port <n>: errors (and writes nothing) on a non-integer or out-of-range value", async () => {
  const repo = freshRepo("ah-init-port-invalid-");
  const out = path.join(repo, "agenthook.config.json");
  await assert.rejects(() => initLocalCapturing(repo, { yes: true, name: "x", port: "abc", config: out }), /invalid --port/);
  await assert.rejects(() => initLocalCapturing(repo, { yes: true, name: "x", port: "0", config: out }), /invalid --port/);
  await assert.rejects(() => initLocalCapturing(repo, { yes: true, name: "x", port: "70000", config: out }), /invalid --port/);
  assert.ok(!fs.existsSync(out));
});

test("init --local --force over an existing profile keeps its own claimed port (doesn't self-conflict)", async () => {
  const repo = freshRepo("ah-init-reforce-");
  const out = path.join(repo, "agenthook.config.json");
  await initLocalCapturing(repo, { yes: true, name: "ah-init-reforce", config: out });
  const first = JSON.parse(fs.readFileSync(out, "utf8")).port;
  assert.equal(first, 4123);
  const dir = path.join(registryDir, "ah-init-reforce");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "profile.json"), JSON.stringify({ configPath: out, stateKey: "ah-init-reforce", name: "ah-init-reforce" }));
  const lines = await initLocalCapturing(repo, { yes: true, name: "ah-init-reforce", force: true, config: out });
  const second = JSON.parse(fs.readFileSync(out, "utf8")).port;
  assert.equal(second, first);
  assert.equal(lines.find((l) => /^ {2}port /.test(l)), `  port    ${first}`);
});

test("init --local outside a git repo, or in one with no commits, refuses and writes nothing", async () => {
  const plain = tmp("ah-init-nogit-");
  await assert.rejects(() => inDir(plain, () => init({ _: [], local: true, yes: true })), /must run inside a git repository \(git init && git commit first\)/);
  assert.deepEqual(fs.readdirSync(plain), []);

  const empty = tmp("ah-init-nocommit-");
  git(empty, ["init", "-q"]);
  await assert.rejects(() => inDir(empty, () => init({ _: [], local: true, yes: true })), /git init && git commit first/);
  assert.deepEqual(fs.readdirSync(empty), [".git"]);
});

test("ticketBody: the cap counts encoded bytes, not characters", () => {
  const cjk = "字".repeat(20000); // 20k chars, 60k UTF-8 bytes
  assert.ok(cjk.length < TICKET_BODY_MAX);
  assert.match(String(/** @type {any} */ (ticketBody({ body: cjk })).error), /bytes encoded/);
  const quotes = '"'.repeat(30000); // 30k chars, ~60k once JSON-escaped
  assert.match(String(/** @type {any} */ (ticketBody({ body: quotes })).error), /bytes encoded/);
  assert.equal(ticketBody({ body: "a".repeat(40000) }).length, 40000);
});

test("ticketBody: --body or --file, never both", () => {
  assert.equal(ticketBody({}), "");
  assert.equal(ticketBody({ body: "text" }), "text");
  const f = path.join(tmp("ah-body-"), "spec.md");
  fs.writeFileSync(f, "from a file\n");
  assert.equal(ticketBody({ file: f }), "from a file\n");
  assert.match(/** @type {any} */ (ticketBody({ body: "a", file: f })).error, /--body or --file, not both/);
  assert.match(/** @type {any} */ (ticketBody({ body: true })).error, /--body needs a value/);
  assert.match(/** @type {any} */ (ticketBody({ file: f + ".missing" })).error, /cannot read/);
  assert.match(/** @type {any} */ (ticketBody({ body: "x".repeat(60 * 1024) })).error, /keep it under/);
});

test("ticketRows: refs ascending (numeric first), running/held/blocked marks", () => {
  const board = { "10": { name: "ten", stage: "code", blockedBy: ["2", "E1"] }, "2": { name: "two", stage: "review" }, E1: { name: "named", stage: "done" } };
  const cfg = /** @type {any} */ ({ pipeline: [{ id: "done", manual: true, sourceStatus: "done" }] });
  assert.deepEqual(ticketRows(board, { "10": { stepId: "code" } }, { "2": { stepId: "review" } }, cfg), [
    { ref: "2", stage: "review", title: "two", held: "review" },
    { ref: "10", stage: "code", title: "ten", running: "code", blockedBy: ["2"] },
    { ref: "E1", stage: "done", title: "named" },
  ]);
  assert.deepEqual(ticketRows(board, {}, {})[1].blockedBy, ["2", "E1"], "without a pipeline every blocker counts as open");
});

test("ticket add: a trailing --blocked-by with no value is refused (never a silently unblocked ticket)", async () => {
  const dir = tmp("ah-ticket-bb-");
  const file = path.join(dir, "agenthook.config.json");
  fs.writeFileSync(file, JSON.stringify({ name: "ah-ticket-bb", repoPath: dir, ingress: { type: "manual", url: "http://127.0.0.1:1" }, tracker: { type: "local", pipeline: [{ id: "code", sourceStatus: "code", successStatus: "done" }, { id: "done", manual: true, sourceStatus: "done" }] } }));
  const { exit, error } = { exit: process.exit, error: console.error };
  /** @type {string[]} */
  const errs = [];
  console.error = (/** @type {string} */ m) => errs.push(m);
  process.exit = /** @type {any} */ (() => {
    throw Object.assign(new Error("exit"), { code: 1 });
  });
  try {
    for (const bad of [parse(["add", "x", "--blocked-by"]), { _: ["add", "x"], "blocked-by": " , " }, { _: ["add", "x"], "blocked-by": true }]) {
      await assert.rejects(() => ticket({ ...bad, config: file }), (/** @type {any} */ e) => e.code === 1);
    }
  } finally {
    Object.assign(process, { exit });
    console.error = error;
  }
  assert.equal(errs.length, 3);
  for (const m of errs) assert.match(m, /--blocked-by needs a comma-separated list of refs/);
});

test("ticket add on a non-local profile exits 1 with the board hint", async () => {
  const dir = tmp("ah-ticket-gh-");
  const file = path.join(dir, "agenthook.config.json");
  fs.writeFileSync(file, JSON.stringify({ name: "ah-ticket-gh", repoPath: dir, tracker: { type: "github", repository: "o/r", token: "t", pipeline: [{ id: "code", sourceLabel: "a" }] } }));
  const { exit, error } = { exit: process.exit, error: console.error };
  /** @type {string[]} */
  const errs = [];
  console.error = (/** @type {string} */ m) => errs.push(m);
  process.exit = /** @type {any} */ ((/** @type {number} */ code) => {
    throw Object.assign(new Error("exit"), { code });
  });
  try {
    await assert.rejects(() => ticket({ _: ["add", "x"], config: file }), (/** @type {any} */ e) => e.code === 1);
  } finally {
    Object.assign(process, { exit });
    console.error = error;
  }
  assert.match(errs[0], /ticket add is for local profiles — add work on your GitHub board, then `agenthook run <ref>`/);
});

test("CLI: --body/--file/--step/--name/--blocked-by are value flags; help lists ticket add|ls and init --local", () => {
  const a = parse(["add", "fix it", "--body", "why", "--step", "review", "--file", "f.md", "--name", "n", "--blocked-by", "3,7", "--yes"]);
  assert.deepEqual(a, { _: ["add", "fix it"], body: "why", step: "review", file: "f.md", name: "n", "blocked-by": "3,7", yes: true });
  assert.match(HELP, /ticket add "<title>"/);
  assert.match(HELP, /--blocked-by <ref,ref>/);
  assert.match(HELP, /ticket ls/);
  assert.match(HELP, /init --local/);
});
