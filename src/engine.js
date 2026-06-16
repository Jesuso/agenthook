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
  /** @type {Set<import('node:child_process').ChildProcess>} */
  const children = new Set();
  const runClaude = createDispatcher(cfg, adapter, children, store);
  const queue = createQueue(cfg.maxConcurrent, runClaude, (state) =>
    heartbeat.update({ queue: state, seen: store.seenCount() }),
  );

  // Reload the dedup set from disk each batch (catchup edits it out-of-band), then
  // enqueue anything new. Disk is the source of truth. No section side-effect here:
  // a job's section is gated downstream (legacy: assignedToUs in dispatch; pipeline:
  // the task already rests in the step's source section), so moving on enqueue would
  // yank tasks the dispatcher then skips.
  /**
   * @param {import('./types.js').Job[]} [jobs]
   * @param {{force?: boolean}} [opts]  force skips the dedup gate (explicit replay/reconcile)
   */
  function intake(jobs, { force = false } = {}) {
    store.reloadSeen();
    for (const job of jobs || []) {
      if (!job.dedupKey) continue;
      if (!force && store.hasSeen(job.dedupKey)) continue;
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

  // Crash recovery from LOCAL state only — never a board poll. A restart kills the
  // in-memory queue and orphans any in-flight `claude -p`; running.json is the record
  // of what was mid-step. We resolve each as a failed run (implement isn't idempotent,
  // so re-running blind is unsafe) → the adapter moves it to its failure lane for a
  // human. Catching tasks that *arrived* during downtime is the explicit `reconcile`
  // command's job, not boot's.
  async function recoverInterrupted() {
    const running = store.listRunning();
    const refs = Object.keys(running);
    if (!refs.length) return;
    console.log(`[recover] ${refs.length} step(s) interrupted by restart — moving to failure lane`);
    for (const ref of refs) {
      const { stepId } = running[ref];
      try {
        await adapter.advance?.(ref, stepId, "fail");
      } catch (e) {
        console.error(`[recover] advance ${ref} (${stepId}) failed:`, e.message);
      }
      store.clearRunning(ref);
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

  let draining = false;
  /** Final teardown shared by graceful + forced exit. */
  function teardown() {
    heartbeat.clear();
    try {
      fs.rmSync(cfg.pidFile, { force: true });
    } catch {
      /* ignore */
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref(); // don't hang on lingering sockets
  }

  /** Force path: kill in-flight agents and exit now (second signal, or no children). @param {string} reason */
  function forceExit(reason) {
    console.log(`[shutdown] ${reason} — killing ${children.size} agent(s)`);
    for (const child of children) {
      try {
        child.kill("SIGTERM");
      } catch {
        /* already gone */
      }
    }
    teardown();
  }

  // First signal drains: stop taking new work, let running + queued agents finish,
  // then exit. A second signal during the drain force-kills the agents immediately.
  /** @param {string} [signal] */
  async function shutdown(signal) {
    if (draining) {
      forceExit(`${signal || "signal"} during drain`);
      return;
    }
    draining = true;

    // Stop new work reaching the queue, then close the front door so no fresh
    // events arrive. In-flight `claude -p` children keep running untouched.
    queue.close();
    try {
      await ingress.down();
    } catch (e) {
      console.error("[ingress] down failed:", e.message);
    }
    server.close(); // stop accepting new connections; in-flight handlers finish

    const { active, queued } = queue.state();
    if (active === 0 && queued === 0) {
      console.log(`\n[shutdown] ${signal || ""} — nothing running, exiting`);
      teardown();
      return;
    }
    console.log(
      `\n[shutdown] ${signal || ""} — draining ${active} running + ${queued} queued agent(s); ` +
        `send the signal again to force-kill`,
    );
    heartbeat.update({ draining: true, queue: queue.state() });
    await queue.onIdle();
    console.log(`[shutdown] drain complete — exiting`);
    teardown();
  }

  async function serve() {
    const meta = ingress.describe();
    console.log(`[boot] profile "${cfg.name}" — tracker ${cfg.provider}, ingress ${meta.name}`);

    let ingressUp = false;
    try {
      const { url } = await ingress.up(cfg.port);
      ingressUp = true;
      fs.writeFileSync(cfg.publicUrlFile, url);
      heartbeat.update({ url });

      // Listen BEFORE registering: registering a webhook makes the tracker immediately
      // POST a handshake/ping to the public URL, which must reach a live server (Asana
      // needs the X-Hook-Secret echoed back, or it fails the hook with a 502).
      await new Promise((resolve) => server.listen(cfg.port, "127.0.0.1", () => resolve(undefined)));
      fs.writeFileSync(cfg.pidFile, String(process.pid));
      console.log(`agenthook [${cfg.name}] listening on 127.0.0.1:${cfg.port}  (public: ${url})`);

      if (meta.ephemeral) {
        console.log("[boot] ingress URL is ephemeral — scrubbing stale webhooks");
        try {
          await adapter.unregisterWebhooks();
        } catch (e) {
          console.error("[boot] unregister failed (continuing):", e.message);
        }
      }
      await adapter.registerWebhook(url);

      // Self-heal from LOCAL state only (no board poll — see recoverInterrupted).
      await recoverInterrupted();
    } catch (e) {
      // Boot failed after the tunnel came up — tear it down so it doesn't orphan
      // (an orphaned ngrok endpoint causes ERR_NGROK_334 on the next start).
      if (ingressUp) await ingress.down().catch(() => {});
      throw e;
    }

    console.log(`${store.secretCount()} secret(s), ${store.seenCount()} item(s) seen`);
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
  }

  return { serve, shutdown, store, adapter, ingress };
}
