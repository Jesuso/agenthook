import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// Pure JSON text editor backing `agenthook rename` — changes only the top-level "name" (and
// optionally inserts "stateId" right after it) without re-serialising anything else.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { renameInConfigText, setStateIdInConfigText } from "../src/json-edit.js";

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

test("\\u escapes in a nested string and a top-level key don't trip the scanner", () => {
  const text = '{\n  "name": "old",\n  "caf\\u00e9": "x",\n  "tracker": {\n    "x": "caf\\u00e9"\n  }\n}\n';
  const out = renameInConfigText(text, "new", "old");
  assert.equal(out, '{\n  "name": "new",\n  "stateId": "old",\n  "caf\\u00e9": "x",\n  "tracker": {\n    "x": "caf\\u00e9"\n  }\n}\n');
  assert.deepEqual(JSON.parse(out), { ...JSON.parse(text), name: "new", stateId: "old" });
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

// setStateIdInConfigText — `rename --move`'s editor: set, replace or drop the top-level stateId.

test("setStateId: replaces an existing value in place", () => {
  const text = '{\n  "name": "new",\n  "stateId": "old",\n  "other": 1\n}\n';
  assert.equal(setStateIdInConfigText(text, "moved"), '{\n  "name": "new",\n  "stateId": "moved",\n  "other": 1\n}\n');
});

test("setStateId null: removes the member and its line (multi-line, middle and last)", () => {
  assert.equal(
    setStateIdInConfigText('{\n  "name": "new",\n  "stateId": "old",\n  "other": 1\n}\n', null),
    '{\n  "name": "new",\n  "other": 1\n}\n',
  );
  assert.equal(setStateIdInConfigText('{\n  "name": "new",\n  "stateId": "old"\n}\n', null), '{\n  "name": "new"\n}\n');
  assert.equal(setStateIdInConfigText('{\n  "stateId": "old",\n  "name": "new"\n}\n', null), '{\n  "name": "new"\n}\n');
});

test("setStateId null: compact JSON (middle and last)", () => {
  assert.equal(setStateIdInConfigText('{"name": "new", "stateId": "old", "x": 1}', null), '{"name": "new", "x": 1}');
  assert.equal(setStateIdInConfigText('{"name":"new","stateId":"old"}', null), '{"name":"new"}');
});

test("setStateId null with no stateId: unchanged", () => {
  const text = '{\n  "name": "n"\n}\n';
  assert.equal(setStateIdInConfigText(text, null), text);
});

test("setStateId: inserts after name when absent (multi-line + compact)", () => {
  assert.equal(setStateIdInConfigText('{\n  "name": "n",\n  "x": 1\n}\n', "k"), '{\n  "name": "n",\n  "stateId": "k",\n  "x": 1\n}\n');
  assert.equal(setStateIdInConfigText('{"name": "n", "x": 1}', "k"), '{"name": "n", "stateId": "k", "x": 1}');
});

test("setStateId: preserves CRLF, tab indent and key order", () => {
  const text = '{\r\n\t"a": 1,\r\n\t"name": "n",\r\n\t"stateId": "old",\r\n\t"z": [1, 2]\r\n}\r\n';
  assert.equal(setStateIdInConfigText(text, null), '{\r\n\t"a": 1,\r\n\t"name": "n",\r\n\t"z": [1, 2]\r\n}\r\n');
  assert.equal(setStateIdInConfigText('{\r\n\t"name": "n",\r\n\t"z": 1\r\n}\r\n', "k"), '{\r\n\t"name": "n",\r\n\t"stateId": "k",\r\n\t"z": 1\r\n}\r\n');
});

test("setStateId on the example config: drop round-trips", () => {
  const withId = setStateIdInConfigText(EXAMPLE, "keyed");
  assert.equal(JSON.parse(withId).stateId, "keyed");
  assert.equal(setStateIdInConfigText(withId, null), EXAMPLE);
});

test("setStateId: throws on a duplicate or non-string stateId", () => {
  assert.throws(() => setStateIdInConfigText('{"name":"n","stateId":"a","stateId":"b"}', null), /duplicate/);
  assert.throws(() => setStateIdInConfigText('{"name":"n","stateId":5}', "k"), /not a string/);
  assert.throws(() => setStateIdInConfigText('{"name":"n","stateId":null}', null), /not a string/);
});

test("setStateId: a nested stateId is never touched", () => {
  const text = '{\n  "name": "n",\n  "tracker": { "stateId": "inner" }\n}\n';
  const out = setStateIdInConfigText(text, "k");
  assert.deepEqual(JSON.parse(out), { name: "n", stateId: "k", tracker: { stateId: "inner" } });
});
