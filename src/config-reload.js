// Config hot-reload (#725): the pure diff between the live `cfg` and a freshly loaded one.
// `agenthook reload` re-reads the config, diffs it against the running one and applies only
// the keys on a strict allowlist to runs that start after the reload; anything else is
// restart-required. Running agents keep the config they started with because reload *replaces*
// objects (never mutates the old ones a running run resolved).
//
// The diff is an allowlist: any differing key outside it is restart-required. Derived keys
// (paths, state-dir aliases, `provider`/`providerConfig`/`pipeline` — the latter two are aliases
// of `tracker`) are skipped here; the user key that derives them (`name`, `stateId`, `tracker`,
// `repos`) is itself compared and flagged restart-required when it changes.

/** Top-level user keys whose value changes take effect on the next run (not a restart). */
const TOP_RELOADABLE = new Set(["maxConcurrent", "quota"]);

/** Per-step fields that take effect on the next run. Everything else on a step is restart-required. */
const STEP_RELOADABLE = new Set(["harness", "routing", "model", "effort", "escalate", "lite", "instructionsFile", "egress", "maxConcurrent"]);

/** Keys `loadConfig` derives from `name`/`stateId`/`tracker`/`repos`/`configPath` — never diffed
 * directly; their user-facing source key is flagged instead. */
const DERIVED = new Set(["installDir", "configDir", "configPath", "stateKey", "stateDir", "dataDir", "logDir", "publicUrlFile", "pidFile", "heartbeatFile", "controlSock", "provider", "providerConfig", "pipeline", "multiRepo"]);

/** @param {unknown} v @returns {Record<string, unknown>} */
const asRecord = (v) => /** @type {Record<string, unknown>} */ (v);

/** @param {unknown} v @returns {string[]} */
const keysOf = (v) => Object.keys(asRecord(v));

/** Structural, key-order-insensitive deep equality over JSON-shaped values. @param {unknown} a @param {unknown} b */
function equal(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!equal(a[i], b[i])) return false;
    return true;
  }
  if (typeof a === "object") {
    const oa = asRecord(a);
    const ob = asRecord(b);
    const ka = Object.keys(oa);
    const kb = Object.keys(ob);
    if (ka.length !== kb.length) return false;
    for (const k of ka) if (!Object.hasOwn(ob, k) || !equal(oa[k], ob[k])) return false;
    return true;
  }
  return false;
}

/** @param {string[]} list @param {string} key */
const push = (list, key) => {
  if (!list.includes(key)) list.push(key);
};

/** @param {unknown} a @param {unknown} b @param {string[]} changed @param {string[]} restartRequired */
function diffSandbox(a, b, changed, restartRequired) {
  if (a == null && b == null) return;
  if (a == null || b == null) {
    push(restartRequired, "sandbox"); // adding or removing the whole block changes where runs execute
    return;
  }
  const ra = asRecord(a);
  const rb = asRecord(b);
  for (const key of new Set([...keysOf(a), ...keysOf(b)])) {
    if (equal(ra[key], rb[key])) continue;
    if (key === "egress") push(changed, "sandbox.egress");
    else push(restartRequired, `sandbox.${key}`);
  }
}

/** @param {unknown} a @param {unknown} b @param {string[]} changed @param {string[]} restartRequired */
function diffHarnesses(a, b, changed, restartRequired) {
  if (a == null && b == null) return;
  if (a == null || b == null) {
    // Adding the first harnesses block (or removing the last) fixes the quota mode and the
    // queue's harnessing at boot — not reloadable.
    push(restartRequired, "harnesses");
    return;
  }
  const ra = asRecord(a);
  const rb = asRecord(b);
  for (const name of new Set([...keysOf(a), ...keysOf(b)])) {
    const ca = ra[name];
    const cb = rb[name];
    if (ca === undefined || cb === undefined) {
      push(changed, `harnesses.${name}`);
      continue;
    }
    const cha = asRecord(ca);
    const chb = asRecord(cb);
    for (const field of new Set([...Object.keys(cha), ...Object.keys(chb)])) {
      if (equal(cha[field], chb[field])) continue;
      // ssh executors are built at boot — a `remote` change needs a restart.
      if (field === "remote") push(restartRequired, `harnesses.${name}.remote`);
      else push(changed, `harnesses.${name}`);
    }
  }
}

/** @param {unknown} a @param {unknown} b @param {string[]} changed @param {string[]} restartRequired */
function diffPipeline(a, b, changed, restartRequired) {
  const ca = Array.isArray(a) ? a : [];
  const cb = Array.isArray(b) ? b : [];
  const aIds = ca.map((s) => asRecord(s).id);
  const bIds = cb.map((s) => asRecord(s).id);
  if (!equal(aIds, bIds)) {
    // Adding, removing or reordering a step changes the stage bindings — restart only.
    push(restartRequired, "pipeline");
    return;
  }
  for (let i = 0; i < ca.length; i++) {
    const sa = asRecord(ca[i]);
    const sb = asRecord(cb[i]);
    const id = String(sa.id);
    for (const field of new Set([...Object.keys(sa), ...Object.keys(sb)])) {
      if (equal(sa[field], sb[field])) continue;
      if (field === "manual") push(restartRequired, "pipeline"); // a manual step runs no agent
      else if (STEP_RELOADABLE.has(field)) push(changed, `pipeline[${id}].${field}`);
      else push(restartRequired, `pipeline[${id}].${field}`);
    }
  }
}

/** @param {unknown} a @param {unknown} b @param {string[]} restartRequired */
function diffTracker(a, b, restartRequired) {
  if (a == null && b == null) return;
  if (a == null || b == null) {
    push(restartRequired, "tracker");
    return;
  }
  const ra = asRecord(a);
  const rb = asRecord(b);
  for (const key of new Set([...keysOf(a), ...keysOf(b)])) {
    if (key === "pipeline") continue; // handled by diffPipeline
    if (equal(ra[key], rb[key])) continue;
    push(restartRequired, `tracker.${key}`);
  }
}

/**
 * Diff the running config against a freshly loaded one. Returns the reloadable keys that
 * changed (dotted paths) and the keys that would require a restart. A reload applies nothing
 * unless `restartRequired` is empty; `changed` drives the queue/quota/override updates and the
 * `config_reloaded` event. Pure.
 * @param {import('./types/config.js').Config} cur
 * @param {import('./types/config.js').Config} next
 * @returns {{changed: string[], restartRequired: string[]}}
 */
export function diffConfig(cur, next) {
  /** @type {string[]} */ const changed = [];
  /** @type {string[]} */ const restartRequired = [];
  const c = asRecord(cur);
  const n = asRecord(next);

  for (const key of new Set([...Object.keys(c), ...Object.keys(n)])) {
    if (DERIVED.has(key)) continue;
    if (key === "sandbox" || key === "harnesses" || key === "pipeline" || key === "tracker") continue; // handled below
    if (equal(c[key], n[key])) continue;
    if (TOP_RELOADABLE.has(key)) push(changed, key);
    else push(restartRequired, key);
  }

  diffSandbox(c.sandbox, n.sandbox, changed, restartRequired);
  diffHarnesses(c.harnesses, n.harnesses, changed, restartRequired);
  diffPipeline(c.pipeline, n.pipeline, changed, restartRequired);
  diffTracker(c.tracker, n.tracker, restartRequired);

  return { changed, restartRequired };
}
