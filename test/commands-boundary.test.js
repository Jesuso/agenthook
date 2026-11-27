import "./_setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ROOT, importSpecifiers, resolveSpec, walk } from "./_import-helpers.js";

// Guards the src/commands/ boundary (epic #839, ticket 6): src/commands/ is the outermost
// layer, one file per CLI subcommand, imported only by bin/. No module outside src/commands/
// may import from it — logic the core needs lives in the core, and commands call it.

const ALLOWED_OUTSIDE = new Set();

/** Returns violation strings ("<file>: <spec>") for every non-type-only import in a
 * src/**\/*.js file (outside src/commands/) that resolves into src/commands/, unless
 * allow-listed. @param {string} file @param {string} source */
export function commandsViolations(file, source) {
  const violations = [];
  for (const { spec, typeOnly } of importSpecifiers(source)) {
    if (typeOnly) continue;
    const resolved = resolveSpec(file, spec);
    if (resolved === null || !resolved.startsWith("src/commands/")) continue;
    if (ALLOWED_OUTSIDE.has(`${file}:${spec}`)) continue;
    violations.push(`${file}: ${spec}`);
  }
  return violations;
}

test("commandsViolations: flags an import reaching into src/commands/", () => {
  assert.deepEqual(commandsViolations("src/ops.js", `import { entryBlock } from "./commands/run.js";`), [
    "src/ops.js: ./commands/run.js",
  ]);
});

test("commandsViolations: flags a non-exempt import and ignores type-only imports", () => {
  assert.deepEqual(commandsViolations("src/ui/sandbox.js", `import { execRun } from "../commands/doctor.js";`), [
    "src/ui/sandbox.js: ../commands/doctor.js",
  ]);
  assert.deepEqual(commandsViolations("src/engine/boot.js", `import type { Fix } from "../commands/doctor.js";`), []);
});

test("src/: no file outside src/commands/ reaches into src/commands/", () => {
  const violations = [];
  for (const file of walk("src", [".js"])) {
    if (file.startsWith("src/commands/")) continue;
    const source = fs.readFileSync(path.join(ROOT, file), "utf8");
    violations.push(...commandsViolations(file, source));
  }
  assert.deepEqual(violations, []);
});
