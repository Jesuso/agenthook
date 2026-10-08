// `ah ui` client for the receiver's control.sock (src/control.js, docs/web-ui.md § v3). Connects,
// skips the one-line "hello", writes a single `{id, cmd, args}` request and resolves on the
// matching reply — never writes any state dir. The receiver may be down (no socket) or hung
// (no reply); both are reported as tagged errors so the HTTP layer can map them to a status.
import net from "node:net";
import path from "node:path";
import { listProfiles } from "../heartbeat.js";
import { controlSockPath } from "../paths.js";

/** Cap on the buffered reply line — mirrors src/control.js's MAX_LINE_BYTES. */
const MAX_LINE_BYTES = 64 * 1024;

let nextId = 1;

/**
 * Send one `{id, cmd, args}` request over the control socket at `sockPath` and resolve with its
 * reply. The `hello` line and replies for other ids are ignored. The socket is always destroyed
 * before this resolves or rejects.
 * @param {string} sockPath @param {string} cmd @param {any} args @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<{ ok: true, result: any } | { ok: false, error: string }>}
 */
export function controlRequest(sockPath, cmd, args, { timeoutMs = 5000 } = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const socket = net.connect(sockPath);
    let buf = "";
    let settled = false;

    /** @param {(v: any) => void} fn @param {any} v */
    const done = (fn, v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      fn(v);
    };

    const timer = setTimeout(() => done(reject, Object.assign(new Error("timeout"), { code: "timeout" })), timeoutMs);

    socket.on("connect", () => socket.write(JSON.stringify({ id, cmd, args }) + "\n"));
    socket.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim() === "") continue;
        /** @type {any} */
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (!msg || typeof msg !== "object") continue;
        if (msg.type === "hello") continue;
        if (msg.id !== id) continue;
        return done(resolve, msg.ok ? { ok: true, result: msg.result } : { ok: false, error: msg.error });
      }
      if (Buffer.byteLength(buf, "utf8") > MAX_LINE_BYTES) done(reject, Object.assign(new Error("down"), { code: "down" }));
    });
    socket.on("error", (e) => done(reject, Object.assign(new Error("down"), { code: "down", cause: e })));
    socket.on("close", () => done(reject, Object.assign(new Error("down"), { code: "down" })));
  });
}

/** A known profile's state dir + control socket path, or null. Only state keys `listProfiles`
 * returns are accepted — mirrors src/ui/logs.js's `profileDir`.
 * @param {string} registry @param {string} profile
 * @returns {{ dir: string, sockPath: string } | null}
 */
export function resolveProfileSock(registry, profile) {
  if (!profile || !listProfiles(registry).some((p) => p.stateKey === profile)) return null;
  const dir = path.join(registry, profile);
  return { dir, sockPath: controlSockPath(dir, profile) };
}
