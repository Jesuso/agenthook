// Per-harness token totals (named harnesses, #620). Import-free and pure, so the read model
// (src/agent-api.js), the CLI (`status`) and the digest snapshot can all share it.

/** @typedef {{ runs: number, input: number, output: number, cacheRead: number, cacheCreate: number }} HarnessTotal */

/** @param {unknown} v */
const tok = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);

/**
 * Sum token counts per harness over usage records (or run_end events — same field names).
 * Only records with a non-empty string `harness` count; null when none has one (a profile
 * without harnesses, or no harness run yet).
 * @param {Iterable<Record<string, any>>} recs
 * @returns {Record<string, HarnessTotal>|null}
 */
export function harnessTotals(recs) {
  /** @type {Record<string, HarnessTotal>} */
  const out = Object.create(null);
  let any = false;
  for (const r of recs) {
    const name = r?.harness;
    if (typeof name !== "string" || !name) continue;
    const t = (out[name] ??= { runs: 0, input: 0, output: 0, cacheRead: 0, cacheCreate: 0 });
    t.runs++;
    t.input += tok(r.input);
    t.output += tok(r.output);
    t.cacheRead += tok(r.cacheRead);
    t.cacheCreate += tok(r.cacheCreate);
    any = true;
  }
  return any ? { ...out } : null;
}
