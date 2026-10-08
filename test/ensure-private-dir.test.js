// ensurePrivateDir — pure fs unit, tmpdir-based (never touches ~/.agenthook).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensurePrivateDir } from "../src/config.js";

function mode(p) {
  return fs.statSync(p).mode & 0o777;
}

test("a missing dir is created 0700 and its parent's mode is unchanged", { skip: process.platform === "win32" }, () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "ah-epd-"));
  fs.chmodSync(parent, 0o755);
  const dir = path.join(parent, "state");
  const result = ensurePrivateDir(dir);
  assert.deepEqual(result, { tightened: false });
  assert.equal(mode(dir), 0o700);
  assert.equal(mode(parent), 0o755);
  fs.rmSync(parent, { recursive: true, force: true });
});

test("a missing dir's missing ancestors are created without a mode stamp", { skip: process.platform === "win32" }, () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "ah-epd-"));
  const dir = path.join(parent, "profile", "logs");
  const result = ensurePrivateDir(dir);
  assert.deepEqual(result, { tightened: false });
  assert.equal(mode(dir), 0o700);
  assert.notEqual(mode(path.join(parent, "profile")), 0o700);
  fs.rmSync(parent, { recursive: true, force: true });
});

test("an existing 0775 dir is left alone when tighten is not set (loadConfig path)", { skip: process.platform === "win32" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-epd-"));
  fs.chmodSync(dir, 0o775);
  const result = ensurePrivateDir(dir);
  assert.deepEqual(result, { tightened: false });
  assert.equal(mode(dir), 0o775);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("an existing 0775 dir is tightened to 0700 when tighten is set (boot path)", { skip: process.platform === "win32" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-epd-"));
  fs.chmodSync(dir, 0o775);
  const result = ensurePrivateDir(dir, { tighten: true });
  assert.equal(result.tightened, true);
  assert.ok(result.tightened && result.from === 0o775);
  assert.equal(mode(dir), 0o700);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("an already-0700 dir reports no tightening", { skip: process.platform === "win32" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-epd-"));
  fs.chmodSync(dir, 0o700);
  const result = ensurePrivateDir(dir, { tighten: true });
  assert.deepEqual(result, { tightened: false });
  fs.rmSync(dir, { recursive: true, force: true });
});
