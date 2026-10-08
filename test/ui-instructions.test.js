// `ah ui` instructions editor, read side — the heartbeat allowlist listing, exact-path file
// resolution, the last-prompt preview split, and the three routes behind the cookie.
// Temp registry + temp instruction files; ephemeral 127.0.0.1 port.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import {
  INSTRUCTIONS_MAX_BYTES,
  listInstructions,
  promptPreview,
  readInstructionFile,
  resolveInstructionFile,
} from "../src/ui/instructions.js";
import { createUiServer } from "../src/ui/server.js";

const TOKEN = "t0k3n-abcdefghijklmnopqrstuvwxyz0123456789";

// realpath: macOS' tmpdir is a symlink, and the allowlist is compared exactly.
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ah-ui-instr-")));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const registry = path.join(root, "registry");
const dir = path.join(registry, "p");
const logs = path.join(dir, "logs");
const repo = path.join(root, "repo");
fs.mkdirSync(logs, { recursive: true });
fs.mkdirSync(repo);
fs.mkdirSync(path.join(root, "dist"));

const sha = (/** @type {string|Buffer} */ s) => crypto.createHash("sha256").update(s).digest("hex");

const CODE = path.join(repo, "CODE.md");
const DEFAULT = path.join(repo, "INSTRUCTIONS.md");
const REPO = path.join(repo, "REPO.md");
const MISSING = path.join(repo, "MISSING.md");
const LINK = path.join(repo, "LINK.md");
const TXT = path.join(repo, "NOTES.txt");
const BIG = path.join(repo, "BIG.md");
fs.writeFileSync(CODE, "# code\n");
fs.writeFileSync(DEFAULT, "# default instructions\n");
fs.writeFileSync(REPO, "# repo\n");
fs.writeFileSync(path.join(root, "secret.md"), "secret-outside\n");
fs.symlinkSync(path.join(root, "secret.md"), LINK);
fs.writeFileSync(TXT, "not markdown\n");
fs.writeFileSync(BIG, "x".repeat(INSTRUCTIONS_MAX_BYTES + 1));

fs.writeFileSync(
  path.join(dir, "heartbeat.json"),
  JSON.stringify({
    name: "p",
    configPath: path.join(repo, "agenthook.config.json"),
    instructions: [
      { path: CODE, scope: "step", ids: ["code"] },
      { path: DEFAULT, scope: "default", ids: ["triage", "code-review"] },
      { path: REPO, scope: "repo", ids: ["main"] },
      { path: MISSING, scope: "step", ids: ["docs"] },
      { path: LINK, scope: "step", ids: ["link"] },
      { path: TXT, scope: "step", ids: ["txt"] },
      { path: BIG, scope: "step", ids: ["big"] },
      { path: "relative.md", scope: "step", ids: ["rel"] }, // not absolute → dropped
    ],
  }),
);
fs.writeFileSync(
  path.join(dir, "running.json"),
  JSON.stringify({
    1: { stepId: "code" },
    2: { stepId: "code-review" },
    3: { stepId: "triage" },
    4: { stepId: "other" },
  }),
);
// A step only the events tail knows about.
fs.writeFileSync(path.join(dir, "events.jsonl"), JSON.stringify({ ts: "2026-10-08T00:00:00Z", event: "run_end", ref: "9", step: "ship" }) + "\n");
// A known profile with no heartbeat at all.
fs.mkdirSync(path.join(registry, "bare"));

/** @param {string} name @param {string} body */
const prompt = (name, body) => fs.writeFileSync(path.join(logs, name), body);
const P_OLD = "2026-10-08T10-00-00-000Z-step-code-7.prompt.md";
const P_NEW = "2026-10-08T11-00-00-000Z-step-code-8.prompt.md";
const P_REVIEW = "2026-10-08T12-00-00-000Z-step-code-review-8.prompt.md"; // newer, but a different step
const P_TRIAGE = "2026-10-08T10-00-00-000Z-step-triage-8.prompt.md";
prompt(P_OLD, "old standing\n\n=== TICKET ===\n\nold ticket");
prompt(P_NEW, "standing A\n\n=== TICKET ===\n\nticket B\n\n=== TICKET ===\n\nstill ticket");
prompt(P_REVIEW, "review standing\n\n=== TICKET ===\n\nreview ticket");
prompt(P_TRIAGE, "no standing part, just the ticket");
fs.writeFileSync(path.join(logs, "2026-10-08T11-00-00-000Z-step-code-8.log"), "log\n");
// Newest "ship" prompt is a symlink → skipped, the older regular file wins.
prompt("2026-10-08T10-00-00-000Z-step-ship-9.prompt.md", "ship standing\n\n=== TICKET ===\n\nship ticket");
fs.symlinkSync(path.join(root, "secret.md"), path.join(logs, "2026-10-08T13-00-00-000Z-step-ship-9.prompt.md"));

test("listInstructions: exactly the heartbeat allowlist, sha256/bytes/mtime/exists, agentsRunning by scope", () => {
  const v = /** @type {import('../src/ui/contract.js').InstructionsView} */ (listInstructions(registry, "p"));
  assert.equal(v.configPath, path.join(repo, "agenthook.config.json"));
  assert.deepEqual(
    v.files.map((f) => f.path),
    [CODE, DEFAULT, REPO, MISSING, LINK, TXT, BIG],
  );
  const by = Object.fromEntries(v.files.map((f) => [f.path, f]));
  assert.deepEqual(by[CODE], {
    path: CODE,
    scope: "step",
    ids: ["code"],
    hash: sha("# code\n"),
    bytes: 7,
    mtime: fs.statSync(CODE).mtime.toISOString(),
    exists: true,
    agentsRunning: 1,
  });
  assert.equal(by[DEFAULT].agentsRunning, 2); // triage + code-review
  assert.equal(by[REPO].agentsRunning, 4); // repo scope: every running agent
  assert.deepEqual(
    [by[MISSING].exists, by[MISSING].hash, by[MISSING].bytes, by[MISSING].mtime, by[MISSING].agentsRunning],
    [false, null, 0, null, 0],
  );
  assert.equal(by[BIG].bytes, INSTRUCTIONS_MAX_BYTES + 1);
});

test("listInstructions: no heartbeat → files []; unknown profile → null", () => {
  assert.deepEqual(listInstructions(registry, "bare"), { configPath: null, files: [] });
  for (const profile of ["", "nope", "..", "p/../p"]) assert.equal(listInstructions(registry, profile), null, profile);
});

test("resolveInstructionFile / readInstructionFile: exact allowlisted regular .md ≤ 256 KB only", () => {
  assert.equal(resolveInstructionFile(registry, "p", CODE), CODE);
  assert.deepEqual(readInstructionFile(registry, "p", CODE), { path: CODE, content: "# code\n", hash: sha("# code\n") });
  for (const p of [
    path.join(repo, "OTHER.md"), // not allowlisted
    path.join(root, "secret.md"),
    `${repo}/../repo/CODE.md`, // traversal variant of an allowlisted path
    `${repo}/./CODE.md`,
    `${CODE}/`,
    `${repo}//CODE.md`,
    "repo/CODE.md",
    LINK, // symlink at an allowlisted path
    TXT, // allowlisted, not .md
    BIG, // > 256 KB
    MISSING,
    "",
  ]) {
    assert.equal(resolveInstructionFile(registry, "p", p), null, p);
    assert.equal(readInstructionFile(registry, "p", p), null, p);
  }
  assert.equal(resolveInstructionFile(registry, "nope", CODE), null);
  assert.equal(resolveInstructionFile(registry, "bare", CODE), null);
});

test("promptPreview: newest run of the step, split at the first marker; code-review is not code", () => {
  assert.deepEqual(promptPreview(registry, "p", "code"), {
    run: "2026-10-08T11-00-00-000Z-step-code-8.log",
    standing: "standing A",
    ticket: "ticket B\n\n=== TICKET ===\n\nstill ticket",
  });
  assert.deepEqual(promptPreview(registry, "p", "code-review"), {
    run: "2026-10-08T12-00-00-000Z-step-code-review-8.log",
    standing: "review standing",
    ticket: "review ticket",
  });
});

test("promptPreview: no marker → standing ''; symlink skipped; no prompt → { run: null }; unknown → null", () => {
  assert.deepEqual(promptPreview(registry, "p", "triage"), {
    run: "2026-10-08T10-00-00-000Z-step-triage-8.log",
    standing: "",
    ticket: "no standing part, just the ticket",
  });
  // "ship" is known only from the events tail; its newer prompt is a symlink.
  assert.deepEqual(promptPreview(registry, "p", "ship"), {
    run: "2026-10-08T10-00-00-000Z-step-ship-9.log",
    standing: "ship standing",
    ticket: "ship ticket",
  });
  assert.deepEqual(promptPreview(registry, "p", "docs"), { run: null });
  for (const step of ["", "nope", "main", "../code", "cod", "code-"]) assert.equal(promptPreview(registry, "p", step), null, step);
  assert.equal(promptPreview(registry, "nope", "code"), null);
  assert.equal(promptPreview(registry, "bare", "code"), null);
});

// --- HTTP routes ---

const server = createUiServer({ port: 0, token: TOKEN, distDir: path.join(root, "dist"), registry });
/** @type {number} */
let port;
test.before(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", () => r(undefined)));
  const a = server.address();
  port = a && typeof a === "object" ? a.port : 0;
});
test.after(() => new Promise((r) => server.close(() => r(undefined))));

const COOKIE = `ah_ui=${TOKEN}`;

/**
 * @param {string} p @param {{ host?: string, cookie?: string|null, method?: string }} [o]
 * @returns {Promise<{ status: number, headers: http.IncomingHttpHeaders, body: string }>}
 */
function req(p, { host, cookie = COOKIE, method = "GET" } = {}) {
  /** @type {Record<string, string>} */
  const headers = { host: host ?? `127.0.0.1:${port}` };
  if (cookie) headers.cookie = cookie;
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port, path: p, method, headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode || 0, headers: res.headers, body }));
    });
    r.on("error", reject);
    r.end();
  });
}

const q = encodeURIComponent;
const ROUTES = ["/api/instructions?profile=p", `/api/instructions/file?profile=p&path=${q(CODE)}`, "/api/prompt-preview?profile=p&step=code"];

test("routes: cookie, Host guard, GET-only", async () => {
  for (const p of ROUTES) {
    assert.equal((await req(p, { cookie: null })).status, 401, p);
    assert.equal((await req(p, { cookie: "ah_ui=wrong" })).status, 401, p);
    assert.equal((await req(p, { host: "evil.com" })).status, 403, p);
    for (const method of ["POST", "PUT", "DELETE"]) assert.equal((await req(p, { method })).status, 405, p);
  }
});

test("routes: 200 no-store JSON matching the module functions", async () => {
  for (const p of ROUTES) {
    const res = await req(p);
    assert.equal(res.status, 200, p);
    assert.match(String(res.headers["content-type"]), /^application\/json/, p);
    assert.equal(res.headers["cache-control"], "no-store", p);
  }
  assert.deepEqual(JSON.parse((await req(ROUTES[0])).body), listInstructions(registry, "p"));
  assert.deepEqual(JSON.parse((await req(ROUTES[1])).body), { path: CODE, content: "# code\n", hash: sha("# code\n") });
  assert.equal(JSON.parse((await req(ROUTES[2])).body).standing, "standing A");
  assert.deepEqual(JSON.parse((await req("/api/prompt-preview?profile=p&step=docs")).body), { run: null });
});

test("routes: unknown profile / bad path / unknown step → 404, nothing leaked", async () => {
  const bad = [
    "/api/instructions?profile=nope",
    "/api/instructions?profile=..",
    "/api/instructions",
    `/api/instructions/file?profile=nope&path=${q(CODE)}`,
    `/api/instructions/file?profile=p&path=${q(`${repo}/../repo/CODE.md`)}`,
    `/api/instructions/file?profile=p&path=${q(`${CODE}/`)}`,
    `/api/instructions/file?profile=p&path=${q(LINK)}`,
    `/api/instructions/file?profile=p&path=${q(TXT)}`,
    `/api/instructions/file?profile=p&path=${q(BIG)}`,
    `/api/instructions/file?profile=p&path=${q(MISSING)}`,
    `/api/instructions/file?profile=p&path=${q(path.join(root, "secret.md"))}`,
    "/api/instructions/file?profile=p",
    "/api/prompt-preview?profile=p&step=nope",
    "/api/prompt-preview?profile=p",
    "/api/prompt-preview?profile=nope&step=code",
  ];
  for (const p of bad) {
    const res = await req(p);
    assert.equal(res.status, 404, p);
    assert.ok(!res.body.includes("secret-outside"), p);
  }
});

test("/api/stream: an external edit of an allowlisted file arrives as `event: instructions`", async () => {
  /** @type {any} */
  const s = await new Promise((resolve, reject) => {
    const r = http.request(
      { host: "127.0.0.1", port, path: "/api/stream", headers: { host: `127.0.0.1:${port}`, cookie: COOKIE } },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        /** @type {((t: string) => void)|null} */
        let wake = null;
        res.on("data", (c) => {
          text += c;
          wake?.(text);
        });
        resolve({
          /** @param {(t: string) => boolean} until */
          until: (until) =>
            new Promise((r2) => {
              if (until(text)) return r2(text);
              wake = (t) => until(t) && r2(t);
            }),
          abort: () => r.destroy(),
        });
      },
    );
    r.on("error", (e) => (e.message === "socket hang up" ? undefined : reject(e)));
    r.end();
  });
  try {
    await new Promise((r) => setTimeout(r, 100)); // let the watcher seed + arm
    fs.writeFileSync(CODE, "# code v2\n");
    const text = await s.until((/** @type {string} */ t) => t.includes("event: instructions"));
    const frame = { type: "instructions", profile: "p", path: CODE, hash: sha("# code v2\n") };
    assert.ok(text.includes(`event: instructions\ndata: ${JSON.stringify(frame)}\n\n`), text);
  } finally {
    s.abort();
  }
});
