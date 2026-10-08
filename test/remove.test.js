import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// `agenthook remove` — the testable core (removeProfile) over a temp registry with injected
// `ask`/`request`: the stopped archive + unregister hint, label/ambiguous/unknown resolution, the
// confirm prompt, --purge (and its refusal while running), and the running decommission path.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { archiveRoot, archiveStamp } from "../src/archive.js";
import { removeProfile } from "../src/commands/remove.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ah-remove-"));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

let n = 0;
/** A fresh registry holding the given state dirs. @param {Record<string, {name?: string, configPath?: string, running?: boolean}>} dirs */
function registryWith(dirs) {
  const registry = path.join(root, `reg${n++}`, ".agenthook");
  for (const [key, o] of Object.entries(dirs)) {
    const dir = path.join(registry, key);
    fs.mkdirSync(path.join(dir, "logs"), { recursive: true });
    fs.writeFileSync(path.join(dir, "queue.json"), "[]");
    if (o.name || o.configPath) fs.writeFileSync(path.join(dir, "profile.json"), JSON.stringify({ stateKey: key, name: o.name ?? key, configPath: o.configPath }));
    if (o.running) fs.writeFileSync(path.join(dir, "server.pid"), String(process.pid));
  }
  return registry;
}

/** Captured output + defaults that fail loudly if a prompt/request is unexpected. */
function harness(over = {}) {
  /** @type {string[]} */
  const out = [];
  /** @type {string[]} */
  const asked = [];
  return {
    out,
    asked,
    opts: {
      log: (/** @type {string} */ m) => out.push(m),
      error: (/** @type {string} */ m) => out.push(m),
      ask: async (/** @type {string} */ q) => {
        asked.push(q);
        throw new Error("unexpected ask");
      },
      request: async () => {
        throw new Error("unexpected request");
      },
      ...over,
    },
  };
}

/** @param {string} registry */
const archived = (registry) => (fs.existsSync(archiveRoot(registry)) ? fs.readdirSync(archiveRoot(registry)) : []);

test("stopped: archives to <registry>-archive/<key>-<stamp>, cli audit, unregister hint from profile.json", async () => {
  const registry = registryWith({ prof: { configPath: "/cfg/prof/agenthook.config.json" } });
  const { out, opts } = harness();
  const r = await removeProfile({ nameOrKey: "prof", yes: true, registry, ...opts });
  assert.equal(r.state, "archived");
  assert.equal(r.purged, false);
  assert.equal(path.dirname(r.archivedTo ?? ""), archiveRoot(registry));
  assert.match(path.basename(r.archivedTo ?? ""), /^prof-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d$/);
  assert.ok(!fs.existsSync(path.join(registry, "prof")));
  assert.equal(fs.readFileSync(path.join(r.archivedTo ?? "", "queue.json"), "utf8"), "[]");
  const audit = JSON.parse(fs.readFileSync(path.join(r.archivedTo ?? "", "ui-audit.jsonl"), "utf8").trim());
  assert.equal(audit.source, "cli");
  assert.equal(audit.reason, "remove");
  const text = out.join("\n");
  assert.match(text, /agenthook unregister --config \/cfg\/prof\/agenthook\.config\.json/);
  assert.match(text, /not touched/);
  assert.match(text, new RegExp(`archived .* → ${r.archivedTo?.replace(/[.\\]/g, "\\$&")}`));
});

test("stopped without profile.json: says config path unknown", async () => {
  const registry = registryWith({ legacy: {} });
  const { out, opts } = harness();
  await removeProfile({ nameOrKey: "legacy", yes: true, registry, ...opts });
  assert.match(out.join("\n"), /config path unknown/);
});

test("--keep-hooks: no unregister hint", async () => {
  const registry = registryWith({ prof: { configPath: "/cfg/x.json" } });
  const { out, opts } = harness();
  await removeProfile({ nameOrKey: "prof", yes: true, keepHooks: true, registry, ...opts });
  assert.doesNotMatch(out.join("\n"), /agenthook unregister/);
});

test("resolves by label; ambiguous label throws; unknown name throws and changes nothing", async () => {
  const registry = registryWith({ key1: { name: "pretty" }, a: { name: "dup" }, b: { name: "dup" } });
  const { opts } = harness();
  const r = await removeProfile({ nameOrKey: "pretty", yes: true, registry, ...opts });
  assert.equal(path.basename(r.archivedTo ?? "").startsWith("key1-"), true);

  await assert.rejects(removeProfile({ nameOrKey: "dup", yes: true, registry, ...opts }), /ambiguous/);
  await assert.rejects(removeProfile({ nameOrKey: "nope", yes: true, registry, ...opts }), /no profile "nope"/);
  assert.deepEqual(fs.readdirSync(registry).sort(), ["a", "b"]);
  assert.equal(archived(registry).length, 1);
});

test("missing name: usage error", async () => {
  const { opts } = harness();
  await assert.rejects(removeProfile({ registry: registryWith({}), ...opts }), /usage: agenthook remove <name\|key>/);
});

test("confirm: a wrong name throws and leaves the dir; the right name proceeds; --yes never asks", async () => {
  const registry = registryWith({ prof: { name: "label" } });
  /** @type {string[]} */
  const asked = [];
  const wrong = harness({ ask: async (/** @type {string} */ q) => (asked.push(q), "prof") }); // the key, not the label
  await assert.rejects(removeProfile({ nameOrKey: "prof", registry, ...wrong.opts }), /confirmation did not match — nothing changed/);
  assert.equal(asked[0], "Type the profile name to confirm: ");
  assert.ok(fs.existsSync(path.join(registry, "prof")));
  assert.equal(archived(registry).length, 0);

  const right = harness({ ask: async () => "  label \n" });
  const r = await removeProfile({ nameOrKey: "prof", registry, ...right.opts });
  assert.equal(r.state, "archived");
  assert.ok(!fs.existsSync(path.join(registry, "prof")));

  const reg2 = registryWith({ other: {} });
  const yes = harness(); // its ask throws if called
  assert.equal((await removeProfile({ nameOrKey: "other", yes: true, registry: reg2, ...yes.opts })).state, "archived");
  assert.equal(yes.asked.length, 0);
});

test("--purge: the second confirm deletes the archive; a wrong answer keeps it; --yes purges unprompted", async () => {
  const registry = registryWith({ prof: {} });
  const answers = ["prof", "prof"];
  const h = harness({ ask: async (/** @type {string} */ q) => (h.asked.push(q), answers.shift() ?? "") });
  const r = await removeProfile({ nameOrKey: "prof", purge: true, registry, ...h.opts });
  assert.equal(r.purged, true);
  assert.ok(r.archivedTo && !fs.existsSync(r.archivedTo));
  assert.match(h.asked[1], /PERMANENTLY delete/);
  assert.ok(h.out.includes(`deleted ${r.archivedTo}`));
  assert.ok(fs.existsSync(archiveRoot(registry)), "archive root itself is kept");

  const reg2 = registryWith({ prof: {} });
  const second = ["prof", "nope"];
  const h2 = harness({ ask: async () => second.shift() ?? "" });
  await assert.rejects(removeProfile({ nameOrKey: "prof", purge: true, registry: reg2, ...h2.opts }), /archive kept at/);
  assert.equal(archived(reg2).length, 1);
  assert.ok(!fs.existsSync(path.join(reg2, "prof")));

  const reg3 = registryWith({ prof: {} });
  const h3 = harness();
  const r3 = await removeProfile({ nameOrKey: "prof", purge: true, yes: true, registry: reg3, ...h3.opts });
  assert.equal(r3.purged, true);
  assert.equal(archived(reg3).length, 0);
  assert.equal(h3.asked.length, 0);
});

test("--purge while running: refused before any ask or request; nothing moves", async () => {
  const registry = registryWith({ live: { running: true } });
  let requested = false;
  const h = harness({ request: async () => ((requested = true), { ok: true, result: {} }) });
  await assert.rejects(removeProfile({ nameOrKey: "live", purge: true, registry, ...h.opts }), /is running — --purge needs a stopped receiver/);
  assert.equal(h.asked.length, 0);
  assert.equal(requested, false);
  assert.ok(fs.existsSync(path.join(registry, "live", "server.pid")));
  assert.equal(archived(registry).length, 0);
});

/** A `request` stub that asserts the decommission args, then plays the receiver: removes the
 * pidfile and renames the state dir into the archive root. */
function receiverStub(registry, key, { unregister = true } = {}) {
  /** @type {any[]} */
  const calls = [];
  const request = async (/** @type {string} */ sock, /** @type {string} */ cmd, /** @type {any} */ args) => {
    calls.push({ sock, cmd, args });
    assert.equal(cmd, "decommission");
    assert.deepEqual(args, { when: "idle", unregister });
    const dir = path.join(registry, key);
    fs.rmSync(path.join(dir, "server.pid"));
    fs.mkdirSync(archiveRoot(registry), { recursive: true });
    fs.renameSync(dir, path.join(archiveRoot(registry), `${key}-${archiveStamp()}`));
    return { ok: true, result: { accepted: true, active: 0, queued: 0 } };
  };
  return { calls, request };
}

test("running: sends decommission {when:'idle', unregister:true} and resolves archived with the archive path", async () => {
  const registry = registryWith({ live: { running: true } });
  const { calls, request } = receiverStub(registry, "live");
  const h = harness({ request });
  const r = await removeProfile({ nameOrKey: "live", yes: true, registry, ...h.opts });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sock, path.join(registry, "live", "control.sock"));
  assert.equal(r.state, "archived");
  assert.equal(r.archivedTo, path.join(archiveRoot(registry), archived(registry)[0]));
  assert.match(h.out.join("\n"), /waiting for 0 agent\(s\) to finish/);
});

test("running + --keep-hooks: unregister:false", async () => {
  const registry = registryWith({ live: { running: true } });
  const { request } = receiverStub(registry, "live", { unregister: false });
  const h = harness({ request });
  assert.equal((await removeProfile({ nameOrKey: "live", yes: true, keepHooks: true, registry, ...h.opts })).state, "archived");
});

test("running: ok:false or a down receiver throws and changes nothing", async () => {
  const registry = registryWith({ live: { running: true } });
  const notOk = harness({ request: async () => ({ ok: false, error: "decommission: a restart is pending" }) });
  await assert.rejects(removeProfile({ nameOrKey: "live", yes: true, registry, ...notOk.opts }), /a restart is pending — nothing changed/);
  const down = harness({
    request: async () => {
      throw Object.assign(new Error("down"), { code: "down" });
    },
  });
  await assert.rejects(removeProfile({ nameOrKey: "live", yes: true, registry, ...down.opts }), /receiver is down — nothing changed/);
  assert.ok(fs.existsSync(path.join(registry, "live", "server.pid")));
  assert.equal(archived(registry).length, 0);
});

test("running: no change before waitTimeoutMs resolves waiting", async () => {
  const registry = registryWith({ live: { running: true } });
  const h = harness({ request: async () => ({ ok: true, result: { accepted: true, active: 2, queued: 1 } }) });
  const r = await removeProfile({ nameOrKey: "live", yes: true, registry, waitTimeoutMs: 20, ...h.opts });
  assert.equal(r.state, "waiting");
  assert.equal(r.archivedTo, null);
  assert.match(h.out.join("\n"), /still waiting/);
  assert.ok(fs.existsSync(path.join(registry, "live")));
});

test("running: receiver exits without archiving → failed, with the logged archive error", async () => {
  const registry = registryWith({ live: { running: true } });
  const dir = path.join(registry, "live");
  fs.writeFileSync(path.join(dir, "receiver.log"), "[decommission] archive failed: old — before the request\n");
  const h = harness({
    request: async () => {
      fs.rmSync(path.join(dir, "server.pid"));
      fs.appendFileSync(path.join(dir, "receiver.log"), "[decommission] archive failed: EXDEV — state dir left at x\n");
      return { ok: true, result: { accepted: true, active: 0, queued: 0 } };
    },
  });
  const r = await removeProfile({ nameOrKey: "live", yes: true, registry, graceMs: 10, ...h.opts });
  assert.equal(r.state, "failed");
  const text = h.out.join("\n");
  assert.match(text, /archive failed: EXDEV/);
  assert.doesNotMatch(text, /archive failed: old/);
});
