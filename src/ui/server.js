// `ah ui` HTTP server (docs/web-ui.md). Localhost-only, read-only. Every request passes
// the DNS-rebinding Host guard first; `/api/*` additionally needs the per-launch token,
// exchanged once via `/?token=` for an HttpOnly SameSite=Strict cookie. Static assets
// (the public frontend bundle) need no cookie — only `/api/*` exposes state.
// `/api/stream` pushes UiEvent deltas over SSE from a dir watcher started on the first
// stream connection. `/api/runs` + `/api/log/stream` back the run-log viewer (src/ui/logs.js).
// `/api/instructions*` + `/api/prompt-preview` are the instructions editor's read side
// (src/ui/instructions.js); `PUT /api/instructions/file` is its write side and the one write
// `ah ui` makes — an allowlisted instruction file plus a line in the profile's `ui-audit.jsonl`
// (instructions.js writeInstructionFile). It additionally requires a same-origin `Origin`,
// `X-AH-UI: 1` and a JSON body ≤ 256 KB. Nothing else in any state dir is ever written.
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { registryDir } from "../config.js";
import {
  INSTRUCTIONS_MAX_BYTES,
  listInstructions,
  promptPreview,
  readInstructionFile,
  writeInstructionFile,
} from "./instructions.js";
import { createLogTail, listRuns, profileDir, resolveRunLog } from "./logs.js";
import { buildSnapshot, readEventsTail } from "./rows.js";
import { createWatcher } from "./watch.js";

export const COOKIE = "ah_ui";

/** SSE keepalive comment interval — the only interval in `ah ui`. */
export const PING_MS = 25_000;

/** @type {Record<string, string>} */
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

/** The one path that also takes a write (PUT). */
const INSTR_FILE = "/api/instructions/file";

/** Constant-time string compare; a length mismatch is a mismatch. @param {string} a @param {string} b */
export function safeEqual(a, b) {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** The `ah_ui` value from a Cookie header, or null. @param {string|undefined} header */
export function cookieToken(header) {
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i !== -1 && part.slice(0, i).trim() === COOKIE) return part.slice(i + 1).trim();
  }
  return null;
}

/**
 * @param {{ port: number, token: string, distDir: string, registry?: string }} opts
 * @returns {http.Server}
 */
export function createUiServer({ port, token, distDir, registry = registryDir }) {
  const root = path.resolve(distDir);
  /** @type {ReturnType<typeof createWatcher>|null} */
  let watcher = null;
  /** @type {Set<http.ServerResponse>} */
  const streams = new Set();
  /** Open `/api/log/stream` responses → their tail's cleanup. @type {Map<http.ServerResponse, () => void>} */
  const tails = new Map();

  /** @param {import('./contract.js').UiEvent} ev */
  const broadcast = (ev) => {
    const frame = `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`;
    for (const res of streams) res.write(frame);
  };

  /** @param {http.ServerResponse} res @param {number} code @param {string} [body] */
  const send = (res, code, body = http.STATUS_CODES[code] || "") => {
    res.writeHead(code, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(body);
  };

  /** `code` (200) JSON (no-store), or 404 when `get` returns null; 500 if it throws.
   * @param {http.ServerResponse} res @param {() => any} get @param {number} [code] */
  const sendJson = (res, get, code = 200) => {
    /** @type {string} */
    let body;
    try {
      const v = get();
      if (v === null) return send(res, 404);
      body = JSON.stringify(v);
    } catch {
      return send(res, 500);
    }
    res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(body);
  };

  /** Start an SSE response with the keepalive ping; `onClose` runs once when either side ends.
   * @param {http.IncomingMessage} req @param {http.ServerResponse} res @param {() => void} onClose
   * @returns {() => void} the idempotent cleanup */
  const openSse = (req, res, onClose) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();
    const ping = setInterval(() => res.write(": ping\n\n"), PING_MS);
    let ended = false;
    const done = () => {
      if (ended) return;
      ended = true;
      clearInterval(ping);
      onClose();
    };
    req.on("close", done);
    res.on("close", done);
    return done;
  };

  /**
   * `PUT /api/instructions/file` — guards in order: cookie (Host already checked) → 401;
   * `Origin` exactly `http://<host>` → 403; `X-AH-UI: 1` → 403; JSON Content-Type → 415;
   * body ≤ INSTRUCTIONS_MAX_BYTES → 413; `{profile, path, baseHash, content}` all strings → 400;
   * then writeInstructionFile (404 / 413 / 409 `{content, hash}` / 500 / 200 `{hash}`). Nothing
   * is awaited after the body is read, so concurrent saves serialise (see writeInstructionFile).
   * @param {http.IncomingMessage} req @param {http.ServerResponse} res @param {string} host the validated Host
   */
  const putInstructions = (req, res, host) => {
    const c = cookieToken(req.headers.cookie);
    if (c === null || !safeEqual(c, token)) return send(res, 401);
    if (req.headers.origin !== `http://${host}`) return send(res, 403);
    if (req.headers["x-ah-ui"] !== "1") return send(res, 403);
    const type = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
    if (type !== "application/json") return send(res, 415);

    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    let over = false;
    req.on("data", (/** @type {Buffer} */ chunk) => {
      if (over) return;
      size += chunk.length;
      if (size <= INSTRUCTIONS_MAX_BYTES) return void chunks.push(chunk);
      over = true;
      chunks.length = 0;
      res.setHeader("Connection", "close");
      send(res, 413);
      res.on("finish", () => req.destroy());
    });
    req.on("error", () => {});
    req.on("end", () => {
      if (over) return;
      /** @type {any} */
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        return send(res, 400);
      }
      const { profile, path: file, baseHash, content } = body && typeof body === "object" ? body : /** @type {any} */ ({});
      if (![profile, file, baseHash, content].every((v) => typeof v === "string")) return send(res, 400);
      const r = writeInstructionFile(registry, profile, file, baseHash, content);
      if (r.status === 409) return sendJson(res, () => ({ content: r.content, hash: r.hash }), 409);
      if (r.status !== 200) return send(res, r.status);
      watcher?.noteWrite(profile, file, r.hash);
      broadcast({ type: "instructions", profile, path: file, hash: r.hash, source: "ui" });
      sendJson(res, () => ({ hash: r.hash }));
    });
  };

  // requireHostHeader:false — a Host-less request reaches the guard below (→ 403), not Node's 400.
  const server = http.createServer({ requireHostHeader: false }, (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");

    // DNS-rebinding guard: the Host must name our loopback listener exactly.
    const addr = server.address();
    const bound = addr && typeof addr === "object" ? addr.port : port;
    const host = String(req.headers.host || "").toLowerCase();
    if (host !== `127.0.0.1:${bound}` && host !== `localhost:${bound}`) return send(res, 403);

    const raw = String(req.url || "/");
    const q = raw.indexOf("?");
    /** @type {string} */
    let p;
    try {
      p = decodeURIComponent(q === -1 ? raw : raw.slice(0, q));
    } catch {
      if (req.method === "GET") return send(res, 400);
      res.setHeader("Allow", "GET");
      return send(res, 405);
    }

    if (req.method === "PUT" && p === INSTR_FILE) return putInstructions(req, res, host);
    if (req.method !== "GET") {
      res.setHeader("Allow", p === INSTR_FILE ? "GET, PUT" : "GET");
      return send(res, 405);
    }

    if (p.includes("\0")) return send(res, 403);
    const params = new URLSearchParams(q === -1 ? "" : raw.slice(q + 1));

    // Token → cookie exchange (the URL `ah ui` prints / opens).
    if (p === "/" && params.has("token")) {
      if (!safeEqual(params.get("token") || "", token)) return send(res, 401);
      res.writeHead(302, {
        Location: "/",
        "Set-Cookie": `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/`,
        "Cache-Control": "no-store",
      });
      return res.end();
    }

    if (p === "/api" || p.startsWith("/api/")) {
      const c = cookieToken(req.headers.cookie);
      if (c === null || !safeEqual(c, token)) return send(res, 401);
      if (p === "/api/snapshot") {
        /** @type {string} */
        let body;
        try {
          body = JSON.stringify(watcher ? watcher.snapshot() : buildSnapshot(registry));
        } catch {
          return send(res, 500);
        }
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        return res.end(body);
      }
      if (p === "/api/stream") {
        if (!watcher) watcher = createWatcher(registry, broadcast);
        openSse(req, res, () => streams.delete(res));
        streams.add(res);
        return;
      }
      if (p === "/api/runs") {
        const profile = params.get("profile") || "";
        const ref = params.get("ref") || "";
        const dir = profileDir(registry, profile);
        if (!dir) return send(res, 404);
        if (!ref) return send(res, 400);
        /** @type {string} */
        let body;
        try {
          body = JSON.stringify({ runs: listRuns(registry, profile, ref, readEventsTail(path.join(dir, "events.jsonl"))) });
        } catch {
          return send(res, 500);
        }
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        return res.end(body);
      }
      if (p === "/api/instructions") return sendJson(res, () => listInstructions(registry, params.get("profile") || ""));
      if (p === "/api/instructions/file") {
        return sendJson(res, () => readInstructionFile(registry, params.get("profile") || "", params.get("path") || ""));
      }
      if (p === "/api/prompt-preview") {
        return sendJson(res, () => promptPreview(registry, params.get("profile") || "", params.get("step") || ""));
      }
      if (p === "/api/log/stream") {
        const file = resolveRunLog(registry, params.get("profile") || "", params.get("run") || "");
        if (!file) return send(res, 404);
        /** @type {{ close(): void }|null} */
        let tail = null;
        const done = openSse(req, res, () => {
          tail?.close();
          tails.delete(res);
        });
        tail = createLogTail(file, (f) => {
          const { type, ...data } = f;
          res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
        });
        tails.set(res, done);
        return;
      }
      return send(res, 404);
    }

    // Static bundle — traversal-safe: the resolved file (and its realpath) must stay in distDir.
    const file = path.resolve(root, "." + (p === "/" ? "/index.html" : p));
    if (!file.startsWith(root + path.sep)) return send(res, 403);
    /** @type {Buffer} */
    let data;
    try {
      const real = fs.realpathSync(file);
      if (!real.startsWith(fs.realpathSync(root) + path.sep)) return send(res, 403);
      if (!fs.statSync(real).isFile()) return send(res, 404);
      data = fs.readFileSync(real);
    } catch {
      return send(res, 404);
    }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream" });
    res.end(data);
  });

  // Open SSE responses would hold server.close() forever: end them and stop the watcher first.
  const close = server.close.bind(server);
  server.close = (cb) => {
    watcher?.close();
    watcher = null;
    for (const res of streams) res.end();
    streams.clear();
    for (const [res, done] of tails) {
      done();
      res.end();
    }
    return close(cb);
  };
  return server;
}
