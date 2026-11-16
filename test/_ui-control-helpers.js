// Shared fixtures for the ui-control-*.test.js files (split from the former ui-control.test.js
// so no single test file costs ~40K tokens to read). Not matched by the `test/*.test.js` glob
// `npm test` runs, so it is never itself executed as a test file.
import test from "node:test";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { controlSockPath } from "../src/paths.js";
import { createUiServer } from "../src/ui/server.js";

export const TOKEN = "t0k3n-abcdefghijklmnopqrstuvwxyz0123456789";
export const DISCOVER_MS = 150;
export const RESTART_MS = 150;

/**
 * Builds the full `ah ui` control-socket fixture: a temp registry of profiles, a fake control
 * socket per profile (sends the v1 `hello` line, then one scripted reply per request), and a
 * real `createUiServer` bound to an ephemeral port in front of them. Registers test.before/
 * test.after for all of it, so callers just destructure the result and write test()s.
 */
export function setupUiControl() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ah-ui-control-"));
  test.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const registry = path.join(root, "registry");
  fs.mkdirSync(path.join(root, "dist"));

  /** A profile with a state dir, no control socket yet. @param {string} name */
  function profile(name) {
    const dir = path.join(registry, name);
    fs.mkdirSync(dir, { recursive: true });
    return { dir, sockPath: controlSockPath(dir, name) };
  }

  const profiles = {
    DOWN: profile("down"), // dir exists, nothing listens
    TIMEOUT: profile("timeout"),
    FAIL: profile("fail"),
    OK: profile("ok"),
    RESTARTED: profile("restarted"),
    DISMISSED: profile("dismissed"),
    RELEASED: profile("released"),
    RETRIED: profile("retried"),
    RECHECKED: profile("rechecked"),
    RELEASE_REFUSED: profile("release-refused"),
    RELEASE_SLOW: profile("release-slow"),
    TOGGLED: profile("toggled"),
    DIGESTED: profile("digested"),
    ADDED: profile("ticket-added"),
    ADDED_FAIL: profile("ticket-fail"),
    NOT_LOCAL: profile("ticket-notlocal"),
    DOWN_LOCAL: profile("ticket-down"),
  };
  // The server's tracker check reads the heartbeat's `tracker` field.
  fs.writeFileSync(path.join(profiles.ADDED.dir, "heartbeat.json"), JSON.stringify({ tracker: "local" }));
  fs.writeFileSync(path.join(profiles.ADDED_FAIL.dir, "heartbeat.json"), JSON.stringify({ tracker: "local" }));
  fs.writeFileSync(path.join(profiles.NOT_LOCAL.dir, "heartbeat.json"), JSON.stringify({ tracker: "github" }));
  fs.writeFileSync(path.join(profiles.DOWN_LOCAL.dir, "heartbeat.json"), JSON.stringify({ tracker: "local" }));

  /**
   * Starts a fake control socket at `sockPath`: writes the `hello` line on connect, then calls
   * `onLine(socket, req)` for each NDJSON request line. Returns a closer.
   * @param {string} sockPath @param {(socket: net.Socket, req: any) => void} onLine
   */
  function fakeControl(sockPath, onLine) {
    const server = net.createServer((socket) => {
      socket.write(JSON.stringify({ type: "hello", name: "x", pid: 1, startedAt: "t" }) + "\n");
      let buf = "";
      socket.on("data", (chunk) => {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (line.trim() !== "") onLine(socket, JSON.parse(line));
        }
      });
      socket.on("error", () => {});
    });
    return new Promise((resolve) => server.listen(sockPath, () => resolve(server)));
  }

  /** @type {{restart: any[], dismiss: any[], toggle: any[], release: any[], digest: any[], retry: any[], recheck: any[], ticket: any[]}} */
  const calls = { restart: [], dismiss: [], toggle: [], release: [], digest: [], retry: [], recheck: [], ticket: [] };

  /** @type {net.Server[]} */
  const fakes = [];
  test.before(async () => {
    const { DOWN, TIMEOUT, FAIL, OK, RESTARTED, DISMISSED, RETRIED, RECHECKED, RELEASED, RELEASE_REFUSED, RELEASE_SLOW, DIGESTED, TOGGLED, ADDED, ADDED_FAIL } = profiles;
    fakes.push(
      await fakeControl(TIMEOUT.sockPath, () => {}), // never replies
      await fakeControl(FAIL.sockPath, (s, req) => s.write(JSON.stringify({ id: req.id, ok: false, error: "unknown command" }) + "\n")),
      await fakeControl(OK.sockPath, (s, req) =>
        s.write(JSON.stringify({ id: req.id, ok: true, result: { tracker: "github", stageKeys: null, stages: [{ id: "code", label: "Code" }] } }) + "\n"),
      ),
      await fakeControl(RESTARTED.sockPath, (s, req) => {
        calls.restart.push(req);
        s.write(JSON.stringify({ id: req.id, ok: true, result: { accepted: true, active: 0, queued: 0 } }) + "\n");
      }),
      await fakeControl(DISMISSED.sockPath, (s, req) => {
        calls.dismiss.push(req);
        s.write(JSON.stringify({ id: req.id, ok: true, result: { ref: req.args.ref, dismissed: true } }) + "\n");
      }),
      await fakeControl(RETRIED.sockPath, (s, req) => {
        calls.retry.push(req);
        s.write(JSON.stringify({ id: req.id, ok: true, result: { ref: req.args.ref, step: "code", stage: "agent:code" } }) + "\n");
      }),
      // Mimics src/ops.js: recheck {ref} → one result, {all} → rechecked[]; close_on_board → completed.
      await fakeControl(RECHECKED.sockPath, (s, req) => {
        calls.recheck.push(req);
        const result =
          req.cmd === "close_on_board" ? { ref: req.args.ref, completed: true } : req.args.all ? { rechecked: [] } : { ref: req.args.ref, changed: [], unchanged: true };
        s.write(JSON.stringify({ id: req.id, ok: true, result }) + "\n");
      }),
      await fakeControl(RELEASED.sockPath, (s, req) => {
        calls.release.push(req);
        s.write(JSON.stringify({ id: req.id, ok: true, result: { ref: req.args.ref, step: "triage", queued: true } }) + "\n");
      }),
      // ops.js refuses a ref that is not held / is at its attempt cap with ok:false and its message.
      await fakeControl(RELEASE_REFUSED.sockPath, (s, req) => s.write(JSON.stringify({ id: req.id, ok: false, error: `${req.args.ref} cannot be released: not held` }) + "\n")),
      // Replies after the short restart timeout but inside the release one: release must wait.
      await fakeControl(RELEASE_SLOW.sockPath, (s, req) => setTimeout(() => s.write(JSON.stringify({ id: req.id, ok: true, result: { ref: req.args.ref, queued: true } }) + "\n"), RESTART_MS * 3)),
      await fakeControl(DIGESTED.sockPath, (s, req) => {
        calls.digest.push(req);
        const result =
          req.cmd === "summary"
            ? { ref: req.args.ref, lang: req.args.lang, text: "Resumen corto.", generatedAt: "2026-10-15T12:00:00Z" }
            : { text: "All quiet.", generatedAt: "2026-10-15T12:00:00Z", basedOnEvents: 0, needsYou: 0 };
        s.write(JSON.stringify({ id: req.id, ok: true, result }) + "\n");
      }),
      // Mimics src/ops.js: pause → paused; resume → the locked reply (ok:true + a note).
      await fakeControl(TOGGLED.sockPath, (s, req) => {
        calls.toggle.push(req);
        const result =
          req.cmd === "pause"
            ? { paused: true, active: 0, queued: 0 }
            : { paused: true, note: "a restart/decommission/shutdown holds the queue; not resumed", active: 0, queued: 0 };
        s.write(JSON.stringify({ id: req.id, ok: true, result }) + "\n");
      }),
      // Mimics src/ops.js ticket_add on the local adapter: {ref, step, stage[, blockedBy]}.
      await fakeControl(ADDED.sockPath, (s, req) => {
        calls.ticket.push(req);
        s.write(JSON.stringify({ id: req.id, ok: true, result: { ref: "42", step: "code", stage: "agent:code", ...(req.args.blockedBy?.length && { blockedBy: req.args.blockedBy }) } }) + "\n");
      }),
      // The local adapter's refusal is prefixed `local: ` (src/trackers/local.js).
      await fakeControl(ADDED_FAIL.sockPath, (s, req) => s.write(JSON.stringify({ id: req.id, ok: false, error: `local: no step "${req.args.step}" in the pipeline` }) + "\n")),
    );
  });
  test.after(() => Promise.all(fakes.map((f) => new Promise((r) => f.close(r)))));

  const server = createUiServer({ port: 0, token: TOKEN, distDir: path.join(root, "dist"), registry, discoverTimeoutMs: DISCOVER_MS, restartTimeoutMs: RESTART_MS, releaseTimeoutMs: RESTART_MS * 20 });
  const state = { port: 0 };
  test.before(async () => {
    await new Promise((r) => server.listen(0, "127.0.0.1", () => r(undefined)));
    const a = server.address();
    state.port = a && typeof a === "object" ? a.port : 0;
  });
  test.after(() => new Promise((r) => server.close(() => r(undefined))));

  /** A valid request's headers, with `o` overriding (null drops one). @param {Record<string, string|null>} [o] */
  function hdrs(o = {}) {
    /** @type {Record<string, string|null>} */
    const h = {
      host: `127.0.0.1:${state.port}`,
      cookie: `ah_ui=${TOKEN}`,
      origin: `http://127.0.0.1:${state.port}`,
      "x-ah-ui": "1",
      "content-type": "application/json",
      ...o,
    };
    return /** @type {Record<string, string>} */ (Object.fromEntries(Object.entries(h).filter(([, v]) => v !== null)));
  }

  /**
   * @param {string} method @param {string} p @param {string|null} body @param {Record<string, string|null>} [headers]
   * @returns {Promise<{ status: number, headers: http.IncomingHttpHeaders, body: string }>}
   */
  function request(method, p, body, headers = {}) {
    return new Promise((resolve, reject) => {
      const r = http.request({ host: "127.0.0.1", port: state.port, path: p, method, headers: hdrs(headers), setHost: false, agent: false }, (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode || 0, headers: res.headers, body: text }));
      });
      r.on("error", reject);
      r.end(body ?? undefined);
    });
  }

  return { root, registry, profiles, calls, hdrs, request };
}
