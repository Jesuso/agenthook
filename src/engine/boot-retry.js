// Boot's retry for the one tracker call that isn't best-effort (`registerWebhook`). Pure — no
// provider names: an adapter reports an HTTP failure as an Error carrying a numeric `status`
// (see `Adapter.registerWebhook` in src/types.js), and a network/timeout failure as whatever
// fetch threw. A tracker outage must not kill the receiver: transient errors retry forever on a
// capped backoff; a 404 (a config-named id the tracker briefly forgets) retries a few times.

const NETWORK_CODE = /^(ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE|UND_ERR_\w*)$/;

/**
 * @param {any} e
 * @returns {"transient"|"not_found"|"fatal"}
 */
export function classifyTrackerError(e) {
  const status = e?.status;
  if (typeof status === "number") {
    if (status >= 500 || status === 429) return "transient";
    if (status === 404) return "not_found";
    return "fatal";
  }
  if (e?.name === "AbortError" || e?.name === "TimeoutError") return "transient";
  if ([e?.code, e?.cause?.code].some((c) => typeof c === "string" && NETWORK_CODE.test(c))) return "transient";
  if (e instanceof TypeError && e.message === "fetch failed") return "transient";
  return "fatal";
}

/** Transient backoff: 5 s, doubling, capped at 5 min. @param {number} attempt  0-based */
export function transientDelayMs(attempt) {
  return Math.min(5000 * 2 ** Math.min(attempt, 16), 300_000);
}

/** The waits before each 404 retry (3 retries over ~1 min), then the 404 is rethrown. */
export const NOT_FOUND_DELAYS_MS = [10_000, 20_000, 30_000];

/** setTimeout that rejects with the signal's reason as soon as it aborts.
 * @param {number} ms @param {AbortSignal} [signal] @returns {Promise<void>} */
export function abortableSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal?.reason);
    };
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Call `fn` until it resolves: transient → capped exponential backoff, indefinitely; not_found →
 * up to `delays.notFound.length` retries (counted across the whole call), then rethrow; fatal →
 * rethrow at once. Logs `[boot] tracker unavailable, retrying in <N>s (<message>)` and calls
 * `onWaiting` before every wait. An aborted `signal` rejects the wait promptly, with no further call.
 * @template T
 * @param {() => Promise<T>} fn
 * @param {{
 *   log?: (line: string) => void,
 *   onWaiting?: () => void,
 *   sleep?: (ms: number, signal?: AbortSignal) => Promise<void>,
 *   signal?: AbortSignal,
 *   delays?: {transient?: (attempt: number) => number, notFound?: number[]},
 * }} [opts]
 * @returns {Promise<T>}
 */
export async function retryTrackerCall(fn, { log = (l) => console.error(l), onWaiting = () => {}, sleep = abortableSleep, signal, delays = {} } = {}) {
  const transient = delays.transient ?? transientDelayMs;
  const notFound = delays.notFound ?? NOT_FOUND_DELAYS_MS;
  let transientAttempts = 0;
  let notFoundAttempts = 0;
  for (;;) {
    if (signal?.aborted) throw signal.reason;
    try {
      return await fn();
    } catch (e) {
      const kind = classifyTrackerError(e);
      /** @type {number} */
      let ms;
      if (kind === "transient") ms = transient(transientAttempts++);
      else if (kind === "not_found" && notFoundAttempts < notFound.length) ms = notFound[notFoundAttempts++];
      else throw e;
      log(`[boot] tracker unavailable, retrying in ${Math.round(ms / 1000)}s (${e?.message})`);
      onWaiting();
      await sleep(ms, signal);
    }
  }
}
