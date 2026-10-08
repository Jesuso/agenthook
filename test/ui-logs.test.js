// `ah ui` run-log viewer — run listing, run-name validation, the byte-offset tail framing,
// and the two routes behind the cookie. Temp registry; ephemeral 127.0.0.1 port.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { LOG_TAIL_BYTES, createLogTail, listRuns, readAppended, resolveRunLog } from "../src/ui/logs.js";
import { createUiServer } from "../src/ui/server.js";

const TOKEN = "t0k3n-abcdefghijklmnopqrstuvwxyz0123456789";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ah-ui-logs-"));
const registry = path.join(root, "registry");
const logs = path.join(registry, "p", "logs");
fs.mkdirSync(logs, { recursive: true });
fs.mkdirSync(path.join(root, "dist"));
fs.writeFileSync(path.join(root, "outside.log"), "secret-outside\n");

const RUN = "2026-10-08T10-00-00-000Z-step-code-7.log";
fs.writeFileSync(path.join(logs, RUN), "hello\n");
fs.writeFileSync(path.join(logs, "ngrok.log"), "ngrok\n");
const LINK = "2026-10-08T10-00-00-001Z-step-code-7.log";
fs.symlinkSync(path.join(root, "outside.log"), path.join(logs, LINK));

/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Collect frames until `until(frames)` holds (or time out). @param {string} file */
function tail(file) {
  /** @type {import('../src/ui/contract.js').LogFrame[]} */
  const frames = [];
  /** @type {(() => void)|null} */
  let wake = null;
  const t = createLogTail(file, (f) => {
    frames.push(f);
    wake?.();
  });
  return {
    frames,
    close: t.close,
    /** @param {(f: typeof frames) => boolean} until */
    async wait(until, ms = 2000) {
      const end = Date.now() + ms;
      while (!until(frames)) {
        if (Date.now() > end) throw new Error(`timeout; frames: ${JSON.stringify(frames)}`);
        await new Promise((r) => {
          wake = () => r(undefined);
          setTimeout(r, 50);
        });
      }
    },
  };
}

test("resolveRunLog: only a listed run-log basename of a known profile, realpath inside logs/", () => {
  assert.equal(resolveRunLog(registry, "p", RUN), fs.realpathSync(path.join(logs, RUN)));
  for (const run of [
    "../x.log",
    "..%2Fx.log",
    "a/b.log",
    "a\\b.log",
    path.join(logs, RUN),
    "/etc/passwd",
    "ngrok.log",
    ".",
    "..",
    "",
    "2026-10-08T10-00-00-002Z-step-code-7.log", // well-formed, not present
    `${RUN}\0`,
    LINK, // symlink out of logs/
  ]) {
    assert.equal(resolveRunLog(registry, "p", run), null, run);
  }
  for (const profile of ["", "..", ".", "nope", "p/../p", "../registry/p"]) {
    assert.equal(resolveRunLog(registry, profile, RUN), null, profile);
  }
});

test("listRuns: step with '-', safeRef mapping, repeated step, other refs + non-run files excluded", () => {
  const reg = fs.mkdtempSync(path.join(os.tmpdir(), "ah-ui-runs-"));
  const dir = path.join(reg, "q", "logs");
  fs.mkdirSync(dir, { recursive: true });
  const ref = "PROJ/12"; // safeRef → PROJ_12
  const names = [
    "2026-10-08T10-00-00-000Z-step-code-PROJ_12.log",
    "2026-10-08T10-05-00-000Z-step-code-review-PROJ_12.log",
    "2026-10-08T10-10-00-000Z-step-code-PROJ_12.log",
    "2026-10-08T10-20-00-000Z-step-code-review-PROJ_12.log",
    "2026-10-08T10-00-00-000Z-step-code-X-PROJ_12.log", // ref "X-PROJ_12", step "code"
    "2026-10-08T10-00-00-000Z-step-code-99.log",
    "ngrok.log",
    "PROJ_12.log",
  ];
  for (const n of names) fs.writeFileSync(path.join(dir, n), "x".repeat(n.length));
  fs.writeFileSync(path.join(reg, "q", "running.json"), JSON.stringify({ [ref]: { stepId: "code-review" } }));
  const events = [
    { ts: "2026-10-08T10:00:00.010Z", event: "run_start", ref, step: "code" },
    { ts: "2026-10-08T10:04:00.000Z", event: "run_end", ref, step: "code", outcome: "advance", costUsd: 1.5 },
    { ts: "2026-10-08T10:06:00.000Z", event: "run_end", ref, step: "code-review", outcome: "changes", costUsd: 0.25 },
    { ts: "2026-10-08T10:12:00.000Z", event: "run_end", ref: "99", step: "code", outcome: "fail" },
    { ts: "2026-10-08T10:15:00.000Z", event: "run_end", ref, step: "code", outcome: "advance", costUsd: 2 },
  ];
  const runs = listRuns(reg, "q", ref, events);
  assert.deepEqual(
    runs.map((r) => [r.run, r.step, r.startedAt, r.outcome, r.costUsd, r.running]),
    [
      [names[3], "code-review", "2026-10-08T10:20:00.000Z", null, null, true],
      [names[2], "code", "2026-10-08T10:10:00.000Z", "advance", 2, false],
      [names[1], "code-review", "2026-10-08T10:05:00.000Z", "changes", 0.25, false],
      [names[0], "code", "2026-10-08T10:00:00.000Z", "advance", 1.5, false],
    ],
  );
  assert.equal(runs[0].bytes, names[3].length);
  assert.deepEqual(listRuns(reg, "nope", ref, events), []);
  assert.deepEqual(listRuns(reg, "q", "missing", events), []);
});

test("listRuns / resolveRunLog: a .prompt.md sidecar beside a run log is ignored", () => {
  const reg = fs.mkdtempSync(path.join(os.tmpdir(), "ah-ui-prompt-"));
  const dir = path.join(reg, "r", "logs");
  fs.mkdirSync(dir, { recursive: true });
  const ref = "7";
  const run = "2026-10-08T10-00-00-000Z-step-code-7.log";
  const sidecar = "2026-10-08T10-00-00-000Z-step-code-7.prompt.md";
  fs.writeFileSync(path.join(dir, run), "hello\n");
  fs.writeFileSync(path.join(dir, sidecar), "the prompt\n");
  const runs = listRuns(reg, "r", ref, []);
  assert.deepEqual(runs.map((r) => r.run), [run]);
  assert.equal(resolveRunLog(reg, "r", sidecar), null);
});

test("readAppended: appended bytes advance the offset; shrink / replace → reset", () => {
  const f = path.join(root, "ra.log");
  fs.writeFileSync(f, "abc");
  const st = { offset: 0, ino: 0 };
  assert.equal(readAppended(f, st).chunk.toString(), "abc");
  fs.appendFileSync(f, "de");
  assert.deepEqual(readAppended(f, st), { chunk: Buffer.from("de"), reset: false });
  assert.equal(readAppended(f, st).chunk.length, 0);
  fs.writeFileSync(f, "x");
  assert.equal(readAppended(f, st).reset, true);
  assert.equal(st.offset, 0);
  assert.equal(readAppended(f, st).chunk.toString(), "x");
  fs.writeFileSync(path.join(root, "rb.log"), "yy");
  fs.renameSync(path.join(root, "rb.log"), f);
  assert.equal(readAppended(f, st).reset, true);
  assert.deepEqual(readAppended(path.join(root, "missing.log"), { offset: 0, ino: 0 }), { chunk: Buffer.alloc(0), reset: false });
});

test("tail: init holds ≤ 64 KB from a line boundary; appends arrive exactly; split UTF-8 stays whole", async () => {
  const f = path.join(logs, "2026-10-08T11-00-00-000Z-step-code-8.log");
  const line = "0123456789abcdef".repeat(4) + "\n"; // 65 bytes
  fs.writeFileSync(f, line.repeat(2000)); // 130 000 bytes
  const t = tail(f);
  try {
    const init = /** @type {any} */ (t.frames[0]);
    assert.equal(init.type, "init");
    assert.equal(init.truncated, true);
    assert.equal(init.size, 130_000);
    assert.ok(Buffer.byteLength(init.text) <= LOG_TAIL_BYTES);
    assert.ok(init.text.startsWith(line), "starts on a line boundary");
    assert.equal(init.text.length % line.length, 0);
    await sleep(50); // let fs.watch arm

    fs.appendFileSync(f, "new line\n");
    await t.wait((fr) => fr.some((x) => x.type === "append"));
    assert.deepEqual(t.frames.slice(1), [{ type: "append", text: "new line\n" }]);

    const euro = Buffer.from("€", "utf8"); // 3 bytes
    fs.appendFileSync(f, Buffer.concat([Buffer.from("a"), euro.subarray(0, 1)]));
    await sleep(150);
    fs.appendFileSync(f, Buffer.concat([euro.subarray(1), Buffer.from("b\n")]));
    await t.wait((fr) => fr.map((x) => (x.type === "append" ? x.text : "")).join("").endsWith("b\n"));
    const text = t.frames.map((x) => (x.type === "append" ? x.text : "")).join("");
    assert.equal(text, "new line\na€b\n");
    assert.ok(!text.includes("�"));
  } finally {
    t.close();
  }
});

test("tail: truncation → reset then init; close stops frames", async () => {
  const f = path.join(logs, "2026-10-08T12-00-00-000Z-step-code-9.log");
  fs.writeFileSync(f, "one\ntwo\n");
  const t = tail(f);
  assert.deepEqual(t.frames[0], { type: "init", text: "one\ntwo\n", truncated: false, size: 8 });
  await sleep(50);
  fs.truncateSync(f, 0);
  fs.appendFileSync(f, "x\n");
  await t.wait((fr) => fr.some((x) => x.type === "reset") && fr.at(-1)?.type === "init");
  const i = t.frames.findIndex((x) => x.type === "reset");
  assert.deepEqual(t.frames[i + 1], { type: "init", text: "x\n", truncated: false, size: 2 });
  t.close();
  const n = t.frames.length;
  fs.appendFileSync(f, "after close\n");
  await sleep(200);
  assert.equal(t.frames.length, n);
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

test("/api/runs + /api/log/stream: cookie, Host guard, GET-only", async () => {
  for (const p of ["/api/runs?profile=p&ref=7", `/api/log/stream?profile=p&run=${RUN}`]) {
    assert.equal((await req(p, { cookie: null })).status, 401, p);
    assert.equal((await req(p, { cookie: "ah_ui=wrong" })).status, 401, p);
    assert.equal((await req(p, { host: "evil.com" })).status, 403, p);
    assert.equal((await req(p, { method: "POST" })).status, 405, p);
  }
});

test("/api/runs: 200 { runs }; unknown profile → 404; missing ref → 400", async () => {
  const res = await req("/api/runs?profile=p&ref=7");
  assert.equal(res.status, 200);
  assert.match(String(res.headers["content-type"]), /^application\/json/);
  const { runs } = JSON.parse(res.body);
  assert.deepEqual(
    runs.map((/** @type {any} */ r) => r.run),
    [RUN], // the symlink is not a run
  );
  assert.equal((await req("/api/runs?profile=nope&ref=7")).status, 404);
  assert.equal((await req("/api/runs?profile=..&ref=7")).status, 404);
  assert.equal((await req("/api/runs?profile=p")).status, 400);
  assert.equal((await req("/api/runs?profile=p&ref=")).status, 400);
});

test("/api/log/stream: bad profile/run → 404 before any SSE header", async () => {
  const bad = [
    "profile=p&run=..%2Fx.log",
    "profile=p&run=..%252Fx.log",
    "profile=p&run=a%2Fb.log",
    `profile=p&run=${encodeURIComponent(path.join(root, "outside.log"))}`,
    "profile=p&run=ngrok.log",
    "profile=p&run=2026-10-08T10-00-00-002Z-step-code-7.log",
    `profile=p&run=${LINK}`,
    `profile=nope&run=${RUN}`,
    `profile=..&run=${RUN}`,
    `profile=p`,
  ];
  for (const q of bad) {
    const res = await req(`/api/log/stream?${q}`);
    assert.equal(res.status, 404, q);
    assert.match(String(res.headers["content-type"]), /^text\/plain/, q);
    assert.ok(!res.body.includes("secret-outside"), q);
  }
});

test("/api/log/stream: valid run → SSE init, then append", async () => {
  /** @type {any} */
  const s = await new Promise((resolve, reject) => {
    const r = http.request(
      { host: "127.0.0.1", port, path: `/api/log/stream?profile=p&run=${RUN}`, headers: { host: `127.0.0.1:${port}`, cookie: COOKIE } },
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
          status: res.statusCode,
          headers: res.headers,
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
    assert.equal(s.status, 200);
    assert.equal(s.headers["content-type"], "text/event-stream; charset=utf-8");
    const first = await s.until((/** @type {string} */ t) => t.includes("\n\n"));
    assert.equal(first, `event: init\ndata: ${JSON.stringify({ text: "hello\n", truncated: false, size: 6 })}\n\n`);
    await sleep(50);
    fs.appendFileSync(path.join(logs, RUN), "world\n");
    const all = await s.until((/** @type {string} */ t) => t.includes("event: append"));
    assert.ok(all.endsWith(`event: append\ndata: ${JSON.stringify({ text: "world\n" })}\n\n`), all);
  } finally {
    s.abort();
  }
});
