// `ah ui` HTTP server (docs/web-ui.md). Localhost-only, read-only. Every request passes
// the DNS-rebinding Host guard first; `/api/*` additionally needs the per-launch token,
// exchanged once via `/?token=` for an HttpOnly SameSite=Strict cookie. Static assets
// (the public frontend bundle) need no cookie — only `/api/*` exposes state.
// The server writes nothing to any state dir.
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { registryDir } from "../config.js";
import { buildSnapshot } from "./rows.js";

export const COOKIE = "ah_ui";

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
          body = JSON.stringify(buildSnapshot(registry));
        } catch {
          return send(res, 500);
        }
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        return res.end(body);
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
  return server;
}
