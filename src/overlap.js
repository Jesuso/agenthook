// File-overlap guard (opt-in, `cfg.overlapGuard`). Pure helpers — no I/O. The store
// holds the state (paths.json = predicted, locks.json = in-flight, overlap.json =
// waiting); dispatch gates on it and the engine releases it. Matching is structured
// only: exact path equality, or a directory prefix when an entry ends in `/`.

/** Cap on how many paths one verdict may report (a runaway list is truncated). */
export const MAX_PATHS = 200;

/**
 * Sanitise a verdict's `paths` to repo-relative strings: drop non-strings and empty
 * strings, strip a leading `./`, reject absolute paths and any `..` segment, dedupe,
 * cap at MAX_PATHS. Returns undefined when nothing survives (or `raw` isn't an array).
 * @param {unknown} raw
 * @returns {string[]|undefined}
 */
export function sanitizePaths(raw) {
  if (!Array.isArray(raw)) return undefined;
  /** @type {string[]} */
  const out = [];
  for (const p of raw) {
    if (typeof p !== "string") continue;
    let s = p.trim();
    while (s.startsWith("./")) s = s.slice(2);
    if (!s || s.startsWith("/") || s.startsWith("\\") || /^[A-Za-z]:/.test(s)) continue;
    if (s.split(/[\\/]/).includes("..")) continue;
    if (!out.includes(s)) out.push(s);
    if (out.length >= MAX_PATHS) break;
  }
  return out.length ? out : undefined;
}

/**
 * True when two paths collide: exact equality, or one ends in `/` (a directory) and
 * the other starts with it. Nothing fuzzy — `src` (no slash) never matches `src/a.js`.
 * @param {string} a @param {string} b
 */
export function pathsOverlap(a, b) {
  if (a === b) return true;
  if (a.endsWith("/") && b.startsWith(a)) return true;
  if (b.endsWith("/") && a.startsWith(b)) return true;
  return false;
}

/**
 * The first OTHER ref (stable key order) whose lock paths overlap any of `predicted`,
 * or undefined.
 * @param {string} ref
 * @param {string[]} predicted
 * @param {Record<string, import('./types.js').LockInfo>} locks
 * @returns {string|undefined}
 */
export function findBlocker(ref, predicted, locks) {
  if (!predicted.length) return undefined;
  for (const other of Object.keys(locks).sort()) {
    if (other === ref) continue;
    const held = locks[other]?.paths || [];
    if (predicted.some((p) => held.some((h) => pathsOverlap(p, h)))) return other;
  }
  return undefined;
}

/** Union of two path lists, order-preserving (a lock only ever grows). @param {string[]} a @param {string[]} b */
export function unionPaths(a, b) {
  return [...new Set([...a, ...b])];
}

/**
 * Refs waiting (overlap.json) on a blocker that holds no lock any more — stale holds
 * `reconcile` prunes before replaying.
 * @param {Record<string, import('./types.js').OverlapInfo>} overlap
 * @param {Record<string, import('./types.js').LockInfo>} locks
 * @returns {string[]}
 */
export function staleOverlaps(overlap, locks) {
  return Object.keys(overlap).filter((ref) => !(overlap[ref].blockedBy in locks));
}
