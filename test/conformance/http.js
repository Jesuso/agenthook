// Tiny HTTP helpers shared by the tracker fixtures (test/fixtures/trackers/*.js): canned
// fetch Responses and the HMAC the webhook trackers sign deliveries with.
import crypto from "node:crypto";

/** A stubbed fetch Response. @param {number} status @param {any} [data] @returns {any} */
export const respond = (status, data = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => data, text: async () => JSON.stringify(data) });

/** A stubbed 200 JSON Response. @param {any} data */
export const ok = (data) => respond(200, data);

/** A stubbed 404 — what a fixture answers for any call it doesn't model. */
export const notFound = () => respond(404, { message: "Not Found" });

/** Hex HMAC-SHA256 of `body` under `secret`. @param {string} secret @param {string} body */
export const hmacHex = (secret, body) => crypto.createHmac("sha256", secret).update(body).digest("hex");

/** The request body of a recorded call, parsed (undefined when absent/unparseable).
 * @param {{body?: string}} call @returns {any} */
export function bodyOf(call) {
  try {
    return call.body ? JSON.parse(call.body) : undefined;
  } catch {
    return undefined;
  }
}
