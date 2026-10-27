// The webhook request handler: the fast-ACK-then-async shape. authenticate (sync, no
// network) → handshake reply / 401 / ACK 200 → processEvents off the response path → intake.
// `/forge` goes to the forge (when one is configured); everything else to the tracker.
import { isForgePath } from "../forges/index.js";

/** Job kinds that are signals, never queued work. */
const SIGNAL_KINDS = new Set(["ci_green", "epic_changed", "board_done"]);

/**
 * @param {{
 *   adapter: import('../types.js').Adapter,
 *   forge: import('../types.js').Forge | null,
 *   intake: (jobs: import('../types.js').Job[]) => unknown,
 *   ciGreen: (job: import('../types.js').Job) => unknown,
 *   epicChanged: (job: import('../types.js').Job) => unknown,
 *   boardDone: (job: import('../types.js').Job) => unknown,
 * }} deps
 * @returns {import('node:http').RequestListener}
 */
export function createRequestHandler({ adapter, forge, intake, ciGreen, epicChanged, boardDone }) {
  return (req, res) => {
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
      // A forge owns `/forge`; without one, `/forge` falls through to the tracker.
      const source = forge && isForgePath(pathname) ? forge : adapter;
      let auth;
      try {
        auth = source.authenticate(ctx);
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
      Promise.resolve(source.processEvents(ctx))
        .then((jobs) => {
          // `ci_green` / `epic_changed` / `board_done` are signals, not work: skip the queue
          // (see src/ci-green.js, src/epic-changed.js, src/board-done.js).
          for (const j of jobs || []) {
            if (j.kind === "ci_green") ciGreen(j);
            else if (j.kind === "epic_changed") epicChanged(j);
            else if (j.kind === "board_done") boardDone(j);
          }
          return intake((jobs || []).filter((j) => !SIGNAL_KINDS.has(j.kind)));
        }).catch((e) => console.error("[events]", e.message));
    });
  };
}
