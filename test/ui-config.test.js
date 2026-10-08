import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// `ah ui` config editor, server side — `GET /api/config` (view, validation errors, literal-secret
// warnings, every 404) and `PUT /api/config` (each guard, 409, 422 writes nothing, the atomic
// save with its `config-bak/` backup and `sensitive` audit line, SSE ui/disk events), plus the
// pure sensitiveChanges and the SECRET_FIELDS ⊆ SENSITIVE_FIELDS invariant.
// Temp registry + temp config files; ephemeral 127.0.0.1 port.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { SECRET_FIELDS } from "../src/config.js";
import { readConfigFile, sensitiveChanges, writeConfigFile } from "../src/ui/config.js";
import { SENSITIVE_FIELDS } from "../src/ui/contract.js";
import { UI_MAX_BYTES, backupPathFor } from "../src/ui/save.js";
import { createUiServer } from "../src/ui/server.js";

const TOKEN = "t0k3n-abcdefghijklmnopqrstuvwxyz0123456789";

// realpath: macOS' tmpdir is a symlink, and configPath is compared exactly.
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ah-ui-config-")));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const registry = path.join(root, "registry");
fs.mkdirSync(path.join(root, "dist"));

const sha = (/** @type {string|Buffer} */ s) => crypto.createHash("sha256").update(s).digest("hex");
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
const mode = (/** @type {string} */ f) => fs.statSync(f).mode & 0o7777;
const json = (/** @type {any} */ v) => JSON.stringify(v, null, 2) + "\n";

/** A config that passes validateRawConfig. @param {Record<string, any>} [o] */
const valid = (o = {}) => ({
  name: "p",
  repoPath: "/repo",
  fullAuto: false,
  tracker: { type: "github", token: "${GITHUB_TOKEN}", pipeline: [{ id: "code" }] },
  sinks: [
    { type: "slack", url: "${SLACK_URL}" },
    { type: "telegram", botToken: "${TG}", chatId: "1" },
  ],
  ...o,
});

/**
 * A profile whose heartbeat publishes `configPath` (or none when `configPath` is null), the
 * config in its own dir under root/cfg/<name>/ unless a path is given.
 * @param {string} name @param {string|null} [text] @param {string|null} [configPath]
 */
function profile(name, text = json(valid()), configPath) {
  const dir = path.join(registry, name);
  fs.mkdirSync(dir, { recursive: true });
  const file = configPath === undefined ? path.join(root, "cfg", name, "agenthook.config.json") : configPath;
  if (file && text !== null) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  fs.writeFileSync(path.join(dir, "heartbeat.json"), JSON.stringify(file ? { name, configPath: file } : { name }));
  return { dir, file: /** @type {string} */ (file) };
}

const P = profile("p");
const BAD = profile("bad", json({ name: "bad", tracker: { type: "github", token: "ghp_literal" } }));
const UNPARSE = profile("unparse", '{ "name": "u", ');
const LIVE = profile("live", json(valid({ name: "live" })));
const RACE = profile("race", json(valid({ name: "race" })));
const BAKLINK = profile("baklink", json(valid({ name: "baklink" })));
profile("nocfg", null, null);
const LINKED = profile("linked", null, path.join(root, "cfg", "linked", "agenthook.config.json"));
fs.mkdirSync(path.dirname(LINKED.file), { recursive: true });
fs.symlinkSync(P.file, LINKED.file);
fs.mkdirSync(path.join(root, "realdir"));
fs.writeFileSync(path.join(root, "realdir", "agenthook.config.json"), json(valid()));
fs.symlinkSync(path.join(root, "realdir"), path.join(root, "linkdir"));
profile("viadir", null, path.join(root, "linkdir", "agenthook.config.json"));
profile("isdir", null, path.join(root, "cfg"));
profile("missing", null, path.join(root, "cfg", "missing", "nope.json"));
profile("huge", "x".repeat(UI_MAX_BYTES + 1));
fs.writeFileSync(path.join(root, "bak-target"), "untouched\n");
fs.mkdirSync(path.join(BAKLINK.dir, "config-bak"), { mode: 0o700 });
fs.symlinkSync(path.join(root, "bak-target"), backupPathFor(BAKLINK.dir, BAKLINK.file, "config-bak"));

const server = createUiServer({ port: 0, token: TOKEN, distDir: path.join(root, "dist"), registry });
/** @type {number} */
let port;
test.before(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", () => r(undefined)));
  const a = server.address();
  port = a && typeof a === "object" ? a.port : 0;
});
test.after(() => new Promise((r) => server.close(() => r(undefined))));

/** A valid PUT's headers, with `o` overriding (null drops one). @param {Record<string, string|null>} [o] */
function hdrs(o = {}) {
  /** @type {Record<string, string|null>} */
  const h = {
    host: `127.0.0.1:${port}`,
    cookie: `ah_ui=${TOKEN}`,
    origin: `http://127.0.0.1:${port}`,
    "x-ah-ui": "1",
    "content-type": "application/json",
    ...o,
  };
  return /** @type {Record<string, string>} */ (Object.fromEntries(Object.entries(h).filter(([, v]) => v !== null)));
}

/**
 * @param {string} method @param {string} p @param {string|Buffer|null} body @param {Record<string, string|null>} [headers]
 * @returns {Promise<{ status: number, headers: http.IncomingHttpHeaders, body: string }>}
 */
function request(method, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port, path: p, method, headers: hdrs(headers), setHost: false, agent: false }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode || 0, headers: res.headers, body: text }));
    });
    r.on("error", reject);
    r.end(body ?? undefined);
  });
}

const get = (/** @type {string} */ name, /** @type {Record<string, string|null>} */ h = {}) =>
  request("GET", `/api/config?profile=${encodeURIComponent(name)}`, null, h);
const put = (/** @type {string|Buffer} */ body, /** @type {Record<string, string|null>} */ h = {}) => request("PUT", "/api/config", body, h);

/** A JSON save body for `prof`'s config from its current content. @param {{ file: string }} prof @param {string} text @param {object} [o] */
const save = (prof, text, o = {}) => JSON.stringify({ profile: path.basename(path.dirname(prof.file)), baseHash: sha(fs.readFileSync(prof.file)), text, ...o });

/** Everything a save could leave behind: the config dir listing, its content, the backup dir, the audit. @param {{ dir: string, file: string }} prof */
const footprint = (prof) => ({
  beside: fs.readdirSync(path.dirname(prof.file)).sort(),
  text: fs.readFileSync(prof.file, "utf8"),
  bak: fs.existsSync(path.join(prof.dir, "config-bak")),
  audit: fs.existsSync(path.join(prof.dir, "ui-audit.jsonl")),
});

test("SENSITIVE_FIELDS ⊇ SECRET_FIELDS (contract.js can't import config.js, so the list is a literal)", () => {
  for (const f of SECRET_FIELDS) assert.ok(SENSITIVE_FIELDS.includes(f), f);
  for (const f of ["fullAuto", "claudeBin", "tracker.userGid", "tracker.assigneeFilter", "tracker.email"]) assert.ok(SENSITIVE_FIELDS.includes(/** @type {any} */ (f)), f);
});

test("sensitiveChanges: concrete changed paths, [*] over the union of both arrays", () => {
  const a = valid();
  assert.deepEqual(sensitiveChanges(a, valid()), []);
  assert.deepEqual(sensitiveChanges(a, valid({ fullAuto: true })), ["fullAuto"]);
  const b = valid();
  b.sinks[1].botToken = "${OTHER}";
  assert.deepEqual(sensitiveChanges(a, b), ["sinks[1].botToken"]);
  // Non-sensitive edits are not reported; a key-order change is not a value change.
  assert.deepEqual(sensitiveChanges(a, valid({ maxConcurrent: 3 })), []);
  // `name` is sensitive too (it's the profile's label; writeConfigFile separately guards the state key).
  assert.deepEqual(sensitiveChanges(a, valid({ name: "q" })), ["name"]);
  // Added / removed fields and array elements.
  assert.deepEqual(sensitiveChanges(a, valid({ claudeBin: "/bin/claude" })), ["claudeBin"]);
  assert.deepEqual(sensitiveChanges(a, valid({ sinks: [a.sinks[0]] })), ["sinks[1].botToken"]);
  assert.deepEqual(sensitiveChanges(valid({ sinks: [] }), a), ["sinks[0].url", "sinks[1].botToken"]);
  assert.deepEqual(sensitiveChanges(a, { ...a, tracker: { ...a.tracker, userGid: "1", assigneeFilter: ["x"] } }), [
    "tracker.userGid",
    "tracker.assigneeFilter",
  ]);
  assert.deepEqual(sensitiveChanges(a, { ...a, tracker: { ...a.tracker, pipeline: [{ id: "x" }] } }), []);
  // Old text that didn't parse → every sensitive path present in the new config.
  assert.deepEqual(sensitiveChanges(undefined, a), ["name", "fullAuto", "tracker.token", "sinks[0].url", "sinks[1].botToken"]);
  // Never throws on odd shapes.
  assert.deepEqual(sensitiveChanges(null, 7), []);
  assert.deepEqual(sensitiveChanges({ sinks: "x" }, { sinks: {} }), []);
});

test("GET /api/config: {path, text, hash, errors, literalSecrets}", async () => {
  const res = await get("p");
  assert.equal(res.status, 200);
  assert.equal(res.headers["cache-control"], "no-store");
  const text = fs.readFileSync(P.file, "utf8");
  assert.deepEqual(JSON.parse(res.body), { path: P.file, text, hash: sha(text), errors: [], literalSecrets: [] });

  const bad = JSON.parse((await get("bad")).body);
  assert.ok(bad.errors.length > 0);
  assert.ok(bad.errors.some((/** @type {string} */ e) => e.includes("tracker.pipeline")), bad.errors.join("\n"));
  assert.deepEqual(bad.literalSecrets, ["tracker.token"]);

  const un = JSON.parse((await get("unparse")).body);
  assert.equal(un.text, '{ "name": "u", ');
  assert.equal(un.errors.length, 1);
  assert.match(un.errors[0], /^invalid JSON: /);
  assert.deepEqual(un.literalSecrets, []);
});

test("GET /api/config: 401 without the cookie; 404 for every unresolvable target", async () => {
  assert.equal((await get("p", { cookie: null })).status, 401);
  assert.equal((await get("p", { cookie: "ah_ui=wrong" })).status, 401);
  for (const name of ["nope", "", "..", "nocfg", "linked", "viadir", "isdir", "missing", "huge"]) {
    assert.equal((await get(name)).status, 404, name);
    assert.equal(readConfigFile(registry, name), null, name);
  }
});

test("PUT guards, in order: Host 403 → cookie 401 → Origin 403 → X-AH-UI 403 → Content-Type 415", async () => {
  const before = footprint(P);
  const body = save(P, json(valid({ fullAuto: true })));
  assert.equal((await put(body, { host: "evil.com" })).status, 403);
  assert.equal((await put(body, { cookie: null })).status, 401);
  assert.equal((await put(body, { cookie: "ah_ui=wrong", origin: null })).status, 401);
  for (const origin of [null, "http://evil.com", `http://localhost:${port}`, `https://127.0.0.1:${port}`, "null"]) {
    assert.equal((await put(body, { origin })).status, 403, String(origin));
  }
  assert.equal((await put(body, { "x-ah-ui": null })).status, 403);
  assert.equal((await put(body, { "x-ah-ui": "0" })).status, 403);
  for (const ct of [null, "text/plain", "multipart/form-data", "application/jsonx"]) {
    assert.equal((await put(body, { "content-type": ct })).status, 415, String(ct));
  }
  assert.deepEqual(footprint(P), before);
});

test("PUT body: > 256 KB → 413; bad JSON / bad fields → 400; unknown or unresolvable profile → 404", async () => {
  const before = footprint(P);
  assert.equal((await put("x".repeat(UI_MAX_BYTES + 1))).status, 413);
  assert.equal((await put(save(P, "x".repeat(UI_MAX_BYTES)))).status, 413); // JSON overhead tips it over
  for (const body of ["", "{", "null", "[]", '"str"', save(P, "x", { text: 1 }), save(P, "x", { baseHash: null }), save(P, "x", { profile: 7 })]) {
    assert.equal((await put(body)).status, 400, body.slice(0, 60));
  }
  assert.equal((await put(JSON.stringify({ profile: "p", text: "{}" }))).status, 400);
  // A `path` in the body is ignored — the target is always heartbeat.configPath.
  for (const profile of ["nope", "..", "nocfg", "linked", "viadir", "isdir", "missing", "huge"]) {
    const res = await put(JSON.stringify({ profile, baseHash: sha("x"), text: json(valid()), path: P.file }));
    assert.equal(res.status, 404, profile);
  }
  assert.deepEqual(footprint(P), before);
  assert.equal(fs.readFileSync(path.join(root, "realdir", "agenthook.config.json"), "utf8"), json(valid()));
  // Text over the cap in UTF-8 bytes (not chars) → 413 from the writer itself.
  assert.deepEqual(writeConfigFile(registry, "p", sha(fs.readFileSync(P.file)), "é".repeat(UI_MAX_BYTES / 2 + 1)), { status: 413 });
});

test("PUT stale baseHash → 409 {text, hash} of the current file, nothing written", async () => {
  const before = footprint(P);
  const res = await put(JSON.stringify({ profile: "p", baseHash: sha("stale"), text: json(valid({ fullAuto: true })) }));
  assert.equal(res.status, 409);
  assert.match(String(res.headers["content-type"]), /^application\/json/);
  assert.deepEqual(JSON.parse(res.body), { text: before.text, hash: sha(before.text) });
  assert.deepEqual(footprint(P), before);
});

test("PUT invalid text → 422 {errors}; file, backup dir and audit untouched", async () => {
  const before = footprint(P);
  const unparse = await put(save(P, '{"name": '));
  assert.equal(unparse.status, 422);
  const e1 = JSON.parse(unparse.body);
  assert.deepEqual(Object.keys(e1), ["errors"]);
  assert.equal(e1.errors.length, 1);
  assert.match(e1.errors[0], /^invalid JSON: /);

  const invalid = await put(save(P, json({ name: "p", repoPath: "/r", tracker: { type: "github" } })));
  assert.equal(invalid.status, 422);
  const e2 = JSON.parse(invalid.body).errors;
  assert.ok(e2.some((/** @type {string} */ e) => e.includes("tracker.pipeline")), e2.join("\n"));
  assert.equal((await put(save(P, "null"))).status, 422);
  assert.deepEqual(footprint(P), before);
});

test("PUT renamed name with no stateId → 422 (would fork the state dir); nothing written", async () => {
  const before = footprint(P);
  const res = await put(save(P, json(valid({ name: "renamed" }))));
  assert.equal(res.status, 422);
  const errs = JSON.parse(res.body).errors;
  assert.equal(errs.length, 1);
  assert.match(errs[0], /state key \("p" → "renamed"\)/);
  assert.deepEqual(footprint(P), before);
});

test('PUT stateId that differs from the profile\'s state key → 422, even with "name" unchanged', async () => {
  const before = footprint(P);
  const res = await put(save(P, json(valid({ stateId: "q" }))));
  assert.equal(res.status, 422);
  assert.match(JSON.parse(res.body).errors[0], /state key \("p" → "q"\)/);
  assert.deepEqual(footprint(P), before);
});

test("PUT renamed name with a matching stateId → 200: rename only the label, state key stays put", async () => {
  const res = await put(save(P, json(valid({ name: "renamed", stateId: "p" }))));
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(fs.readFileSync(P.file, "utf8")).name, "renamed");
  // Restore so later tests' baseline (`valid()`, name "p") still matches the on-disk file.
  const undo = await put(save(P, json(valid())));
  assert.equal(undo.status, 200);
});

test("PUT new name colliding with another profile's label or state key → 422; nothing written", async () => {
  const before = footprint(P);
  const res = await put(save(P, json(valid({ name: "live", stateId: "p" }))));
  assert.equal(res.status, 422);
  assert.match(JSON.parse(res.body).errors[0], /name "live" is already used by profile "live"/);
  assert.deepEqual(footprint(P), before);
});

test("PUT unchanged name saves even though its label already collides with another profile's", async () => {
  // A throwaway profile whose label duplicates P's current name "p" — a pre-existing collision
  // the save of P must ignore because P's own name isn't changing.
  const dup = profile("dup-collide", json(valid({ name: "dup-collide" })));
  fs.writeFileSync(path.join(dup.dir, "heartbeat.json"), JSON.stringify({ name: "p", configPath: dup.file }));
  try {
    const res = await put(save(P, json(valid({ fullAuto: true }))));
    assert.equal(res.status, 200);
    const undo = await put(save(P, json(valid())));
    assert.equal(undo.status, 200);
  } finally {
    fs.rmSync(dup.dir, { recursive: true, force: true });
  }
});

test("PUT save: 200 {hash, restartNeeded}, atomic replace keeps mode, config-bak/ backup, audit names sensitive changes", async () => {
  const AUDIT = path.join(P.dir, "ui-audit.jsonl");
  fs.rmSync(AUDIT, { force: true }); // isolate from the earlier rename tests' own audit lines on P
  const v1 = fs.readFileSync(P.file, "utf8");
  fs.chmodSync(P.file, 0o640);
  const beside = fs.readdirSync(path.dirname(P.file)).sort();

  const flip = json(valid({ fullAuto: true }));
  const res = await put(save(P, flip));
  assert.equal(res.status, 200);
  assert.equal(res.headers["cache-control"], "no-store");
  assert.deepEqual(JSON.parse(res.body), { hash: sha(flip), restartNeeded: true });
  assert.equal(fs.readFileSync(P.file, "utf8"), flip);
  assert.equal(mode(P.file), 0o640);
  const bak = backupPathFor(P.dir, P.file, "config-bak");
  assert.equal(path.dirname(bak), path.join(P.dir, "config-bak"));
  assert.equal(fs.readFileSync(bak, "utf8"), v1);
  assert.equal(mode(bak), 0o600);
  assert.equal(mode(path.dirname(bak)), 0o700);
  assert.equal(fs.existsSync(path.join(P.dir, "instructions-bak")), false);
  assert.deepEqual(fs.readdirSync(path.dirname(P.file)).sort(), beside, "nothing created beside the config");

  const tok = valid({ fullAuto: true });
  tok.sinks[1].botToken = "${OTHER_TG}";
  assert.equal((await put(save(P, json(tok)))).status, 200);
  // Formatting-only change: no sensitive value differs.
  assert.equal((await put(save(P, JSON.stringify(tok)))).status, 200);
  assert.deepEqual(fs.readdirSync(path.dirname(P.file)).sort(), beside);
  assert.equal(fs.readFileSync(bak, "utf8"), json(tok), "one generation: the previous content");

  const lines = fs.readFileSync(AUDIT, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 3);
  assert.deepEqual(Object.keys(lines[0]).sort(), ["bytes", "newHash", "oldHash", "path", "sensitive", "ts"]);
  assert.deepEqual([lines[0].path, lines[0].oldHash, lines[0].newHash, lines[0].bytes], [P.file, sha(v1), sha(flip), Buffer.byteLength(flip)]);
  assert.ok(!Number.isNaN(Date.parse(lines[0].ts)));
  assert.deepEqual(lines.map((l) => l.sensitive), [["fullAuto"], ["sinks[1].botToken"], []]);
  assert.equal(mode(AUDIT), 0o600);
});

test("PUT over an unparseable config → audit names every sensitive path in the new one", async () => {
  const text = json(valid({ name: "unparse" }));
  assert.equal((await put(save(UNPARSE, text))).status, 200);
  const [line] = fs.readFileSync(path.join(UNPARSE.dir, "ui-audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(line.sensitive, ["name", "fullAuto", "tracker.token", "sinks[0].url", "sinks[1].botToken"]);
});

test("PUT: a symlinked config-bak backup is never followed → 500, config unchanged, nothing left beside it", async () => {
  const before = footprint(BAKLINK);
  assert.equal((await put(save(BAKLINK, json(valid({ name: "baklink", fullAuto: true }))))).status, 500);
  assert.deepEqual(footprint(BAKLINK), before);
  assert.equal(fs.readFileSync(path.join(root, "bak-target"), "utf8"), "untouched\n");
});

test("two concurrent PUTs with the same baseHash → exactly one 200, one 409", async () => {
  const one = json(valid({ name: "race", trigger: "one" }));
  const two = json(valid({ name: "race", trigger: "two" }));
  const [a, b] = await Promise.all([put(save(RACE, one)), put(save(RACE, two))]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  const won = a.status === 200 ? one : two;
  assert.equal(fs.readFileSync(RACE.file, "utf8"), won);
  assert.deepEqual(JSON.parse((a.status === 409 ? a : b).body), { text: won, hash: sha(won) });
});

test("other methods on /api/config: 405 Allow: GET, PUT", async () => {
  for (const method of ["POST", "DELETE", "PATCH"]) {
    const res = await request(method, "/api/config", "{}");
    assert.equal(res.status, 405, method);
    assert.equal(res.headers.allow, "GET, PUT");
  }
});

test("/api/stream: a UI save → one `config` source:ui event, no disk echo; an external edit → source:disk", async () => {
  /** @type {any} */
  const s = await new Promise((resolve, reject) => {
    const r = http.request(
      { host: "127.0.0.1", port, path: "/api/stream", headers: { host: `127.0.0.1:${port}`, cookie: `ah_ui=${TOKEN}` } },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (text += c));
        resolve({ text: () => text, abort: () => r.destroy() });
      },
    );
    r.on("error", (e) => (e.message === "socket hang up" ? undefined : reject(e)));
    r.end();
  });
  /** @returns {any[]} */
  const cfg = () =>
    [...s.text().matchAll(/event: config\ndata: (.*)\n\n/g)].map((m) => JSON.parse(m[1])).filter((e) => e.profile === "live");
  try {
    await sleep(100); // let the watcher seed + arm
    const viaUi = json(valid({ name: "live", fullAuto: true }));
    assert.equal((await put(save(LIVE, viaUi))).status, 200);
    await sleep(300); // several debounce windows for a would-be echo
    assert.deepEqual(cfg(), [{ type: "config", profile: "live", hash: sha(viaUi), source: "ui" }]);

    const viaEditor = json(valid({ name: "live" }));
    fs.writeFileSync(LIVE.file, viaEditor);
    for (const end = Date.now() + 3000; cfg().length < 2 && Date.now() < end; ) await sleep(10);
    assert.deepEqual(cfg()[1], { type: "config", profile: "live", hash: sha(viaEditor), source: "disk" });
    assert.equal(s.text().includes("event: instructions"), false);
  } finally {
    s.abort();
  }
});
