// --import target for `npm test`: isolates the test run's registry root into a throwaway
// tmp dir before src/config.js evaluates `registryDir`, so tests never touch ~/.agenthook.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

if (!process.env.AGENTHOOK_HOME) {
  process.env.AGENTHOOK_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agenthook-test-"));
}

// Never let a test read or write the real Hermes home (~/.hermes, or the dev's HERMES_HOME):
// an isolated hermes step copies `config.yaml` from here. Starts empty; tests plant files.
process.env.HERMES_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agenthook-test-hermes-"));
