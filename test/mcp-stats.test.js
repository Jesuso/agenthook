import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// MCP `stats` tool (#646): reads the state dir like `status`, works with the receiver down,
// validates by/since.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTools } from "../src/mcp/tools.js";

function profile(registry, name, { usage = [], events = [] } = {}) {
  const dir = path.join(registry, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "heartbeat.json"), JSON.stringify({ name, maxConcurrent: 3, tracker: "github", queue: { active: 0, queued: 0 } }));
  if (usage.length) fs.writeFileSync(path.join(dir, "usage.jsonl"), usage.map((r) => JSON.stringify(r)).join("\n") + "\n");
  if (events.length) fs.writeFileSync(path.join(dir, "events.jsonl"), events.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return dir;
}

const NOW_ISO = new Date().toISOString();
const STARTED_ISO = new Date(Date.now() - 60_000).toISOString();

test("stats tool is listed and works with the receiver down (no server.pid)", async () => {
  const registry = fs.mkdtempSync(path.join(os.tmpdir(), "agenthook-mcpstats-"));
  profile(registry, "p", {
    usage: [{ ref: "1", stepId: "code", harness: "fast", startedAt: STARTED_ISO, endedAt: NOW_ISO, input: 10, output: 20, cacheRead: 0, cacheCreate: 0 }],
    events: [{ ts: NOW_ISO, event: "run_end", ref: "1", step: "code", outcome: "advance", harness: "fast" }],
  });
  const t = createTools({ registry });
  assert.ok(t.list().some((x) => x.name === "stats"));
  const r = await t.call("stats", { profile: "p" }, { signal: new AbortController().signal });
  assert.equal(r.by, "harness");
  assert.equal(r.groups.length, 1);
  assert.equal(r.groups[0].key, "fast");
  assert.equal(r.groups[0].runs, 1);
});

test("stats tool validates by/since enums", async () => {
  const registry = fs.mkdtempSync(path.join(os.tmpdir(), "agenthook-mcpstats-bad-"));
  profile(registry, "p");
  const t = createTools({ registry });
  const call = (args) => t.call("stats", { profile: "p", ...args }, { signal: new AbortController().signal });
  await assert.rejects(() => call({ by: "nope" }), /"by" must be one of/);
  await assert.rejects(() => call({ since: "9d" }), /"since" must be one of/);
});

test("stats tool rejects unknown arguments and non-string by/since (schema)", async () => {
  const registry = fs.mkdtempSync(path.join(os.tmpdir(), "agenthook-mcpstats-schema-"));
  profile(registry, "p");
  const t = createTools({ registry });
  const call = (args) => t.call("stats", { profile: "p", ...args }, { signal: new AbortController().signal });
  await assert.rejects(() => call({ bogus: 1 }), /unknown argument "bogus"/);
  await assert.rejects(() => call({ by: 1 }), /"by" must be a string/);
});

test("stats tool stays read-only (listed when readOnly)", () => {
  const t = createTools({ readOnly: true });
  assert.ok(t.list().some((x) => x.name === "stats"));
});

test("stats tool reads the whole events.jsonl, not just the UI's 256 KB tail", async () => {
  // A run_end near the top of the file, followed by > 256 KB of unrelated events, used to fall
  // outside readEventsTail's default window — the run_end was invisible, so its usage row
  // (still fully read from usage.jsonl) counted as `unknown` instead of `advance`.
  const registry = fs.mkdtempSync(path.join(os.tmpdir(), "agenthook-mcpstats-tail-"));
  const dir = profile(registry, "p", {
    usage: [{ ref: "1", stepId: "code", harness: "fast", startedAt: STARTED_ISO, endedAt: NOW_ISO, input: 10, output: 20, cacheRead: 0, cacheCreate: 0 }],
  });
  const lines = [JSON.stringify({ ts: NOW_ISO, event: "run_end", ref: "1", step: "code", outcome: "advance", harness: "fast" })];
  const pad = JSON.stringify({ ts: NOW_ISO, event: "noop", pad: "x".repeat(500) });
  while (Buffer.byteLength(lines.join("\n")) < 400 * 1024) lines.push(pad);
  fs.writeFileSync(path.join(dir, "events.jsonl"), lines.join("\n") + "\n");

  const t = createTools({ registry });
  const r = await t.call("stats", { profile: "p" }, { signal: new AbortController().signal });
  assert.equal(r.groups[0].key, "fast");
  assert.equal(r.groups[0].outcomes.advance, 1);
  assert.equal(r.groups[0].outcomes.unknown, 0);
});
