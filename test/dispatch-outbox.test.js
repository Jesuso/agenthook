import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// The outbox contract (src/dispatch/outbox.js, #825): a remote run's agent leaves pr.json and
// comment.md next to its verdict; the hub parses them as UNTRUSTED TEXT — size-capped, never
// executed, FIFOs never opened, a trigger-prefixed comment dropped (it would self-trigger the
// resume gate). readOutbox never throws; every bad case is dropped with exactly ONE log line.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { readOutbox, OUTBOX_TITLE_MAX, OUTBOX_FIELD_MAX_BYTES, OUTBOX_FILE_NAMES } from "../src/dispatch/outbox.js";

/** @param {string} name @returns {{dir: string, outbox: string, lines: string[], done: () => void}} */
function sandbox(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ah-outbox-${name}-`));
  const outbox = path.join(dir, "outbox");
  fs.mkdirSync(outbox);
  /** @type {string[]} */
  const lines = [];
  return { dir, outbox, lines, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const write = (p, data) => fs.writeFileSync(p, data);

test("valid pr.json + comment.md are parsed, nothing else is read", () => {
  const sb = sandbox("valid");
  try {
    write(path.join(sb.outbox, "pr.json"), JSON.stringify({ title: "  Fix the flaky test  ", body: "what I did and why" }));
    write(path.join(sb.outbox, "comment.md"), "Ran the suite, here is the result.");
    write(path.join(sb.outbox, "evil.sh"), "#!/bin/sh\nrm -rf /"); // an unknown name — never read
    const out = readOutbox(sb.dir, (l) => sb.lines.push(l), "@agent");
    assert.deepEqual(out, { pr: { title: "Fix the flaky test", body: "what I did and why" }, comment: "Ran the suite, here is the result." });
    assert.deepEqual(sb.lines, [], "a clean outbox logs nothing");
  } finally {
    sb.done();
  }
});

test("missing outbox dir is fine; a symlinked or non-directory outbox is ignored with one line", () => {
  const sb = sandbox("nkdir");
  try {
    const none = readOutbox(path.join(sb.dir, "nope"), (l) => sb.lines.push(l));
    assert.deepEqual(none, {});
    assert.deepEqual(sb.lines, [], "an absent outbox dir is the normal case — no log line");

    const real = path.join(sb.dir, "real-outbox");
    fs.renameSync(sb.outbox, real);
    write(path.join(real, "comment.md"), "should never be read through a symlink");
    fs.symlinkSync(real, sb.outbox);
    const asLink = readOutbox(sb.dir, (l) => sb.lines.push(l));
    assert.deepEqual(asLink, {}, "a symlinked outbox dir is refused — never read through");
    assert.equal(sb.lines.length, 1);
    assert.match(sb.lines[0], /symlink/);
    sb.lines.length = 0;

    fs.unlinkSync(sb.outbox);
    const file = path.join(sb.dir, "outbox");
    write(file, "x");
    const asFile = readOutbox(sb.dir, (l) => sb.lines.push(l));
    assert.deepEqual(asFile, {});
    assert.equal(sb.lines.length, 1);
    assert.match(sb.lines[0], /not a directory/);
  } finally {
    sb.done();
  }
});

test("pr.json: invalid JSON, wrong container, wrong types, empty/multi-line/oversize title — one line each", () => {
  const cases = [
    ["not json {", /not valid JSON/],
    ["[1,2]", /not a JSON object/],
    [JSON.stringify({ title: 7, body: "b" }), /title is not a string/],
    [JSON.stringify({ body: "b" }), /title is not a string/],
    [JSON.stringify({ title: "   ", body: "b" }), /title is empty/],
    [JSON.stringify({ title: "line one\nline two", body: "b" }), /single line/],
    [JSON.stringify({ title: `a${"\r"}b`, body: "b" }), /single line/],
    [JSON.stringify({ title: "x".repeat(OUTBOX_TITLE_MAX + 1), body: "b" }), /title is \d+ chars/],
    [JSON.stringify({ title: "ok", body: 9 }), /body is not a string/],
  ];
  for (const [text, re] of cases) {
    const sb = sandbox("prjson");
    try {
      write(path.join(sb.outbox, "pr.json"), text);
      const out = readOutbox(sb.dir, (l) => sb.lines.push(l));
      assert.equal(out.pr, undefined, `expected no pr for ${text.slice(0, 40)}`);
      assert.equal(sb.lines.length, 1, `expected exactly one log line, got ${JSON.stringify(sb.lines)}`);
      assert.match(sb.lines[0], /outbox\/pr\.json/);
      assert.match(sb.lines[0], re);
    } finally {
      sb.done();
    }
  }
});

test("pr.json: an oversize body is dropped; the comment.md in the same outbox is still published", () => {
  const sb = sandbox("bigbody");
  try {
    write(path.join(sb.outbox, "pr.json"), JSON.stringify({ title: "ok", body: "y".repeat(OUTBOX_FIELD_MAX_BYTES + 1) }));
    write(path.join(sb.outbox, "comment.md"), "still published");
    const out = readOutbox(sb.dir, (l) => sb.lines.push(l), "@agent");
    assert.equal(out.pr, undefined);
    assert.equal(out.comment, "still published");
    assert.equal(sb.lines.length, 1);
    assert.match(sb.lines[0], /exceeds the \d+-byte cap/);
  } finally {
    sb.done();
  }
});

test("comment.md: empty is dropped, oversize is dropped, a trigger-prefixed comment is dropped naming the hazard", () => {
  const sb = sandbox("comment");
  try {
    write(path.join(sb.outbox, "comment.md"), "   \n  ");
    readOutbox(sb.dir, (l) => sb.lines.push(l), "@agent");
    assert.equal(sb.lines.length, 1);
    assert.match(sb.lines[0], /outbox\/comment\.md/);
    assert.match(sb.lines[0], /empty/);
    sb.lines.length = 0;

    write(path.join(sb.outbox, "comment.md"), "z".repeat(OUTBOX_FIELD_MAX_BYTES + 1));
    readOutbox(sb.dir, (l) => sb.lines.push(l), "@agent");
    assert.equal(sb.lines.length, 1);
    assert.match(sb.lines[0], /exceeds the \d+-byte cap/);
    sb.lines.length = 0;

    write(path.join(sb.outbox, "comment.md"), "@agent please look at this again");
    const out = readOutbox(sb.dir, (l) => sb.lines.push(l), "@agent");
    assert.equal(out.comment, undefined);
    assert.equal(sb.lines.length, 1);
    assert.match(sb.lines[0], /self-trigger/);
    assert.match(sb.lines[0], /resume gate/);
    sb.lines.length = 0;

    // The same text with NO configured trigger is ordinary comment text.
    write(path.join(sb.outbox, "comment.md"), "@agent please look at this again");
    const out2 = readOutbox(sb.dir, (l) => sb.lines.push(l));
    assert.equal(out2.comment, "@agent please look at this again");
    assert.equal(sb.lines.length, 0);
  } finally {
    sb.done();
  }
});

test("entries: a symlinked file is refused without touching its target; a FIFO is never opened; a dir entry is refused", () => {
  const sb = sandbox("entry");
  try {
    const target = path.join(sb.dir, "secret.md");
    write(target, "the real secret");
    const t0 = fs.statSync(target).mtimeMs;
    fs.symlinkSync(target, path.join(sb.outbox, "comment.md"));
    const out = readOutbox(sb.dir, (l) => sb.lines.push(l));
    assert.equal(out.comment, undefined);
    assert.equal(fs.statSync(target).mtimeMs, t0, "the symlink's target was read");
    assert.equal(sb.lines.length, 1);
    assert.match(sb.lines[0], /symlink/);
    sb.lines.length = 0;

    const fifo = path.join(sb.outbox, "pr.json");
    fs.unlinkSync(path.join(sb.outbox, "comment.md")); // clear the symlink sub-case first
    execFileSync("mkfifo", [fifo]);
    const out2 = readOutbox(sb.dir, (l) => sb.lines.push(l)); // must NOT hang: a FIFO is never opened
    assert.equal(out2.pr, undefined);
    assert.equal(sb.lines.length, 1);
    assert.match(sb.lines[0], /not a regular file/);
    sb.lines.length = 0;

    fs.rmSync(fifo);
    fs.mkdirSync(fifo);
    const out3 = readOutbox(sb.dir, (l) => sb.lines.push(l));
    assert.equal(out3.pr, undefined);
    assert.equal(sb.lines.length, 1);
    assert.match(sb.lines[0], /not a regular file/);
  } finally {
    sb.done();
  }
});

test("exported limits: the two outbox names and the caps", () => {
  assert.deepEqual([...OUTBOX_FILE_NAMES], ["pr.json", "comment.md"]);
  assert.equal(OUTBOX_TITLE_MAX, 200);
  assert.equal(OUTBOX_FIELD_MAX_BYTES, 60 * 1024);
  assert.ok(OUTBOX_FILE_NAMES.every((n) => typeof n === "string" && n.length > 0));
});
