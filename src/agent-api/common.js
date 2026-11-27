export const REASON_MAX = 200;

/** @param {any} v @param {number} n */
export const clip = (v, n) => (typeof v === "string" && v.length > n ? v.slice(0, n - 1) + "…" : v);
