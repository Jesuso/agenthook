// CLI router — `<command> --help`/`-h` must resolve to usage, never run the
// command (e.g. `start --help` must not boot the receiver). Pure arg-layer
// check; importing the bin does not run `main()` (it's gated to direct invoke).
import test from "node:test";
import assert from "node:assert/strict";
import { wantsHelp } from "../bin/agenthook.js";

test("wantsHelp flags --help/-h anywhere in the post-command args", () => {
  assert.equal(wantsHelp(["--help"]), true);
  assert.equal(wantsHelp(["-h"]), true);
  assert.equal(wantsHelp(["--detach", "--help"]), true); // start --detach --help
  assert.equal(wantsHelp(["19", "--force", "-h"]), true); // catchup <ref> --force -h
});

test("wantsHelp is false for real flags and bare args", () => {
  assert.equal(wantsHelp([]), false);
  assert.equal(wantsHelp(["--detach"]), false); // start --detach
  assert.equal(wantsHelp(["--all"]), false); // agents --all
  assert.equal(wantsHelp(["--config", "x.json"]), false);
  assert.equal(wantsHelp(["19"]), false); // run <ref>
});
