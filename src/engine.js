// The receiver engine. One profile = one engine = one process.
//
// Boot sequence (server owns the ingress lifecycle):
//   ingress.up(port) -> url
//   if ingress.ephemeral: tracker.unregisterWebhooks()   # scrub dead-URL hooks
//   tracker.registerWebhook(url)                          # idempotent if stable
//   listen + write pidfile + heartbeat
//   on exit: ingress.down(), clear pidfile/heartbeat
//
// The request path is the same fast-ACK-then-async shape as before: authenticate
// (sync, no network) -> ACK 200 -> processEvents off the response path -> intake.
import http from "node:http";
import fs from "node:fs";
import { createStore } from "./store.js";
import { createAdapter } from "./trackers/index.js";
import { createIngress } from "./ingress/index.js";
import { createQueue } from "./queue.js";
import { createDispatcher } from "./dispatch.js";
import { createHeartbeat } from "./heartbeat.js";

/** @param {import('./types.js').Config} cfg */
export function createEngine(cfg) {
  const store = createStore(cfg.dataDir);
  const adapter = createAdapter(cfg, store);
  const ingress = createIngress(cfg);
  const heartbeat = createHeartbeat(cfg);
  const runClaude = createDispatcher(cfg, adapter);
  const queue = createQueue(cfg.maxConcurrent, runClaude, (state) =>
    heartbeat.update({ queue: state, seen: store.seenCount() }),
  );

  // Reload the dedup set from disk each batch (catchup edits it out-of-band), then
  // enqueue anything new. Disk is the source of truth.
  /** @param {import('./types.js').Job[]} [jobs] */
  function intake(jobs) {
    store.reloadSeen();
    for (const job of jobs || []) {
      if (!job.dedupKey || store.hasSeen(job.dedupKey)) continue;
      store.markSeen(job.dedupKey);
      const tail = job.text ? ` -> "${job.text.slice(0, 80)}"` : "";
      console.log(`[event] ${job.kind} ${job.ref}${tail}`);
      heartbeat.update({
        lastEvent: { at: new Date().toISOString(), kind: job.kind, ref: job.ref, text: job.text || null },
        seen: store.seenCount(),
      });
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

  let shuttingDown = false;
  /** @param {string} [signal] */
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[shutdown] ${signal || ""} — tearing down`);
    try {
      await ingress.down();
    } catch (e) {
      console.error("[ingress] down failed:", e.message);
    }
    heartbeat.clear();
    try {
      fs.rmSync(cfg.pidFile, { force: true });
    } catch {
      /* ignore */
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref(); // don't hang on lingering sockets
  }

  async function serve() {
    const meta = ingress.describe();
    console.log(`[boot] profile "${cfg.name}" — tracker ${cfg.provider}, ingress ${meta.name}`);

    const { url } = await ingress.up(cfg.port);
    fs.writeFileSync(cfg.publicUrlFile, url);
    heartbeat.update({ url });

    if (meta.ephemeral) {
      console.log("[boot] ingress URL is ephemeral — scrubbing stale webhooks");
      try {
        await adapter.unregisterWebhooks();
      } catch (e) {
        console.error("[boot] unregister failed (continuing):", e.message);
      }
    }
    await adapter.registerWebhook(url);

    await new Promise((resolve) => server.listen(cfg.port, "127.0.0.1", () => resolve(undefined)));
    fs.writeFileSync(cfg.pidFile, String(process.pid));
    console.log(`agenthook [${cfg.name}] listening on 127.0.0.1:${cfg.port}  (public: ${url})`);
    console.log(`${store.secretCount()} secret(s), ${store.seenCount()} item(s) seen`);

    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
  }

  return { serve, shutdown, store, adapter, ingress };
}
