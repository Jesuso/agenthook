// `ah ui` HTTP server (docs/web-ui.md). Localhost-only, read-only. Every request passes
// the DNS-rebinding Host guard first; `/api/*` additionally needs the per-launch token,
// exchanged once via `/?token=` for an HttpOnly SameSite=Strict cookie. Static assets
// (the public frontend bundle) need no cookie — only `/api/*` exposes state.
// `/api/stream` pushes UiEvent deltas over SSE from a dir watcher started on the first
// stream connection. The server writes nothing to any state dir.
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { registryDir } from "../config.js";
import { buildSnapshot } from "./rows.js";
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

    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return send(res, 405);
    }

    const raw = String(req.url || "/");
    const q = raw.indexOf("?");
    /** @type {string} */
    let p;
    try {
      p = decodeURIComponent(q === -1 ? raw : raw.slice(0, q));
    } catch {
      return send(res, 400);
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
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Accel-Buffering": "no",
        });
        res.flushHeaders();
        streams.add(res);
        const ping = setInterval(() => res.write(": ping\n\n"), PING_MS);
        const done = () => {
          clearInterval(ping);
          streams.delete(res);
        };
        req.on("close", done);
        res.on("close", done);
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
    return close(cb);
  };
  return server;
}
