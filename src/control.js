// Liveness-only control socket: a UI client connects, gets one "hello" line, and
// learns the receiver is gone the moment the connection closes — no polling. v1
// implements no commands; client input is ignored. See docs/web-ui.md.
import net from "node:net";
import fs from "node:fs";
import { isAlive } from "./heartbeat.js";

/**
 * @param {import('./types.js').Config} cfg
 * @param {{startedAt: string}} opts
 * @returns {Promise<{close(): void} | null>}
 */
export async function startControl(cfg, { startedAt }) {
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

  /** @type {Set<import('node:net').Socket>} */
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {
      /* client hangup must not crash the receiver */
    });
    socket.resume(); // discard any client input — v1 is liveness only
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
