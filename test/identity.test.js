import "./_setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import { PROFILE_COLORS, PROFILE_EMOJIS, deriveIdentity, identityErrors, isProfileColor, isProfileEmoji, resolveIdentity } from "../src/identity.js";

test("the palette excludes status hues and the emoji list has unique single entries", () => {
  for (const c of ["red", "amber", "green", "orange", "yellow"]) assert.ok(!PROFILE_COLORS.includes(c), c);
  assert.equal(new Set(PROFILE_EMOJIS).size, PROFILE_EMOJIS.length);
  assert.ok(PROFILE_EMOJIS.length >= 200);
});

test("every emoji is one code point: no variation selector or ZWJ sequence, so it round-trips as a plain string", () => {
  for (const e of PROFILE_EMOJIS) assert.equal([...e].length, 1, `${e} ${[...e].map((c) => c.codePointAt(0)?.toString(16)).join(" ")}`);
});

test("deriveIdentity is deterministic and always lands on the palette / list", () => {
  for (const key of ["agenthook", "acme", "cahui", "a", "ünïcode", ""]) {
    const a = deriveIdentity(key);
    assert.deepEqual(a, deriveIdentity(key));
    assert.ok(isProfileColor(a.color) && isProfileEmoji(a.emoji), key);
  }
});

test("deriveIdentity spreads keys over several colours (not one bucket)", () => {
  const colors = new Set(["agenthook", "acme", "cahui", "support", "content", "infra", "docs", "web"].map((k) => deriveIdentity(k).color));
  assert.ok(colors.size >= 4, [...colors].join());
});

test("resolveIdentity: a valid configured value wins per field, an invalid or absent one derives", () => {
  const d = deriveIdentity("k");
  assert.deepEqual(resolveIdentity("k", null), d);
  assert.deepEqual(resolveIdentity("k", { color: "pink" }), { color: "pink", emoji: d.emoji });
  assert.deepEqual(resolveIdentity("k", { emoji: "🦊" }), { color: d.color, emoji: "🦊" });
  assert.deepEqual(resolveIdentity("k", { color: "red", emoji: "nope" }), d);
});

test("identityErrors: absent and valid pass; bad shapes and values are named", () => {
  assert.deepEqual(identityErrors(undefined), []);
  assert.deepEqual(identityErrors({}), []);
  assert.deepEqual(identityErrors({ color: "teal", emoji: "🚀" }), []);
  assert.match(identityErrors([])[0], /"ui" must be an object/);
  assert.match(identityErrors({ color: "red" })[0], /ui\.color must be one of sky, indigo/);
  assert.match(identityErrors({ emoji: "x" })[0], /ui\.emoji must be one of the supported emoji/);
  assert.equal(identityErrors({ color: "red", emoji: "x" }).length, 2);
});
