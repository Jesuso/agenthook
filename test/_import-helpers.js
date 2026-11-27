import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Shared import-parsing helpers for the boundary guard tests (shared-boundary, commands-boundary).
// Not matched by the `test/*.test.js` glob `npm test` runs.

export const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Every `from "..."`, `export ... from "..."` and `import("...")` specifier in `source`
 * (including a JSDoc `import('./x.js').Foo` type ref, same token shape as a dynamic import),
 * each tagged `typeOnly` when the statement is `import type`/`export type` (erased at build,
 * so it never reaches the bundle). @param {string} source
 * @returns {{spec: string, typeOnly: boolean}[]} */
export function importSpecifiers(source) {
  const out = [];
  const stmtRe = /\b(?:import|export)\b([^;]*?)from\s*["']([^"']+)["']/gs;
  for (const m of source.matchAll(stmtRe)) {
    const lead = m[1].trim().split(/\s+/)[0] ?? "";
    out.push({ spec: m[2], typeOnly: lead === "type" });
  }
  const callRe = /\bimport\(\s*["']([^"']+)["']/g;
  for (const m of source.matchAll(callRe)) out.push({ spec: m[1], typeOnly: false });
  const bareRe = /\bimport\s*["']([^"']+)["']/g;
  for (const m of source.matchAll(bareRe)) out.push({ spec: m[1], typeOnly: false });
  return out;
}

/** Resolve a relative import `spec` written inside the repo-relative file `fromFile`, as a
 * repo-relative posix path. `null` for a non-relative specifier (bare package or `node:*`).
 * @param {string} fromFile @param {string} spec @returns {string|null} */
export function resolveSpec(fromFile, spec) {
  if (!spec.startsWith(".")) return null;
  const dir = path.posix.dirname(fromFile);
  return path.posix.normalize(path.posix.join(dir, spec));
}

/** Recursively collect files under `dir` (repo-relative) whose name ends with one of `exts`.
 * @param {string} dir @param {string[]} exts @returns {string[]} */
export function walk(dir, exts) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  const files = [];
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const relPath = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(relPath, exts));
    else if (exts.some((ext) => entry.name.endsWith(ext))) files.push(relPath);
  }
  return files;
}
