// Shared fixtures for the ui-rows-*.test.js files (split from the former ui-rows.test.js
// so no single test file costs ~50K of context to read). Not matched by the
// `test/*.test.js` glob `npm test` runs, so it is never itself executed as a test file.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ah-ui-rows-"));

/** @param {string} dir @param {Record<string, any>} files */
export function writeState(dir, files) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, v] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), typeof v === "string" ? v : JSON.stringify(v));
  }
}

/** @param {Partial<import('../src/ui/rows.js').ProfileState>} s */
export const state = (s) => ({ running: {}, queue: [], held: {}, refmeta: {}, events: [], ...s });

/** @param {import('../src/shared/contract.js').TicketRow[]} rows @param {string} ref */
export const row = (rows, ref) => {
  const r = rows.find((x) => x.ref === ref);
  assert.ok(r, `row for ${ref}`);
  return r;
};
