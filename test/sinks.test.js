import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createSinks } from "../src/sinks.js";

const realFetch = globalThis.fetch;
const realWarn = console.warn;
let calls, warns;
beforeEach(() => {
  calls = [];
  warns = [];
  console.warn = (...a) => warns.push(a.join(" "));
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), init });
    return { ok: true, status: 200 };
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
  console.warn = realWarn;
});
const tick = () => new Promise((r) => setTimeout(r, 5));
const ev = { ts: "t", event: "blocked", ref: "7", step: "code", reason: "why?", name: "Task", url: "http://x/7" };

test("default events filter", async () => {
  const send = createSinks({ name: "p", sinks: [{ type: "slack", url: "http://s" }] });
  send({ ...ev, event: "run_end" });
  send({ ...ev, event: "failed" });
  await tick();
  assert.equal(calls.length, 1);
});

test("explicit events filter", async () => {
  const send = createSinks({ name: "p", sinks: [{ type: "webhook", url: "http://w", events: ["blocked"] }] });
  send({ ...ev, event: "failed" });
  send(ev);
  await tick();
  assert.equal(calls.length, 1);
});

test("slack body and text", async () => {
  createSinks({ name: "p", sinks: [{ type: "slack", url: "http://s" }] })(ev);
  await tick();
  assert.equal(calls[0].url, "http://s");
  assert.equal(calls[0].body.text, '[agenthook:p] blocked 7 "Task" (step code)\nwhy?\nhttp://x/7');
});

test("telegram url and body", async () => {
  createSinks({ name: "p", sinks: [{ type: "telegram", botToken: "TOK", chatId: "1" }] })(ev);
  await tick();
  assert.equal(calls[0].url, "https://api.telegram.org/botTOK/sendMessage");
  assert.equal(calls[0].body.chat_id, "1");
  assert.equal(calls[0].body.disable_web_page_preview, true);
});

test("webhook body is raw event plus profile", async () => {
  createSinks({ name: "p", sinks: [{ type: "webhook", url: "http://w" }] })(ev);
  await tick();
  assert.deepEqual(calls[0].body, { ...ev, profile: "p" });
});

test("rejected fetch and non-2xx are swallowed; token not logged", async () => {
  const cfg = { name: "p", sinks: [{ type: "telegram", botToken: "SECRET", chatId: "1" }] };
  globalThis.fetch = async () => {
    throw new Error("boom https://api.telegram.org/botSECRET/sendMessage");
  };
  createSinks(cfg)(ev);
  globalThis.fetch = async () => ({ ok: false, status: 500 });
  createSinks(cfg)(ev);
  await tick();
  assert.equal(warns.length, 2);
  assert.ok(warns.every((w) => !w.includes("SECRET")));
});

test("synchronous fetch throw does not propagate", () => {
  globalThis.fetch = () => {
    throw new Error("sync");
  };
  createSinks({ name: "p", sinks: [{ type: "slack", url: "http://s" }] })(ev);
  assert.equal(warns.length, 1);
});

test("delivery order matches emit order even when the first fetch resolves later", async () => {
  let resolveFirst;
  let n = 0;
  globalThis.fetch = (url, init) => {
    n++;
    calls.push({ url, body: JSON.parse(init.body) });
    if (n === 1) return new Promise((r) => (resolveFirst = () => r({ ok: true, status: 200 })));
    return Promise.resolve({ ok: true, status: 200 });
  };
  const send = createSinks({ name: "p", sinks: [{ type: "webhook", url: "http://w" }] });
  send({ ...ev, ref: "1" });
  send({ ...ev, ref: "2" });
  await tick();
  assert.equal(calls.length, 1); // 2nd fetch not called until 1st settles
  resolveFirst();
  await tick();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((c) => c.body.ref), ["1", "2"]);
});

test("one hung sink does not delay another sink's delivery", async () => {
  globalThis.fetch = (url) => {
    calls.push({ url });
    if (url === "http://hung") return new Promise(() => {}); // never settles
    return Promise.resolve({ ok: true, status: 200 });
  };
  const send = createSinks({
    name: "p",
    sinks: [
      { type: "webhook", url: "http://hung" },
      { type: "webhook", url: "http://fast" },
    ],
  });
  send(ev);
  await tick();
  assert.equal(calls.length, 2);
});

test("a rejected request and an HTTP 500 each warn once; next queued event still sent", async () => {
  const seq = [
    () => Promise.reject(new Error("boom")),
    () => Promise.resolve({ ok: false, status: 500 }),
    () => Promise.resolve({ ok: true, status: 200 }),
  ];
  let n = 0;
  globalThis.fetch = (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return seq[n++]();
  };
  const send = createSinks({ name: "p", sinks: [{ type: "webhook", url: "http://w" }] });
  send({ ...ev, ref: "1" });
  send({ ...ev, ref: "2" });
  send({ ...ev, ref: "3" });
  await tick();
  assert.equal(calls.length, 3);
  assert.equal(warns.length, 2);
});

test("a hung request is cut by the per-send timeout; the signal is created at send time", async () => {
  let n = 0;
  globalThis.fetch = (url, init) => {
    n++;
    calls.push({ url });
    return new Promise((resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "TimeoutError" })));
      if (n === 2) resolve({ ok: true, status: 200 });
    });
  };
  const send = createSinks({ name: "p", sinks: [{ type: "webhook", url: "http://w" }] }, { timeoutMs: 20 });
  send({ ...ev, ref: "1" });
  send({ ...ev, ref: "2" });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(calls.length, 2);
  assert.ok(warns.some((w) => w.includes("timed out")));
});

test("backlog cap drops oldest pending entries with one warn per overflow episode", async () => {
  let resolveFirst;
  globalThis.fetch = (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    if (calls.length === 1) return new Promise((r) => (resolveFirst = () => r({ ok: true, status: 200 })));
    return Promise.resolve({ ok: true, status: 200 });
  };
  const send = createSinks({ name: "p", sinks: [{ type: "webhook", url: "http://w" }] }, { maxBacklog: 2 });
  send({ ...ev, ref: "1" }); // in-flight (hung)
  send({ ...ev, ref: "2" });
  send({ ...ev, ref: "3" });
  send({ ...ev, ref: "4" }); // overflow: drops ref 2
  send({ ...ev, ref: "5" }); // overflow: drops ref 3
  await tick();
  assert.equal(calls.length, 1);
  resolveFirst();
  await tick();
  assert.deepEqual(
    calls.map((c) => c.body.ref),
    ["1", "4", "5"],
  );
  assert.equal(warns.filter((w) => w.includes("backlog full")).length, 1);
});

test("warn text never contains the URL or bot token", async () => {
  globalThis.fetch = () => Promise.reject(new Error("https://api.telegram.org/botSECRET/sendMessage"));
  createSinks({ name: "p", sinks: [{ type: "telegram", botToken: "SECRET", chatId: "1" }] })(ev);
  await tick();
  assert.ok(warns.length > 0);
  assert.ok(warns.every((w) => !w.includes("SECRET") && !w.includes("http")));
});
