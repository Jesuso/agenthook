// The SENSITIVE_FIELDS diff behind the config editor's second confirm and the `PUT /api/config`
// audit line (docs/web-ui.md § v3). Import-free apart from contract.js: the browser bundles it
// (ui/src/contract.ts re-exports it), so the confirm dialog and the audit line can't disagree.
import { SENSITIVE_FIELDS } from "./contract.js";

/** Config paths whose value is a secret — each should be a `${VAR}` ref, never a literal.
 * `[*]` expands every element of an array. Re-exported by src/config.js; lives here so the config
 * editor's secret fields (ui/src/ConfigForms.tsx) bundle the same list. */
export const SECRET_FIELDS = /** @type {const} */ ([
  "tracker.token",
  "tracker.webhookSecret",
  "tracker.auth.privateKey",
  "forge.token",
  "forge.webhookSecret",
  "forge.auth.privateKey",
  "ingress.authtoken",
  "sinks[*].url",
  "sinks[*].botToken",
]);

/** Exactly one `${VAR}` ref — the only non-literal form a secret field may hold. @param {unknown} v @returns {boolean} */
export const isEnvRef = (v) => typeof v === "string" && /^\$\{[A-Z0-9_]+\}$/.test(v);

/**
 * The concrete SENSITIVE_FIELDS paths (e.g. "fullAuto", "sinks[1].botToken") whose value differs
 * between two raw configs, compared by JSON.stringify. `[*]` expands across the union of both
 * arrays' indices, a `*` segment across the union of both objects' keys. Pass `undefined` for an old config that didn't parse: every sensitive path
 * present in the new one is then reported.
 * @param {any} oldRaw @param {any} newRaw @returns {string[]}
 */
export function sensitiveChanges(oldRaw, newRaw) {
  /** @type {string[]} */
  const out = [];
  /** @param {any} node @param {string} key */
  const child = (node, key) => (node && typeof node === "object" && Object.hasOwn(node, key) ? node[key] : undefined);
  /** @param {any} a @param {any} b @param {string[]} segs @param {string} at */
  const walk = (a, b, segs, at) => {
    if (!segs.length) {
      if (JSON.stringify(a) !== JSON.stringify(b)) out.push(at);
      return;
    }
    const [seg, ...rest] = segs;
    if (seg.endsWith("[*]")) {
      const key = seg.slice(0, -3);
      const x = child(a, key);
      const y = child(b, key);
      const n = Math.max(Array.isArray(x) ? x.length : 0, Array.isArray(y) ? y.length : 0);
      for (let i = 0; i < n; i++) {
        walk(Array.isArray(x) ? x[i] : undefined, Array.isArray(y) ? y[i] : undefined, rest, `${at ? `${at}.` : ""}${key}[${i}]`);
      }
      return;
    }
    if (seg === "*") {
      /** @param {any} o */
      const keys = (o) => (o && typeof o === "object" && !Array.isArray(o) ? Object.keys(o) : []);
      for (const k of new Set([...keys(a), ...keys(b)])) walk(child(a, k), child(b, k), rest, at ? `${at}.${k}` : k);
      return;
    }
    walk(child(a, seg), child(b, seg), rest, at ? `${at}.${seg}` : seg);
  };
  for (const field of SENSITIVE_FIELDS) walk(oldRaw, newRaw, field.split("."), "");
  return out;
}
