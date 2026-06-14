#!/usr/bin/env node
// agenthook — event-driven agentic development receiver.
//
// Webhook in -> verify -> normalize -> dedup -> bounded queue -> headless
// `claude -p` in your repo -> branch + draft PR + status comment back.
// Provider-blind: all platform specifics live behind an adapter (src/providers).
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.js";
import { createStore } from "./store.js";
import { createAdapter } from "./providers/index.js";
import { createQueue } from "./queue.js";
import { createDispatcher } from "./dispatch.js";

const cfg = loadConfig();
const store = createStore(cfg.dataDir);
const adapter = createAdapter(cfg, store);
const runClaude = createDispatcher(cfg, adapter);
const queue = createQueue(cfg.maxConcurrent, runClaude);

// Reload the dedup set from disk each batch (the `catchup` CLI edits it out-of-band),
// then enqueue any job we haven't already handled. Disk is the source of truth.
/** @param {import('./types.js').Job[]} [jobs] */
function intake(jobs) {
  store.reloadSeen();
  for (const job of jobs || []) {
    if (!job.dedupKey || store.hasSeen(job.dedupKey)) continue;
    store.markSeen(job.dedupKey);
    const tail = job.text ? ` -> "${job.text.slice(0, 80)}"` : "";
    console.log(`[event] ${job.kind} ${job.ref}${tail}`);
    queue.enqueue(job);
  }
}

const server = http.createServer((req, res) => {
  if (req.method !== "POST") {
    res.writeHead(200);
    res.end("agenthook up");
    return;
  }
  const pathname = new URL(req.url || "/", "http://localhost").pathname;
  /** @type {Buffer[]} */
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const rawBody = Buffer.concat(chunks).toString("utf8");
    const ctx = { pathname, headers: req.headers, rawBody };

    let auth;
    try {
      auth = adapter.authenticate(ctx);
    } catch (e) {
      console.error("[auth]", e.message);
      res.writeHead(500);
      res.end();
      return;
    }
    if (auth.type === "handshake") {
      res.writeHead(200, auth.headers);
      res.end();
      return;
    }
    if (auth.type === "reject") {
      res.writeHead(401);
      res.end();
      return;
    }
    // accept: ACK immediately (providers expect a fast 2xx), then process async.
    res.writeHead(200);
    res.end();
    Promise.resolve(adapter.processEvents(ctx)).then(intake).catch((e) => console.error("[events]", e.message));
  });
});

server.listen(cfg.port, "127.0.0.1", () => {
  // Pidfile so stop scripts can kill by exact pid (never pkill -f a pattern that
  // self-matches the calling shell).
  try {
    fs.writeFileSync(path.join(cfg.dataDir, "server.pid"), String(process.pid));
  } catch {}
  console.log(`agenthook [${cfg.provider}] listening on 127.0.0.1:${cfg.port}`);
  console.log(`${store.secretCount()} secret(s), ${store.seenCount()} item(s) seen`);
});
