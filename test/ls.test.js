import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// `agenthook ls` formatting — pure unit coverage of formatLs: the NAME column shows the
// label (`Label (stateKey)` when they differ) and a label shared by ≥2 profiles warns.
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { configCell, formatLs, truncLeft } from "../src/commands/ls.js";

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

test("truncLeft: short strings pass through; long ones keep the tail behind …", () => {
  assert.equal(truncLeft("abc", 5), "abc");
  assert.equal(truncLeft("abcdefgh", 5), "…efgh");
  assert.equal(truncLeft("abcdefgh", 5).length, 5);
});

test("formatLs: CONFIG is the last column — tildified, left-truncated, (missing), ghost text, ? when unknown", () => {
  const home = os.homedir();
  const short = path.join(home, "p", "agenthook.config.json");
  const long = path.join(home, "projects", "some", "deeply", "nested", "client", "repo", "agenthook.config.json");
  const rows = [
    { ...prof("a", "a"), configPath: short, ghost: false, configMissing: false },
    { ...prof("b", "b"), configPath: long, ghost: false, configMissing: true },
    { ...prof("c", "c"), configPath: null, ghost: true, createdAt: "2026-04-05T12:00:00.000Z", configMissing: false },
    { ...prof("d", "d"), configPath: null, ghost: false, configMissing: false },
  ];
  const lines = formatLs(rows);
  assert.match(lines[0], /LAST EVENT {2}CONFIG$/);
  const col = lines[0].indexOf("CONFIG");
  const cells = lines.slice(1).map((l) => l.slice(col));
  assert.equal(cells[0], "~" + short.slice(home.length));
  assert.ok(cells[1].startsWith("…") && cells[1].endsWith("repo/agenthook.config.json (missing)"), cells[1]);
  assert.equal(cells[1].length, 40 + " (missing)".length);
  assert.equal(cells[2], "— never ran (created 2026-04-05)");
  assert.equal(cells[3], "?");
  assert.equal(configCell({ configPath: "/etc/x.json" }), "/etc/x.json");
});
