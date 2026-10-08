// Guards against a regression where the test suite runs without `--import ./test/_setup.js`
// and `registryDir` resolves to the developer's real ~/.agenthook.
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { registryDir } from "../src/config.js";

test("registryDir is isolated under os.tmpdir(), not the real ~/.agenthook", () => {
  assert.notEqual(registryDir, path.join(os.homedir(), ".agenthook"));
  assert.equal(path.relative(os.tmpdir(), registryDir).startsWith(".."), false);
});
