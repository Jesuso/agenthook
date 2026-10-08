import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// `rename --move`'s shared core (src/state-move.js): checkMove refusals leave nothing moved;
// moveStateDir renames the dir, rewrites/drops stateId, rolls back a failed config write; the
// successor boots on the new key, and a crash between the move and the config write is caught
// by the r1 boot check. Uses the real test registry: loadConfig derives stateDir from it.
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, registryDir } from "../src/config.js";
import { claimStateDir, readMarker } from "../src/profile.js";
import { spawnDetached } from "../src/respawn.js";
import { checkMove, moveStateDir } from "../src/state-move.js";

const registry = registryDir;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "ah-move-"));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const json = (v) => JSON.stringify(v, null, 2) + "\n";

/** A booted profile: config file, state dir (stamped profile.json) holding some state.
 * @param {{name: string, stateId?: string}} o */
function profile({ name, stateId }) {
  const configPath = path.join(fs.mkdtempSync(path.join(root, "cfg-")), "agenthook.config.json");
  /** @type {any} */
  const raw = { name, repoPath: "/repo", tracker: { type: "github", pipeline: [{ id: "code" }] } };
  if (stateId) raw.stateId = stateId;
  fs.writeFileSync(configPath, json(raw));
  const cfg = loadConfig({ configPath });
  claimStateDir(cfg, registry);
  fs.writeFileSync(path.join(cfg.stateDir, "seen.json"), "[]");
  fs.writeFileSync(path.join(cfg.stateDir, "events.jsonl"), '{"event":"x"}\n');
  fs.writeFileSync(path.join(cfg.logDir, "run.log"), "log");
  return { configPath, stateKey: cfg.stateKey, stateDir: cfg.stateDir };
}

const read = (p) => JSON.parse(fs.readFileSync(p, "utf8"));

test("move after a label rename: dir renamed with its state, stateId dropped, old dir gone", () => {
  const p = profile({ name: "mv-label", stateId: "mv-old" });
  const before = fs.readFileSync(p.configPath, "utf8");
  const { stateDir } = moveStateDir({ configPath: p.configPath, from: "mv-old", to: "mv-label", registry });
  assert.equal(stateDir, path.join(registry, "mv-label"));
  assert.equal(fs.existsSync(p.stateDir), false);
  for (const f of ["seen.json", "events.jsonl", "logs/run.log"]) assert.ok(fs.existsSync(path.join(stateDir, f)), f);
  assert.equal(read(p.configPath).stateId, undefined);
  assert.equal(read(p.configPath).name, "mv-label");
  // backup + audit live in the new dir
  const bak = fs.readdirSync(path.join(stateDir, "config-bak"));
  assert.equal(fs.readFileSync(path.join(stateDir, "config-bak", bak[0]), "utf8"), before);
  const audit = fs.readFileSync(path.join(stateDir, "ui-audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(
    (({ source, action, from, to }) => ({ source, action, from, to }))(audit.at(-1)),
    { source: "cli", action: "move", from: "mv-old", to: "mv-label" },
  );
  assert.equal(readMarker(stateDir).stateKey, "mv-label");
});

test("move to a key other than the label: stateId rewritten", () => {
  const p = profile({ name: "mv-keep-label" });
  moveStateDir({ configPath: p.configPath, from: "mv-keep-label", to: "mv-elsewhere", registry, source: "restart" });
  assert.equal(read(p.configPath).stateId, "mv-elsewhere");
  assert.ok(fs.existsSync(path.join(registry, "mv-elsewhere", "seen.json")));
  assert.equal(fs.existsSync(p.stateDir), false);
});

test("successor boots on the new dir: loadConfig resolves it, claimStateDir passes, profile.json updated", () => {
  const p = profile({ name: "mv-boot", stateId: "mv-boot-old" });
  moveStateDir({ configPath: p.configPath, from: "mv-boot-old", to: "mv-boot", registry });
  const cfg = loadConfig({ configPath: p.configPath });
  assert.equal(cfg.stateDir, path.join(registry, "mv-boot"));
  assert.doesNotThrow(() => claimStateDir(cfg, registry));
  assert.equal(readMarker(cfg.stateDir).stateKey, "mv-boot");
  assert.equal(fs.existsSync(p.stateDir), false, "old dir not recreated");
});

test("crash between the move and the config write: the next boot is refused naming the new stateId", () => {
  const p = profile({ name: "mv-crash", stateId: "mv-crash-old" });
  fs.renameSync(p.stateDir, path.join(registry, "mv-crash-new")); // died before the config write
  const cfg = loadConfig({ configPath: p.configPath }); // recreates an empty old dir
  assert.throws(() => claimStateDir(cfg, registry), /"stateId": "mv-crash-new"/);
});

test("the respawn logs into the new dir and the old one is not recreated", () => {
  const p = profile({ name: "mv-spawn", stateId: "mv-spawn-old" });
  const { stateDir } = moveStateDir({ configPath: p.configPath, from: "mv-spawn-old", to: "mv-spawn", registry });
  const { logPath } = spawnDetached({ stateDir }, { command: process.execPath, args: ["-e", ""] });
  assert.equal(logPath, path.join(registry, "mv-spawn", "receiver.log"));
  assert.ok(fs.existsSync(logPath));
  assert.equal(fs.existsSync(p.stateDir), false);
});

/** Assert a refusal leaves the dir and the config exactly as they were. */
function refuses(p, to, re) {
  const before = fs.readFileSync(p.configPath, "utf8");
  assert.throws(() => moveStateDir({ configPath: p.configPath, from: p.stateKey, to, registry }), re);
  assert.ok(fs.existsSync(path.join(p.stateDir, "seen.json")));
  assert.equal(fs.readFileSync(p.configPath, "utf8"), before);
}

test("refuses: target dir exists", () => {
  const p = profile({ name: "mv-ref-exists", stateId: "mv-ref-exists-old" });
  fs.mkdirSync(path.join(registry, "mv-ref-exists"));
  refuses(p, "mv-ref-exists", /already exists/);
});

test("refuses: another profile's label or state key", () => {
  profile({ name: "mv-other-label", stateId: "mv-other-key" });
  const p = profile({ name: "mv-ref-col", stateId: "mv-ref-col-old" });
  refuses(p, "mv-other-label", /collides/);
  refuses(p, "mv-other-key", /already exists|collides/);
});

test("refuses: invalid name, same key, config keyed elsewhere", () => {
  const p = profile({ name: "mv-ref-bad", stateId: "mv-ref-bad-old" });
  refuses(p, "has space", /must match/);
  refuses(p, "mv-ref-bad-old", /already/);
  assert.throws(() => checkMove({ configPath: p.configPath, from: "not-this", to: "mv-ref-bad", registry }), /keys state "mv-ref-bad-old"/);
});

test("refuses: state dir on a different filesystem than the registry", () => {
  const p = profile({ name: "mv-ref-dev", stateId: "mv-ref-dev-old" });
  const real = fs.statSync;
  const m = mock.method(fs, "statSync", (/** @type {any} */ f, /** @type {any} */ o) => {
    const st = real(f, o);
    return f === p.stateDir ? { ...st, dev: st.dev + 1 } : st;
  });
  try {
    refuses(p, "mv-ref-dev", /different filesystem/);
  } finally {
    m.mock.restore();
  }
});

test("a failed config write rolls the dir back", () => {
  const p = profile({ name: "mv-rollback", stateId: "mv-rollback-old" });
  const before = fs.readFileSync(p.configPath, "utf8");
  assert.throws(
    () => moveStateDir({ configPath: p.configPath, from: p.stateKey, to: "mv-rollback", registry, save: () => ({ status: 500 }) }),
    /failed to save/,
  );
  assert.ok(fs.existsSync(path.join(p.stateDir, "seen.json")));
  assert.equal(fs.existsSync(path.join(registry, "mv-rollback")), false);
  assert.equal(fs.readFileSync(p.configPath, "utf8"), before);
});
