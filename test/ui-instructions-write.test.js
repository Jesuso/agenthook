import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// `ah ui` instructions editor, write side — `PUT /api/instructions/file`: every guard's failure
// code in order, the 409 optimistic-concurrency check, the atomic write (mode, `.bak`, no temp
// left), the audit line, the one-200/one-409 race, and SSE echo suppression.
// Temp registry + temp instruction files; ephemeral 127.0.0.1 port.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { INSTRUCTIONS_MAX_BYTES, backupPathFor, writeInstructionFile } from "../src/ui/instructions.js";
import { createUiServer } from "../src/ui/server.js";

const TOKEN = "t0k3n-abcdefghijklmnopqrstuvwxyz0123456789";

// realpath: macOS' tmpdir is a symlink, and the allowlist is compared exactly.
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ah-ui-instr-w-")));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const registry = path.join(root, "registry");
const dir = path.join(registry, "p");
const repo = path.join(root, "repo");
fs.mkdirSync(dir, { recursive: true });
fs.mkdirSync(repo);
fs.mkdirSync(path.join(root, "dist"));
fs.mkdirSync(path.join(registry, "bare"));

const sha = (/** @type {string|Buffer} */ s) => crypto.createHash("sha256").update(s).digest("hex");
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
const mode = (/** @type {string} */ f) => fs.statSync(f).mode & 0o7777;

const CODE = path.join(repo, "CODE.md");
const RACE = path.join(repo, "RACE.md");
const BAKLINK = path.join(repo, "BAKLINK.md");
const LIVE = path.join(repo, "LIVE.md");
const LINK = path.join(repo, "LINK.md");
const TXT = path.join(repo, "NOTES.txt");
const SECRET = path.join(root, "secret.md");
const AUDIT = path.join(dir, "ui-audit.jsonl");
for (const f of [CODE, RACE, BAKLINK, LIVE]) fs.writeFileSync(f, `# ${path.basename(f)}\n`);
fs.writeFileSync(SECRET, "secret-outside\n");
fs.symlinkSync(SECRET, LINK);
fs.writeFileSync(TXT, "not markdown\n");
fs.writeFileSync(path.join(root, "bak-target"), "untouched\n");
fs.mkdirSync(path.dirname(backupPathFor(dir, BAKLINK)), { mode: 0o700 });
fs.symlinkSync(path.join(root, "bak-target"), backupPathFor(dir, BAKLINK));
fs.writeFileSync(
  path.join(dir, "heartbeat.json"),
  JSON.stringify({
    name: "p",
    instructions: [CODE, RACE, BAKLINK, LIVE, LINK, TXT].map((p, i) => ({ path: p, scope: "step", ids: [`s${i}`] })),
  }),
);

const server = createUiServer({ port: 0, token: TOKEN, distDir: path.join(root, "dist"), registry });
/** @type {number} */
let port;
test.before(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", () => r(undefined)));
  const a = server.address();
  port = a && typeof a === "object" ? a.port : 0;
});
test.after(() => new Promise((r) => server.close(() => r(undefined))));

/** A valid request's headers, with `o` overriding (null drops one). @param {Record<string, string|null>} [o] */
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
 * @param {string|Buffer} body @param {{ headers?: Record<string, string|null>, method?: string, p?: string }} [o]
 * @returns {Promise<{ status: number, headers: http.IncomingHttpHeaders, body: string }>}
 */
function put(body, { headers = {}, method = "PUT", p = "/api/instructions/file" } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port, path: p, method, headers: hdrs(headers), setHost: false, agent: false }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode || 0, headers: res.headers, body: text }));
    });
    r.on("error", reject);
    r.end(body);
  });
}

/** A JSON save body for `file` from its current content. @param {string} file @param {string} content @param {object} [o] */
const save = (file, content, o = {}) =>
  JSON.stringify({ profile: "p", path: file, baseHash: sha(fs.readFileSync(file)), content, ...o });

const tmpLeft = () => fs.readdirSync(repo).filter((n) => n.endsWith(".tmp"));

test("PUT guards, in order: Host 403 → cookie 401 → Origin 403 → X-AH-UI 403 → Content-Type 415", async () => {
  const body = save(CODE, "never\n");
  assert.equal((await put(body, { headers: { host: "evil.com" } })).status, 403);
  assert.equal((await put(body, { headers: { host: `127.0.0.1:${port + 1}` } })).status, 403);
  assert.equal((await put(body, { headers: { cookie: null } })).status, 401);
  assert.equal((await put(body, { headers: { cookie: "ah_ui=wrong", origin: null } })).status, 401);
  assert.equal((await put(body, { headers: { origin: null } })).status, 403);
  for (const origin of [
    "http://evil.com",
    `http://127.0.0.1:${port + 1}`,
    `http://localhost:${port}`, // Host is 127.0.0.1
    `https://127.0.0.1:${port}`,
    `http://127.0.0.1:${port}/`,
    "null",
    "",
  ]) {
    assert.equal((await put(body, { headers: { origin } })).status, 403, origin);
  }
  assert.equal((await put(body, { headers: { "x-ah-ui": null } })).status, 403);
  assert.equal((await put(body, { headers: { "x-ah-ui": "0" } })).status, 403);
  for (const ct of [null, "text/plain", "application/x-www-form-urlencoded", "multipart/form-data", "application/jsonx"]) {
    assert.equal((await put(body, { headers: { "content-type": ct } })).status, 415, String(ct));
  }
  assert.equal(fs.readFileSync(CODE, "utf8"), "# CODE.md\n");
});

test("PUT body: > 256 KB → 413; bad JSON / non-string field → 400; bad target → 404", async () => {
  assert.equal((await put("x".repeat(INSTRUCTIONS_MAX_BYTES + 1))).status, 413);
  assert.equal((await put(save(CODE, "x".repeat(INSTRUCTIONS_MAX_BYTES)))).status, 413); // JSON overhead tips it over
  for (const body of ["", "{", "null", "[]", '"str"', save(CODE, "x", { content: 1 }), save(CODE, "x", { baseHash: null })]) {
    assert.equal((await put(body)).status, 400, body.slice(0, 60));
  }
  assert.equal((await put(JSON.stringify({ profile: "p", path: CODE, content: "x" }))).status, 400);
  const base = sha("x");
  for (const [profile, file] of [
    ["p", path.join(repo, "OTHER.md")],
    ["p", `${repo}/../repo/CODE.md`],
    ["p", LINK],
    ["p", TXT],
    ["p", SECRET],
    ["nope", CODE],
    ["bare", CODE],
    ["..", CODE],
  ]) {
    const res = await put(JSON.stringify({ profile, path: file, baseHash: base, content: "pwned\n" }));
    assert.equal(res.status, 404, `${profile} ${file}`);
  }
  assert.equal(fs.readFileSync(SECRET, "utf8"), "secret-outside\n");
  assert.equal(fs.readFileSync(TXT, "utf8"), "not markdown\n");
  assert.equal(fs.readFileSync(CODE, "utf8"), "# CODE.md\n");
  // `; charset=utf-8` is fine (reaches the 404 for a non-allowlisted path).
  const ok = await put(JSON.stringify({ profile: "p", path: TXT, baseHash: base, content: "" }), {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
  assert.equal(ok.status, 404);
});

test("writeInstructionFile: content over the cap → 413 (UTF-8 bytes)", () => {
  const big = "é".repeat(INSTRUCTIONS_MAX_BYTES / 2 + 1);
  assert.deepEqual(writeInstructionFile(registry, "p", CODE, sha(fs.readFileSync(CODE)), big), { status: 413 });
});

test("PUT stale baseHash → 409 { content, hash } of the current file, nothing written", async () => {
  const res = await put(JSON.stringify({ profile: "p", path: CODE, baseHash: sha("stale"), content: "never\n" }));
  assert.equal(res.status, 409);
  assert.match(String(res.headers["content-type"]), /^application\/json/);
  assert.deepEqual(JSON.parse(res.body), { content: "# CODE.md\n", hash: sha("# CODE.md\n") });
  assert.equal(fs.existsSync(backupPathFor(dir, CODE)), false);
});

test("backupPathFor: state dir, never beside the file; same basename in two dirs never collides", () => {
  const b = backupPathFor(dir, CODE);
  assert.equal(path.dirname(b), path.join(dir, "instructions-bak"));
  assert.ok(path.basename(b).startsWith("CODE.md.") && b.endsWith(".bak"));
  assert.notEqual(backupPathFor(dir, path.join(root, "other", "CODE.md")), b);
});

test("PUT save: 200 {hash}, atomic replace keeps mode, backup = old content in state dir, audit line 0600", async () => {
  fs.chmodSync(CODE, 0o640);
  const res = await put(save(CODE, "# code v2\n"));
  assert.equal(res.status, 200);
  assert.equal(res.headers["cache-control"], "no-store");
  assert.deepEqual(JSON.parse(res.body), { hash: sha("# code v2\n") });
  assert.equal(fs.readFileSync(CODE, "utf8"), "# code v2\n");
  assert.equal(mode(CODE), 0o640);
  assert.equal(fs.readFileSync(backupPathFor(dir, CODE), "utf8"), "# CODE.md\n");
  assert.equal(mode(backupPathFor(dir, CODE)), 0o600);
  assert.equal(mode(path.dirname(backupPathFor(dir, CODE))), 0o700);
  assert.deepEqual(fs.readdirSync(repo).filter((n) => n.endsWith(".bak")), [], "nothing written beside the file");
  assert.deepEqual(tmpLeft(), []);
  const lines = fs.readFileSync(AUDIT, "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  const a = JSON.parse(lines[0]);
  assert.deepEqual(Object.keys(a).sort(), ["bytes", "newHash", "oldHash", "path", "ts"]);
  assert.deepEqual([a.path, a.oldHash, a.newHash, a.bytes], [CODE, sha("# CODE.md\n"), sha("# code v2\n"), 10]);
  assert.ok(!Number.isNaN(Date.parse(a.ts)));
  assert.equal(mode(AUDIT), 0o600);

  // Second save: one more audit line, .bak is one generation (the previous content).
  assert.equal((await put(save(CODE, "# code v3\n"))).status, 200);
  assert.equal(fs.readFileSync(backupPathFor(dir, CODE), "utf8"), "# code v2\n");
  assert.equal(fs.readFileSync(AUDIT, "utf8").trim().split("\n").length, 2);
});

test("PUT: a symlinked backup is never followed → 500, file unchanged, no temp left", async () => {
  const res = await put(save(BAKLINK, "never\n"));
  assert.equal(res.status, 500);
  assert.equal(fs.readFileSync(BAKLINK, "utf8"), "# BAKLINK.md\n");
  assert.equal(fs.readFileSync(path.join(root, "bak-target"), "utf8"), "untouched\n");
  assert.deepEqual(tmpLeft(), []);
});

test("two concurrent PUTs with the same baseHash → exactly one 200, one 409", async () => {
  const [a, b] = await Promise.all([put(save(RACE, "one\n")), put(save(RACE, "two\n"))]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  const won = a.status === 200 ? "one\n" : "two\n";
  assert.equal(fs.readFileSync(RACE, "utf8"), won);
  assert.deepEqual(JSON.parse((a.status === 409 ? a : b).body), { content: won, hash: sha(won) });
});

test("other methods: 405 with Allow (GET, PUT on the file path; GET elsewhere)", async () => {
  for (const method of ["POST", "DELETE", "PATCH"]) {
    const res = await put("{}", { method });
    assert.equal(res.status, 405, method);
    assert.equal(res.headers.allow, "GET, PUT");
  }
  for (const p of ["/api/instructions", "/api/snapshot", "/api/instructions/file/", "/"]) {
    const res = await put("{}", { p });
    assert.equal(res.status, 405, p);
    assert.equal(res.headers.allow, "GET");
  }
});

test("/api/stream: a UI save → one `source:ui` event, no disk echo; an external edit → `source:disk`", async () => {
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
  const instr = () =>
    [...s.text().matchAll(/event: instructions\ndata: (.*)\n\n/g)].map((m) => JSON.parse(m[1])).filter((e) => e.path === LIVE);
  try {
    await sleep(100); // let the watcher seed + arm
    assert.equal((await put(save(LIVE, "via ui\n"))).status, 200);
    await sleep(300); // several debounce windows for a would-be echo
    assert.deepEqual(instr(), [{ type: "instructions", profile: "p", path: LIVE, hash: sha("via ui\n"), source: "ui" }]);

    fs.writeFileSync(LIVE, "via editor\n");
    for (const end = Date.now() + 3000; instr().length < 2 && Date.now() < end; ) await sleep(10);
    assert.deepEqual(instr()[1], { type: "instructions", profile: "p", path: LIVE, hash: sha("via editor\n"), source: "disk" });
  } finally {
    s.abort();
  }
});
