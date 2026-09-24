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
