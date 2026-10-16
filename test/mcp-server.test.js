import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createMcpServer, serveStdio } from "../src/mcp/server.js";
import { createTools } from "../src/mcp/tools.js";

/** @param {any} handlers */
function harness(handlers) {
  const server = createMcpServer({ name: "t", version: "1", instructions: "hi", handlers });
  /** @type {any[]} */
  const out = [];
  const send = (msg) => server.handleLine(typeof msg === "string" ? msg : JSON.stringify(msg), (m) => out.push(m));
  return { server, out, send };
}

const echo = {
  list: () => [{ name: "echo" }],
  call: async (name, args) => {
    if (name !== "echo") throw Object.assign(new Error(`unknown tool "${name}"`), { code: "unknown_tool" });
    if (args.boom) throw new Error("kaboom");
    return { got: args };
  },
};

test("initialize negotiates a supported protocol, falls back to the newest, returns instructions", async () => {
  const { out, send } = harness(echo);
  await send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } });
  await send({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } });
  assert.equal(out[0].result.protocolVersion, "2025-03-26");
  assert.equal(out[1].result.protocolVersion, "2025-06-18");
  assert.equal(out[0].result.instructions, "hi");
  assert.deepEqual(out[0].result.capabilities, { tools: { listChanged: false } });
});

test("tools/list, tools/call ok, thrown error -> isError result, unknown tool -> -32602", async () => {
  const { out, send } = harness(echo);
  await send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  await send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "echo", arguments: { a: 1 } } });
  await send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "echo", arguments: { boom: 1 } } });
  await send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "nope" } });
  assert.deepEqual(out[0].result.tools, [{ name: "echo" }]);
  assert.deepEqual(JSON.parse(out[1].result.content[0].text), { got: { a: 1 } });
  assert.equal(out[2].result.isError, true);
  assert.equal(out[2].result.content[0].text, "kaboom");
  assert.equal(out[3].error.code, -32602);
});

test("protocol errors: parse error, bad request, unknown method; notifications and responses get no reply", async () => {
  const { out, send } = harness(echo);
  await send("{nope");
  await send({ jsonrpc: "2.0", id: 5, foo: 1 });
  await send({ jsonrpc: "2.0", id: 6, method: "resources/list" });
  await send({ jsonrpc: "2.0", method: "notifications/initialized" });
  await send({ jsonrpc: "2.0", id: 7, result: {} });
  await send({ jsonrpc: "2.0", id: 8, method: "ping" });
  assert.equal(out[0].error.code, -32700);
  assert.equal(out[1].error.code, -32600);
  assert.equal(out[2].error.code, -32601);
  assert.deepEqual(out[3], { jsonrpc: "2.0", id: 8, result: {} });
  assert.equal(out.length, 4);
});

test("notifications/cancelled aborts the matching in-flight call", async () => {
  /** @type {AbortSignal|undefined} */
  let sig;
  const slow = {
    list: () => [],
    call: (_n, _a, { signal }) => new Promise((resolve) => { sig = signal; signal.addEventListener("abort", () => resolve({ aborted: true })); }),
  };
  const { out, send } = harness(slow);
  const p = send({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "x" } });
  await new Promise((r) => setTimeout(r, 10));
  await send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 9 } });
  await p;
  assert.equal(sig?.aborted, true);
  assert.deepEqual(out, [], "a cancelled request gets no response (MCP spec)");
});

test("serveStdio: concurrent requests, replies matched by id, resolves when stdin ends", async () => {
  const stdin = new PassThrough();
  /** @type {string[]} */
  const written = [];
  const slowFast = {
    list: () => [],
    call: async (name) => {
      if (name === "slow") await new Promise((r) => setTimeout(r, 50));
      return { name };
    },
  };
  const server = createMcpServer({ name: "t", version: "1", handlers: slowFast });
  const done = serveStdio(server, { stdin, stdout: { write: (s) => written.push(s) } });
  stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "slow" } }) + "\n");
  stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "fast" } }) + "\n");
  stdin.end();
  await done;
  const ids = written.map((w) => JSON.parse(w).id);
  assert.deepEqual(ids, [2, 1], "the fast call is not blocked behind the slow one");
});

test("createTools: read-only hides and refuses every write tool; annotations mark writes", async () => {
  const rw = createTools({});
  const ro = createTools({ readOnly: true });
  const names = (t) => t.list().map((x) => x.name);
  for (const w of ["run", "cancel", "release", "pause", "resume", "set_concurrency", "reconcile", "pull", "restart"]) {
    assert.ok(names(rw).includes(w), `${w} listed read-write`);
    assert.ok(!names(ro).includes(w), `${w} hidden read-only`);
    await assert.rejects(() => ro.call(w, { ref: "1" }, { signal: new AbortController().signal }), /read-only/);
  }
  for (const r of ["profiles", "status", "tick", "events", "runs", "board", "prs", "epics"]) assert.ok(names(ro).includes(r), `${r} stays read-only`);
  const cancel = rw.list().find((t) => t.name === "cancel");
  assert.equal(cancel.annotations.readOnlyHint, false);
  assert.equal(cancel.annotations.destructiveHint, true);
  assert.equal(rw.list().find((t) => t.name === "status").annotations.readOnlyHint, true);
  for (const t of rw.list()) assert.equal(t.inputSchema.type, "object");
});

test("tools/call validates arguments against the advertised schema (types, ranges, unknown fields, required)", async () => {
  const t = createTools({});
  const call = (name, args) => t.call(name, args, { signal: new AbortController().signal });
  await assert.rejects(() => call("events", { last: "abc" }), /events: "last" must be an integer/);
  await assert.rejects(() => call("events", { last: 0 }), /"last" must be >= 1/);
  await assert.rejects(() => call("events", { waitS: 9999 }), /"waitS" must be <= 120/);
  await assert.rejects(() => call("events", { types: [1] }), /array of strings/);
  await assert.rejects(() => call("events", { bogus: 1 }), /unknown argument "bogus"/);
  await assert.rejects(() => call("cancel", { actor: "root", ref: "1" }), /unknown argument "actor"/, "callers cannot set the audit actor");
  await assert.rejects(() => call("cancel", {}), /"ref" is required/);
  await assert.rejects(() => call("runs", { ref: 5 }), /"ref" must be a string/);
});

test("events tool's last path hides coalesced by default, returns it when explicitly requested", async () => {
  const registry = fs.mkdtempSync(path.join(os.tmpdir(), "agenthook-mcptools-"));
  const dir = path.join(registry, "p");
  fs.mkdirSync(path.join(dir, "logs"), { recursive: true });
  fs.writeFileSync(path.join(dir, "heartbeat.json"), JSON.stringify({ name: "p", maxConcurrent: 3, tracker: "github", queue: { active: 0, queued: 0 } }));
  fs.writeFileSync(path.join(dir, "server.pid"), String(process.pid));
  for (const f of ["running.json", "queue.json", "held.json", "refmeta.json"]) fs.writeFileSync(path.join(dir, f), "{}");
  const ev = (event, ref) => JSON.stringify({ ts: "t", event, ref, step: "code" }) + "\n";
  fs.writeFileSync(path.join(dir, "events.jsonl"), ev("enqueued", "1") + ev("coalesced", "1") + ev("run_end", "1"));

  const t = createTools({ registry });
  const call = (args) => t.call("events", { profile: "p", last: 10, ...args }, { signal: new AbortController().signal });
  const noFilter = await call({});
  assert.deepEqual(noFilter.events.map((e) => e.e), ["enqueued", "run_end"]);
  const explicit = await call({ types: ["coalesced"] });
  assert.deepEqual(explicit.events.map((e) => e.e), ["coalesced"]);
});

test("guide tool: lists topics, serves one section or all as raw markdown, rejects unknown topics; works read-only", async () => {
  const t = createTools({ readOnly: true });
  const ctx = { signal: new AbortController().signal };
  const idx = await t.call("guide", {}, ctx);
  for (const k of ["model", "shapes", "recipes", "events", "writes", "errors", "gotchas"]) assert.ok(idx.topics.includes(k), k);
  const one = await t.call("guide", { topic: "recipes" }, ctx);
  assert.equal(typeof one, "string");
  assert.match(one, /^## recipes/);
  assert.doesNotMatch(one, /^## model/m);
  const all = await t.call("guide", { topic: "all" }, ctx);
  assert.match(all, /## model[\s\S]*## gotchas/);
  await assert.rejects(() => t.call("guide", { topic: "nope" }, ctx), /unknown topic "nope"/);
});

test("every tool is covered by the agent guide or the writes table", async () => {
  const t = createTools({});
  const text = (await t.call("guide", { topic: "all" }, { signal: new AbortController().signal })) + "";
  for (const { name } of t.list()) assert.ok(text.includes(`\`${name}`), `guide never mentions \`${name}\``);
});
