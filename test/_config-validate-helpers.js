// Shared fixtures for the config-validate-*.test.js files (split from the former
// config-validate.test.js so no single test file costs ~50K tokens to read). Not matched by the
// `test/*.test.js` glob `npm test` runs, so it is never itself executed as a test file.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.js";

/** Minimal valid raw config; `over` replaces top-level keys (undefined deletes).
 * @param {any} [over] @param {any[]} [pipeline] @returns {any} */
export function raw(over = {}, pipeline = [{ id: "code" }]) {
  /** @type {any} */
  const cfg = { name: "ah-validate-test", repoPath: "/tmp/repo", tracker: { type: "asana", pipeline }, ...over };
  for (const k of Object.keys(cfg)) if (cfg[k] === undefined) delete cfg[k];
  return cfg;
}

/** The message loadConfig throws for a raw config (written to a temp file). @param {any} cfg */
export function loadError(cfg) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-cfg-validate-"));
  const file = path.join(dir, "agenthook.config.json");
  fs.writeFileSync(file, JSON.stringify(cfg));
  try {
    loadConfig({ configPath: file });
  } catch (e) {
    return e.message;
  }
  assert.fail(`loadConfig accepted ${JSON.stringify(cfg)}`);
}
