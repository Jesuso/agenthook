import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// Pure JSON text editor backing `agenthook rename` — changes only the top-level "name" (and
// optionally inserts "stateId" right after it) without re-serialising anything else.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { renameInConfigText } from "../src/json-edit.js";

const EXAMPLE = fs.readFileSync(fileURLToPath(new URL("../agenthook.config.example.json", import.meta.url)), "utf8");

test("round-trip on the example config: only name changes, stateId inserted right after it", () => {
  const out = renameInConfigText(EXAMPLE, "new-label", "myproject");
  const before = EXAMPLE.split("\n");
  const after = out.split("\n");
  // Exactly one line changed (the name value) and one new line inserted (stateId) — everything
  // else, including indentation, comment keys and blank lines, is untouched.
  assert.equal(after.length, before.length + 1);
  assert.equal(before[5], '  "name": "myproject",');
  assert.equal(after[5], '  "name": "new-label",');
  assert.equal(after[6], '  "stateId": "myproject",');
  assert.deepEqual(after.slice(7), before.slice(6));
  assert.deepEqual(JSON.parse(out), { ...JSON.parse(EXAMPLE), name: "new-label", stateId: "myproject" });
});

test("stateId already present: only the name value changes, no stateId inserted", () => {
  const text = '{\n  "name": "old",\n  "stateId": "kept",\n  "other": 1\n}\n';
  const out = renameInConfigText(text, "new", "kept");
  assert.equal(out, '{\n  "name": "new",\n  "stateId": "kept",\n  "other": 1\n}\n');
});

test("no stateId, but stateKey === newName: nothing to disambiguate, no stateId inserted", () => {
  const text = '{\n  "name": "old",\n  "other": 1\n}\n';
  const out = renameInConfigText(text, "old2", "old2");
  assert.equal(out, '{\n  "name": "old2",\n  "other": 1\n}\n');
});

test("name as the last member (no trailing comma)", () => {
  const text = '{\n  "other": 1,\n  "name": "old"\n}\n';
  const out = renameInConfigText(text, "new", "old");
  assert.equal(out, '{\n  "other": 1,\n  "name": "new",\n  "stateId": "old"\n}\n');
  assert.deepEqual(JSON.parse(out), { other: 1, name: "new", stateId: "old" });
});

test("CRLF line endings are preserved", () => {
  const text = '{\r\n  "name": "old",\r\n  "other": 1\r\n}\r\n';
  const out = renameInConfigText(text, "new", "old");
  assert.equal(out, '{\r\n  "name": "new",\r\n  "stateId": "old",\r\n  "other": 1\r\n}\r\n');
});

test("compact single-line JSON: inline stateId insertion", () => {
  const text = '{ "name": "old", "other": 1 }';
  const out = renameInConfigText(text, "new", "old");
  assert.equal(out, '{ "name": "new", "stateId": "old", "other": 1 }');
  assert.deepEqual(JSON.parse(out), { name: "new", stateId: "old", other: 1 });
});

test("nested name keys are ignored", () => {
  const text = '{\n  "name": "old",\n  "tracker": {\n    "name": "nested"\n  }\n}\n';
  const out = renameInConfigText(text, "new", "old");
  assert.equal(out, '{\n  "name": "new",\n  "stateId": "old",\n  "tracker": {\n    "name": "nested"\n  }\n}\n');
});

test("missing top-level name throws", () => {
  assert.throws(() => renameInConfigText('{\n  "other": 1\n}\n', "new", "x"), /no top-level "name"/);
});

test("duplicate top-level name throws", () => {
  assert.throws(() => renameInConfigText('{\n  "name": "a",\n  "name": "b"\n}\n', "new", "x"), /duplicate top-level "name"/);
});

test("non-string top-level name throws", () => {
  assert.throws(() => renameInConfigText('{\n  "name": 7\n}\n', "new", "x"), /not a string/);
});
