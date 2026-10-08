import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { archiveRoot, archiveStamp, archiveStateDir } from "../src/archive.js";

const now = new Date("2026-10-08T12:34:56.789Z");

/** A fresh registry with one state dir `key` holding a couple of files. */
function registryWith(key = "prof") {
  const registry = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ah-archive-")), "reg");
  const dir = path.join(registry, key);
  fs.mkdirSync(path.join(dir, "logs"), { recursive: true });
  fs.writeFileSync(path.join(dir, "queue.json"), "[]");
  fs.writeFileSync(path.join(dir, "logs", "run.log"), "hello");
  return { registry, dir };
}

/** Throws matching `re`, and the registry + archive root are unchanged. */
function refuses(o, re) {
  const { registry } = o;
  const before = fs.existsSync(registry) ? fs.readdirSync(registry).sort() : null;
  const hadRoot = fs.existsSync(archiveRoot(registry));
  assert.throws(() => archiveStateDir({ now, reason: "test", source: "test", ...o }), re);
  assert.deepEqual(fs.existsSync(registry) ? fs.readdirSync(registry).sort() : null, before);
  if (!hadRoot) assert.ok(!fs.existsSync(archiveRoot(registry)) || fs.readdirSync(archiveRoot(registry)).length === 0);
}

test("archiveRoot is <registry>-archive; archiveStamp is UTC YYYY-MM-DDTHH-MM-SS", () => {
  assert.equal(archiveRoot("/x/.agenthook"), "/x/.agenthook-archive");
  assert.equal(archiveStamp(now), "2026-10-08T12-34-56");
});

test("moves the dir intact into a 0700 archive root and audits it there", () => {
  const { registry, dir } = registryWith("prof");
  const { archivedTo } = archiveStateDir({ stateKey: "prof", registry, reason: "decommission", source: "decommission", now });
  assert.equal(archivedTo, path.join(`${registry}-archive`, "prof-2026-10-08T12-34-56"));
  assert.ok(!fs.existsSync(dir), "source gone");
  assert.equal(fs.readFileSync(path.join(archivedTo, "queue.json"), "utf8"), "[]");
  assert.equal(fs.readFileSync(path.join(archivedTo, "logs", "run.log"), "utf8"), "hello");
  if (process.platform !== "win32") assert.equal(fs.statSync(archiveRoot(registry)).mode & 0o777, 0o700);
  const lines = fs.readFileSync(path.join(archivedTo, "ui-audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 1);
  const { ts, ...rest } = lines[0];
  assert.ok(!Number.isNaN(Date.parse(ts)));
  assert.deepEqual(rest, { action: "remove", stateKey: "prof", reason: "decommission", source: "decommission" });
});

test("refuses a live receiver (pidfile = this process)", () => {
  const { registry, dir } = registryWith("live");
  fs.writeFileSync(path.join(dir, "server.pid"), String(process.pid));
  refuses({ stateKey: "live", registry }, /is running/);
  assert.ok(fs.existsSync(dir));
});

test("a stale pidfile does not block the archive", () => {
  const { registry, dir } = registryWith("stale");
  fs.writeFileSync(path.join(dir, "server.pid"), "999999999");
  assert.ok(archiveStateDir({ stateKey: "stale", registry, now }).archivedTo);
});

test("refuses a missing dir or a non-directory", () => {
  const { registry } = registryWith("there");
  refuses({ stateKey: "nope", registry }, /does not exist/);
  fs.writeFileSync(path.join(registry, "afile"), "x");
  refuses({ stateKey: "afile", registry }, /not a directory/);
});

test("refuses '.', '..' and invalid keys", () => {
  const { registry } = registryWith("k");
  for (const stateKey of [".", "..", "", "a/b", "has space", "../k", /** @type {any} */ (undefined)]) {
    refuses({ stateKey, registry }, /not a valid state key/);
  }
});

test("refuses an existing target", () => {
  const { registry, dir } = registryWith("dup");
  fs.mkdirSync(path.join(archiveRoot(registry), "dup-2026-10-08T12-34-56"), { recursive: true });
  refuses({ stateKey: "dup", registry }, /already exists/);
  assert.ok(fs.existsSync(dir));
});

test("refuses a state dir on a different filesystem than the archive root", () => {
  const { registry, dir } = registryWith("dev");
  const real = fs.statSync;
  const m = mock.method(fs, "statSync", (/** @type {any} */ f, /** @type {any} */ o) => {
    const st = real(f, o);
    return f === dir ? { ...st, isDirectory: () => st.isDirectory(), dev: st.dev + 1 } : st;
  });
  try {
    assert.throws(() => archiveStateDir({ stateKey: "dev", registry, now }), /different filesystem/);
  } finally {
    m.mock.restore();
  }
  assert.ok(fs.existsSync(dir), "nothing moved");
  assert.deepEqual(fs.readdirSync(archiveRoot(registry)), []);
});
