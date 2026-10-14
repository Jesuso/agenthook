// Shared fail-closed owner check for the tracker adapters' mutation gate. Pure: the
// adapter supplies one request (`fetchAssignee`); this owns retry + classification so a
// transient tracker hiccup (5xx/429/network) is retried and, if it persists, reported as
// "check_failed" — never confused with "assigned to someone else".

/** Thrown by an adapter's `advance` when it refuses to move a ticket. `reason` tells a
 * positive "not ours" apart from an owner check that could not complete. */
export class MoveRefusedError extends Error {
  /** @param {"not_ours"|"owner_check_failed"} reason @param {string} [message] */
  constructor(reason, message) {
    super(message ?? (reason === "not_ours" ? "not assigned to us" : "owner check failed"));
    this.name = "MoveRefusedError";
    this.code = "move_refused";
    this.reason = reason;
  }
}

/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Resolve whether a ticket is ours. Fail-closed: only a 2xx whose `mine` is true is "ours".
 * A thrown error, 5xx or 429 is retried (up to `attempts` calls, waiting `delays[i]` before
 * retry i+1); any other non-2xx — or retries exhausted — is "check_failed".
 * @param {() => Promise<{ok: boolean, status: number, mine?: boolean}>} fetchAssignee  one request
 * @param {{attempts?: number, delays?: number[]}} [opts]
 * @returns {Promise<"ours"|"not_ours"|"check_failed">}
 */
export async function checkOwner(fetchAssignee, { attempts = 3, delays = [250, 1000] } = {}) {
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(delays[Math.min(i - 1, delays.length - 1)] ?? 0);
    let r;
    try {
      r = await fetchAssignee();
    } catch {
      continue;
    }
    if (r.ok) return r.mine === true ? "ours" : "not_ours";
    if (r.status >= 500 || r.status === 429) continue;
    return "check_failed";
  }
  return "check_failed";
}
