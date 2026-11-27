import "./_setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Guards the src/shared/ boundary (epic #839, ticket 3): modules the browser bundles at
// runtime live in src/shared/, stay free of Node code, and the browser never reaches into
// src/ outside it.

const ROOT = fileURLToPath(new URL("..", import.meta.url));

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
function walk(dir, exts) {
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

const ALLOWED_OUTSIDE = new Set(["src/agents/names.js", "src/sandbox/names.js"]);

/** Rule A: every import in a src/shared/*.js file must resolve inside src/shared/, or be
 * exactly one of ALLOWED_OUTSIDE — no `node:`/bare specifier either. Returns violation
 * strings ("<file>: <spec>"), empty when clean. @param {string} file @param {string} source */
export function sharedViolations(file, source) {
  const violations = [];
  for (const { spec } of importSpecifiers(source)) {
    const resolved = resolveSpec(file, spec);
    if (resolved === null) {
      violations.push(`${file}: ${spec} (not relative)`);
      continue;
    }
    if (resolved.startsWith("src/shared/")) continue;
    if (ALLOWED_OUTSIDE.has(resolved)) continue;
    violations.push(`${file}: ${spec}`);
  }
  return violations;
}

const UI_EXCEPTIONS = new Set(["ui/src/summary.test.ts:../../src/epics.js"]);

/** Rule B: a non-type-only import in a ui/src/ file must not resolve into src/ outside
 * src/shared/, apart from UI_EXCEPTIONS. Returns violation strings, empty when clean.
 * @param {string} file @param {string} source */
export function uiViolations(file, source) {
  const violations = [];
  for (const { spec, typeOnly } of importSpecifiers(source)) {
    if (typeOnly) continue;
    const resolved = resolveSpec(file, spec);
    if (resolved === null || !resolved.startsWith("src/")) continue;
    if (resolved.startsWith("src/shared/")) continue;
    if (UI_EXCEPTIONS.has(`${file}:${spec}`)) continue;
    violations.push(`${file}: ${spec}`);
  }
  return violations;
}

test("importSpecifiers: finds from-imports, export-from, dynamic import(), skips type-only in typeOnly", () => {
  const src = `
import { a } from "./a.js";
import type { B } from "./b.js";
export { c } from "./c.js";
export type { D } from "./d.js";
const e = await import("./e.js");
/** @type {import('./f.js').F} */
`;
  const specs = importSpecifiers(src).map((s) => [s.spec, s.typeOnly]);
  assert.deepEqual(specs.sort(), [
    ["./a.js", false],
    ["./b.js", true],
    ["./c.js", false],
    ["./d.js", true],
    ["./e.js", false],
    ["./f.js", false],
  ].sort());
});

test("resolveSpec: relative specs resolve repo-relative, bare/node: specs are null", () => {
  assert.equal(resolveSpec("src/shared/sensitive.js", "./contract.js"), "src/shared/contract.js");
  assert.equal(resolveSpec("src/shared/config-schema.js", "../agents/names.js"), "src/agents/names.js");
  assert.equal(resolveSpec("ui/src/contract.ts", "../../src/shared/contract.js"), "src/shared/contract.js");
  assert.equal(resolveSpec("src/shared/quota.js", "node:fs"), null);
  assert.equal(resolveSpec("src/shared/quota.js", "lodash"), null);
});

test("sharedViolations: flags a node: import, a bare package, and an outside relative import", () => {
  assert.deepEqual(sharedViolations("src/shared/quota.js", `import fs from "node:fs";`), [
    "src/shared/quota.js: node:fs (not relative)",
  ]);
  assert.deepEqual(sharedViolations("src/shared/quota.js", `import x from "lodash";`), [
    "src/shared/quota.js: lodash (not relative)",
  ]);
  assert.deepEqual(sharedViolations("src/shared/quota.js", `import { x } from "../store.js";`), [
    "src/shared/quota.js: ../store.js",
  ]);
});

test("sharedViolations: allows imports within src/shared/ and the two allow-listed name lists", () => {
  assert.deepEqual(sharedViolations("src/shared/sensitive.js", `import { X } from "./contract.js";`), []);
  assert.deepEqual(
    sharedViolations("src/shared/config-schema.js", `import { AGENT_NAMES } from "../agents/names.js";`),
    [],
  );
});

test("uiViolations: flags a runtime import reaching into src/ outside src/shared/", () => {
  assert.deepEqual(uiViolations("ui/src/foo.ts", `import { isNeedsYou } from "../../src/epics.js";`), [
    "ui/src/foo.ts: ../../src/epics.js",
  ]);
});

test("uiViolations: allows type-only imports, src/shared/ imports, and the summary.test.ts exception", () => {
  assert.deepEqual(uiViolations("ui/src/foo.ts", `import type { X } from "../../src/epics.js";`), []);
  assert.deepEqual(uiViolations("ui/src/foo.ts", `import { x } from "../../src/shared/quota.js";`), []);
  assert.deepEqual(
    uiViolations("ui/src/summary.test.ts", `import { isNeedsYou } from "../../src/epics.js";`),
    [],
  );
});

test("src/shared/*.js: every real file in the tree stays inside the boundary (rule A)", () => {
  const violations = [];
  for (const file of walk("src/shared", [".js"])) {
    const source = fs.readFileSync(path.join(ROOT, file), "utf8");
    violations.push(...sharedViolations(file, source));
  }
  assert.deepEqual(violations, []);
});

test("src/agents/names.js and src/sandbox/names.js stay import-free", () => {
  for (const file of ["src/agents/names.js", "src/sandbox/names.js"]) {
    const source = fs.readFileSync(path.join(ROOT, file), "utf8");
    assert.deepEqual(importSpecifiers(source), [], `${file} must have no imports`);
  }
});

test("ui/src/: no real file reaches into src/ outside src/shared/ (rule B)", () => {
  const violations = [];
  for (const file of walk("ui/src", [".ts", ".tsx"])) {
    const source = fs.readFileSync(path.join(ROOT, file), "utf8");
    violations.push(...uiViolations(file, source));
  }
  assert.deepEqual(violations, []);
});
