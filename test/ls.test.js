// `agenthook ls` formatting — pure unit coverage of formatLs: the NAME column shows the
// label (`Label (stateKey)` when they differ) and a label shared by ≥2 profiles warns.
import test from "node:test";
import assert from "node:assert/strict";
import { formatLs } from "../src/commands/ls.js";

/** @param {string} stateKey @param {string} name */
const prof = (stateKey, name) => ({ stateKey, name, up: false, heartbeat: null });

test("formatLs: label == state key → bare name; label ≠ key → Label (key)", () => {
  const lines = formatLs([prof("dogfood", "dogfood"), prof("Old", "New")]);
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^NAME {12}UP/);
  assert.match(lines[1], /^dogfood {9}/);
  assert.match(lines[2], /^New \(Old\) {6}/);
});

test("formatLs: the NAME column widens to fit the longest name", () => {
  const lines = formatLs([prof("k", "a-very-long-profile-label")]);
  const w = "a-very-long-profile-label (k)".length + 2;
  assert.equal(lines[0].indexOf("UP"), w);
  assert.equal(lines[1].indexOf(" ", w - 2), w - 2);
});

test("formatLs: a duplicate label prints a warning naming both state keys", () => {
  const lines = formatLs([prof("k1", "Same"), prof("k2", "Same"), prof("k3", "Other")]);
  assert.equal(lines.at(-1), 'warning: label "Same" is shared by k1, k2 — address them by state key');
  assert.equal(lines.filter((l) => l.startsWith("warning:")).length, 1);
});
