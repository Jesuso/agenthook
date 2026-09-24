// Shared GitHub-style webhook signature check. Used by the GitHub tracker and the
// GitHub forge — both receive `x-hub-signature-256: sha256=<hex>` over the raw body.
import crypto from "node:crypto";

/**
 * Verify GitHub's `x-hub-signature-256: sha256=<hex>` HMAC over the raw body.
 * Constant-time compare; a missing secret or signature is a failure.
 * @param {string|undefined} secret @param {string} raw @param {string|string[]|undefined} sig
 * @returns {boolean}
 */
export function verifyHubSignature(secret, raw, sig) {
  const sigStr = Array.isArray(sig) ? sig[0] : sig;
  if (!secret || !sigStr) return false;
  const hex = sigStr.startsWith("sha256=") ? sigStr.slice(7) : sigStr;
  const computed = crypto.createHmac("sha256", secret).update(raw).digest("hex");
  const a = Buffer.from(computed);
  const b = Buffer.from(hex);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
