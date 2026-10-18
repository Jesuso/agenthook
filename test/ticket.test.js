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
import { firstFreePort } from "../src/port.js";
import { loadConfig } from "../src/config.js";
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

test("init --local outside a git repo, or in one with no commits, refuses and writes nothing", async () => {
  const plain = tmp("ah-init-nogit-");
  await assert.rejects(() => inDir(plain, () => init({ _: [], local: true, yes: true })), /must run inside a git repository \(git init && git commit first\)/);
  assert.deepEqual(fs.readdirSync(plain), []);

  const empty = tmp("ah-init-nocommit-");
  git(empty, ["init", "-q"]);
  await assert.rejects(() => inDir(empty, () => init({ _: [], local: true, yes: true })), /git init && git commit first/);
  assert.deepEqual(fs.readdirSync(empty), [".git"]);
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

test("ticketRows: refs ascending (numeric first), running/held marks", () => {
  const board = { "10": { name: "ten", stage: "code" }, "2": { name: "two", stage: "review" }, E1: { name: "named", stage: "done" } };
  assert.deepEqual(ticketRows(board, { "10": { stepId: "code" } }, { "2": { stepId: "review" } }), [
    { ref: "2", stage: "review", title: "two", held: "review" },
    { ref: "10", stage: "code", title: "ten", running: "code" },
    { ref: "E1", stage: "done", title: "named" },
  ]);
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

test("CLI: --body/--file/--step/--name are value flags; help lists ticket add|ls and init --local", () => {
  const a = parse(["add", "fix it", "--body", "why", "--step", "review", "--file", "f.md", "--name", "n", "--yes"]);
  assert.deepEqual(a, { _: ["add", "fix it"], body: "why", step: "review", file: "f.md", name: "n", yes: true });
  assert.match(HELP, /ticket add "<title>"/);
  assert.match(HELP, /ticket ls/);
  assert.match(HELP, /init --local/);
});
