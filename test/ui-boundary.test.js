import "./_setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ROOT, importSpecifiers, resolveSpec, walk } from "./_import-helpers.js";

// Guards the src/ui/ and src/reader/ boundaries (epic #839, ticket 8): src/ui/ is the panel's
// server, entered only through src/commands/ui.js; src/reader/ holds the profile state readers
// every other area pulls from, and must not reach back into either the panel or the CLI layer.

const ALLOWED_INTO_UI = new Set(["src/commands/ui.js:../ui/server.js"]);

/** Rule A: no non-type-only import in a src/**\/*.js file outside src/ui/ may resolve into
 * src/ui/, unless allow-listed. Returns violation strings ("<file>: <spec>"), empty when
 * clean. @param {string} file @param {string} source */
export function uiViolations(file, source) {
  const violations = [];
  for (const { spec, typeOnly } of importSpecifiers(source)) {
    if (typeOnly) continue;
    const resolved = resolveSpec(file, spec);
    if (resolved === null || !resolved.startsWith("src/ui/")) continue;
    if (ALLOWED_INTO_UI.has(`${file}:${spec}`)) continue;
    violations.push(`${file}: ${spec}`);
  }
  return violations;
}

/** Rule B: no import (type-only included) in a src/reader/**\/*.js file may resolve into
 * src/ui/ or src/commands/. Returns violation strings, empty when clean.
 * @param {string} file @param {string} source */
export function readerViolations(file, source) {
  const violations = [];
  for (const { spec } of importSpecifiers(source)) {
    const resolved = resolveSpec(file, spec);
    if (resolved === null) continue;
    if (resolved.startsWith("src/ui/") || resolved.startsWith("src/commands/")) violations.push(`${file}: ${spec}`);
  }
  return violations;
}

test("uiViolations: flags a non-exempt import reaching into src/ui/ and ignores type-only", () => {
  assert.deepEqual(uiViolations("src/ops.js", `import { createUiServer } from "./ui/server.js";`), [
    "src/ops.js: ./ui/server.js",
  ]);
  assert.deepEqual(uiViolations("src/ops.js", `import type { Foo } from "./ui/server.js";`), []);
});

test("uiViolations: allow-lists the ui entrypoint and flags the former save.js removal exceptions", () => {
  assert.deepEqual(uiViolations("src/commands/ui.js", `import { createUiServer } from "../ui/server.js";`), []);
  assert.deepEqual(uiViolations("src/archive.js", `import { atomicSave } from "./ui/save.js";`), ["src/archive.js: ./ui/save.js"]);
});

test("readerViolations: flags a src/reader/ import reaching into src/ui/ or src/commands/, type-only included", () => {
  assert.deepEqual(readerViolations("src/reader/rows.js", `import { DEBOUNCE_MS } from "../ui/watch.js";`), [
    "src/reader/rows.js: ../ui/watch.js",
  ]);
  assert.deepEqual(readerViolations("src/reader/rows.js", `import type { Fix } from "../commands/doctor.js";`), [
    "src/reader/rows.js: ../commands/doctor.js",
  ]);
  assert.deepEqual(readerViolations("src/reader/rows.js", `import { costOf } from "../shared/pricing.js";`), []);
});

test("src/: no file outside src/ui/ reaches into src/ui/ except the allow-listed exceptions", () => {
  const violations = [];
  for (const file of walk("src", [".js"])) {
    if (file.startsWith("src/ui/")) continue;
    const source = fs.readFileSync(path.join(ROOT, file), "utf8");
    violations.push(...uiViolations(file, source));
  }
  assert.deepEqual(violations, []);
});

test("src/reader/: no file imports from src/ui/ or src/commands/", () => {
  const violations = [];
  for (const file of walk("src/reader", [".js"])) {
    const source = fs.readFileSync(path.join(ROOT, file), "utf8");
    violations.push(...readerViolations(file, source));
  }
  assert.deepEqual(violations, []);
});
