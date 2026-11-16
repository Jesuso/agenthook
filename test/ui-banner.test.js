import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
import test from "node:test";
import assert from "node:assert/strict";
import { uiBanner } from "../src/commands/ui.js";

test("uiBanner: a specific host prints one link line using that host, no loopback (#737)", () => {
  assert.deepEqual(uiBanner("192.168.68.2", 4180, "t"), ["agenthook ui at http://192.168.68.2:4180/?token=t"]);
  assert.deepEqual(uiBanner("127.0.0.1", 4180, "t"), ["agenthook ui at http://127.0.0.1:4180/?token=t"]);
  assert.deepEqual(uiBanner("::1", 4180, "t"), ["agenthook ui at http://[::1]:4180/?token=t"]);
});

test("uiBanner: a wildcard bind prints the loopback link plus one 'every interface' line (#737)", () => {
  const lines = uiBanner("0.0.0.0", 4180, "t", () => ["192.168.1.5", "10.0.0.2"]);
  assert.equal(lines.length, 2);
  assert.equal(lines[0], "agenthook ui at http://127.0.0.1:4180/?token=t");
  assert.equal(lines[1], "reachable on every interface (192.168.1.5, 10.0.0.2) at port 4180");
  for (const line of lines.slice(1)) assert.doesNotMatch(line, /http:\/\//);
});

test("uiBanner: an empty wildcard interface list still prints one 'every interface' line (#737)", () => {
  const lines = uiBanner("::", 4180, "t", () => []);
  assert.equal(lines.length, 2);
  assert.equal(lines[0], "agenthook ui at http://127.0.0.1:4180/?token=t");
  assert.equal(lines[1], "reachable on every interface at port 4180");
});
