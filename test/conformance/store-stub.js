// Shared in-memory Store stub for the tracker conformance suite (the same shape the
// per-tracker tests copy-paste). Secrets are real (handshake / webhook-secret paths
// read them back), and so are held records (the `@agent` resume reads them); everything
// else is inert — nothing is ever seen or queued.

/** Minimal in-memory Store stub. @returns {any} */
export function makeStore() {
  const secrets = new Map();
  const held = new Map();
  return {
    getSecret: (/** @type {string} */ k) => secrets.get(k),
    setSecret: (/** @type {string} */ k, /** @type {string} */ v) => secrets.set(k, v),
    secretCount: () => secrets.size,
    reloadSeen() {},
    hasSeen: () => false,
    markSeen() {},
    unmarkSeen() {},
    seenCount: () => 0,
    seenFile: "",
    setRunning() {},
    clearRunning() {},
    listRunning: () => ({}),
    addQueued() {},
    removeQueued() {},
    listQueued: () => [],
    getAttempt: () => 0,
    bumpAttempt: () => 0,
    clearAttempts() {},
    getHeld: (/** @type {string} */ ref) => held.get(ref),
    setHeld: (/** @type {string} */ ref, /** @type {any} */ h) => held.set(ref, h),
    clearHeld: (/** @type {string} */ ref) => held.delete(ref),
  };
}
