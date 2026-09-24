// Multi-repo routing — pure-unit coverage of resolveRepo (src/repos.js): route keys →
// exactly one repo, the default on no match, and fail-closed errors on ambiguity.
import test from "node:test";
import assert from "node:assert/strict";
import { resolveRepo, defaultRepo, repoById, primaryRepo } from "../src/repos.js";

/** @param {boolean} [withDefault] */
const cfgOf = (withDefault = true) =>
  /** @type {any} */ ({
    multiRepo: true,
    repos: [
      { id: "mono", path: "/w/mono", match: ["frontend", "backend", "infra"], ...(withDefault ? { default: true } : {}) },
      { id: "ios", path: "/w/ios", match: ["ios"] },
      { id: "android", path: "/w/android", match: ["android"] },
    ],
  });

/** @param {any} r */
const idOf = (r) => ("repo" in r ? r.repo.id : r.error);

test("resolveRepo: a single matching key selects its repo", () => {
  assert.equal(idOf(resolveRepo(cfgOf(), ["iOS"])), "ios");
  assert.equal(idOf(resolveRepo(cfgOf(), ["android"])), "android");
});

test("resolveRepo: several keys of one repo still select that one repo", () => {
  assert.equal(idOf(resolveRepo(cfgOf(), ["frontend", "backend", "infra"])), "mono");
});

test("resolveRepo: keys compare trimmed and case-insensitive; empties dropped", () => {
  assert.equal(idOf(resolveRepo(cfgOf(false), ["  IOS  ", "", "   "])), "ios");
  assert.equal(idOf(resolveRepo(cfgOf(false), ["Backend", "BACKEND"])), "mono");
});

test("resolveRepo: unrouted (absent / empty / unknown keys) → the default repo", () => {
  assert.equal(idOf(resolveRepo(cfgOf(), undefined)), "mono");
  assert.equal(idOf(resolveRepo(cfgOf(), [])), "mono");
  assert.equal(idOf(resolveRepo(cfgOf(), ["web"])), "mono");
});

test("resolveRepo: unrouted without a default → unroutable, naming keys and repos", () => {
  const r = /** @type {any} */ (resolveRepo(cfgOf(false), ["web"]));
  assert.equal(r.error, "unroutable");
  assert.match(r.message, /"web"/);
  assert.match(r.message, /mono, ios, android/);
  assert.equal(/** @type {any} */ (resolveRepo(cfgOf(false), [])).error, "unroutable");
  assert.equal(/** @type {any} */ (resolveRepo(cfgOf(false), undefined)).error, "unroutable");
});

test("resolveRepo: keys matching two repos → conflict, never a guess (even with a default)", () => {
  const r = /** @type {any} */ (resolveRepo(cfgOf(), ["iOS", "backend"]));
  assert.equal(r.error, "conflict");
  assert.match(r.message, /mono, ios/);
  assert.match(r.message, /"ios", "backend"/);
});

test("single-repo fallback: no cfg.repos → one synthesized default at repoPath", () => {
  const cfg = /** @type {any} */ ({ repoPath: "/r" });
  assert.deepEqual(primaryRepo(cfg), { id: "default", path: "/r", match: [], default: true });
  assert.equal(idOf(resolveRepo(cfg, ["anything"])), "default");
});

test("defaultRepo / repoById / primaryRepo", () => {
  assert.equal(defaultRepo(cfgOf())?.id, "mono");
  assert.equal(defaultRepo(cfgOf(false)), undefined);
  assert.equal(primaryRepo(cfgOf(false)).id, "mono", "no default → the first repo");
  assert.equal(repoById(cfgOf(), "ios")?.path, "/w/ios");
  assert.equal(repoById(cfgOf(), "nope"), undefined);
  assert.equal(repoById(cfgOf(), undefined), undefined);
});
