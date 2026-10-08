// Control socket: a UI client connects, gets one "hello" line, and learns the
// receiver is gone the moment the connection closes — no polling. Beyond that
// hello, the socket carries allowlisted NDJSON commands (request/response):
//   discover            tracker + stage keys + live stage list (cached 60s)
//   restart {when:'idle', moveTo?}  only when the engine passes `restart`: pause new runs,
//                       restart once active agents reach 0 (see engine.js)
//   decommission {when:'idle', unregister?}  only when the engine passes `decommission`: pause
//                       new runs; once active agents reach 0, unregister webhooks (default),
//                       exit without a respawn and archive the state dir (see engine.js)
// See docs/web-ui.md.
import net from "node:net";
import fs from "node:fs";
import { isAlive } from "./heartbeat.js";

const MAX_LINE_BYTES = 64 * 1024;
const DISCOVER_CACHE_MS = 60 * 1000;

/**
 * @param {{cfg: import('./types.js').Config, adapter?: import('./types.js').Adapter}} ctx
 * @returns {Promise<{tracker: string, stageKeys: import('./types.js').StageKeys|null, stages: Array<{id:string,label:string}>|null}>}
 */
async function discover(ctx) {
  const { cfg, adapter } = ctx;
  const stageKeys = adapter?.describe().stageKeys ?? null;
  if (!adapter?.listStages) {
    return { tracker: cfg.provider, stageKeys, stages: null };
  }
  const stages = (await adapter.listStages()).map(({ id, label }) => ({ id, label }));
  return { tracker: cfg.provider, stageKeys, stages };
}

/**
 * Wraps discover with a per-instance 60s cache (injectable clock). Only successful
 * results are cached; concurrent calls while a fetch is in flight share one promise.
 * @param {{cfg: import('./types.js').Config, adapter?: import('./types.js').Adapter}} ctx
 * @param {() => number} now
 */
function makeCachedDiscover(ctx, now) {
  /** @type {{value: any, expiresAt: number} | null} */
  let cached = null;
  /** @type {Promise<any> | null} */
  let pending = null;
  return async function cachedDiscover() {
    if (cached && now() < cached.expiresAt) return cached.value;
    if (pending) return pending;
    pending = discover(ctx).then(
      (value) => {
        cached = { value, expiresAt: now() + DISCOVER_CACHE_MS };
        pending = null;
        return value;
      },
      (e) => {
        pending = null;
        throw e;
      },
    );
    return pending;
  };
}

/**
 * Parses and dispatches one NDJSON request line, replying asynchronously on `socket`.
 * Replies may land out of order across concurrent lines — clients match by `id`.
 * @param {import('node:net').Socket} socket
 * @param {string} line
 * @param {Record<string, (ctx: any) => Promise<any>>} commands
 */
function handleLine(socket, line, commands) {
  /** @type {any} */
  let req = null;
  try {
    req = JSON.parse(line);
  } catch {
    /* handled below */
  }
  const id = req && typeof req === "object" && !Array.isArray(req) ? req.id ?? null : null;
  if (!req || typeof req !== "object" || Array.isArray(req) || typeof req.cmd !== "string") {
    reply(socket, { id, ok: false, error: "bad request" });
    return;
  }
  if (!Object.hasOwn(commands, req.cmd)) {
    reply(socket, { id, ok: false, error: "unknown command" });
    return;
  }
  commands[req.cmd](req.args)
    .then((result) => reply(socket, { id, ok: true, result }))
    .catch((e) => {
      console.error(`[control] ${req.cmd} failed: ${e.message}`);
      reply(socket, { id, ok: false, error: `${req.cmd} failed` });
    });
}

/**
 * @param {import('node:net').Socket} socket
 * @param {object} msg
 */
function reply(socket, msg) {
  if (socket.destroyed) return;
  socket.write(JSON.stringify(msg) + "\n");
}

/**
 * @param {import('./types.js').Config} cfg
 * @param {{startedAt: string, adapter?: import('./types.js').Adapter, now?(): number, restart?: (args: any) => Promise<any>, decommission?: (args: any) => Promise<any>}} opts
 *   restart: the engine's restart requester; the `restart` command exists only when given.
 *   decommission: the engine's decommission requester; likewise only when given
 * @returns {Promise<{close(): void} | null>}
 */
export async function startControl(cfg, { startedAt, adapter, now = Date.now, restart, decommission }) {
  const sockPath = cfg.controlSock;
  const posix = process.platform !== "win32";

  if (posix && fs.existsSync(sockPath)) {
    const ownerPid = readPid(cfg.pidFile);
    if (ownerPid && ownerPid !== process.pid && isAlive(ownerPid)) {
      console.error(`[control] ${sockPath} is owned by live receiver pid ${ownerPid} — control socket disabled`);
      return null;
    }
    try {
      fs.rmSync(sockPath, { force: true });
    } catch (e) {
      console.error(`[control] failed to remove stale socket: ${e.message}`);
    }
  }

  const ctx = { cfg, adapter };
  /** @type {Record<string, (args: any) => Promise<any>>} */
  const commands = { discover: makeCachedDiscover(ctx, now) };
  if (restart) commands.restart = restart;
  if (decommission) commands.decommission = decommission;

  /** @type {Set<import('node:net').Socket>} */
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {
      /* client hangup must not crash the receiver */
    });

    let buf = "";
    socket.setEncoding("utf8");
    socket.on("data", (/** @type {string} */ chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim() !== "") handleLine(socket, line, commands);
      }
      if (Buffer.byteLength(buf, "utf8") > MAX_LINE_BYTES) socket.destroy();
    });

    socket.write(JSON.stringify({ type: "hello", name: cfg.name, pid: process.pid, startedAt }) + "\n");
  });
  server.on("error", (e) => console.error(`[control] ${e.message}`));

  try {
    await listenPrivate(server, sockPath);
  } catch (e) {
    console.error(`[control] failed to listen on ${sockPath}: ${e.message}`);
    return null;
  }

  if (posix) {
    try {
      fs.chmodSync(sockPath, 0o600);
    } catch (e) {
      console.error(`[control] chmod failed: ${e.message}`);
    }
  }

  return {
    close() {
      for (const socket of sockets) socket.destroy();
      server.close();
      if (posix) {
        try {
          fs.rmSync(sockPath, { force: true });
        } catch {
          /* ignore */
        }
      }
    },
  };
}

/**
 * Listen on `sockPath` born private: on POSIX, the process umask is tightened for
 * the brief listen() window so the socket file comes out 0600 the instant it's
 * created, closing the race where a default-umask socket is briefly connectable
 * by another local user before a later chmod. umask is process-global but is
 * always restored, on success or failure — anything else created in that window
 * just comes out stricter, which is harmless.
 * @param {import('node:net').Server} server
 * @param {string} sockPath
 * @returns {Promise<void>}
 */
export async function listenPrivate(server, sockPath) {
  const posix = process.platform !== "win32";
  const prev = posix ? process.umask(0o077) : null;
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(sockPath, () => resolve(undefined));
    });
  } finally {
    if (posix) process.umask(/** @type {number} */ (prev));
  }
}

/** @param {string} pidFile */
function readPid(pidFile) {
  try {
    return parseInt(fs.readFileSync(pidFile, "utf8"), 10);
  } catch {
    return null;
  }
}
