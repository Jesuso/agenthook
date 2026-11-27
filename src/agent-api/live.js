import { registryDir } from "../config/locations.js";
import { controlRequest, resolveProfileSock } from "../control/client.js";

/** Control-socket call budgets: board/PR reads hit the tracker/forge; reconcile/run/release can walk a whole board. */
export const LIVE_TIMEOUT_DEFAULT_MS = 20_000;
export const LIVE_TIMEOUT_MS = /** @type {Record<string, number>} */ ({ reconcile: 120_000, run: 60_000, catchup: 60_000, release: 60_000, cancel: 60_000, pull: 60_000, recheck: 120_000, close_on_board: 60_000 });

/** The control-socket budget for one op: its override, else the default. @param {string} cmd */
export function liveTimeoutMs(cmd) {
  return LIVE_TIMEOUT_MS[cmd] ?? LIVE_TIMEOUT_DEFAULT_MS;
}

/**
 * One control-socket request to a profile's live receiver.
 * @param {string} profile state key @param {string} cmd @param {any} args
 * @param {{registry?: string, timeoutMs?: number}} [o]
 * @returns {Promise<any>} the result; throws an Error whose message is agent-readable
 */
export async function live(profile, cmd, args, { registry = registryDir, timeoutMs } = {}) {
  const target = resolveProfileSock(registry, profile);
  if (!target) throw new Error(`unknown profile "${profile}"`);
  const limit = timeoutMs ?? LIVE_TIMEOUT_MS[cmd] ?? LIVE_TIMEOUT_DEFAULT_MS;
  let reply;
  try {
    reply = await controlRequest(target.sockPath, cmd, args, { timeoutMs: limit });
  } catch (e) {
    if (e.code === "timeout") {
      throw new Error(`${cmd}: no reply within ${limit / 1000}s — it may still be running; check status before retrying`);
    }
    const why = e.cause?.code;
    if (why === "ENOENT" || why === "ECONNREFUSED") {
      throw Object.assign(new Error(`receiver for "${profile}" is down — ${cmd} needs a live receiver (agenthook start)`), { code: "down" });
    }
    if (why === "EACCES" || why === "EPERM") throw new Error(`${cmd}: cannot open the control socket (${why}) — run as the user that owns the receiver`);
    throw new Error(`${cmd}: the control socket closed before replying (receiver restarting?) — check status before retrying`);
  }
  if (!reply.ok) throw new Error(reply.error);
  return reply.result;
}
