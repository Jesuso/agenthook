// `ah ui` realtime watcher — dir-watch debounce + hash dedupe, the torn-read rule,
// events.jsonl offset tailing, registry add/remove, and control-socket liveness.
// Temp dirs + a local unix socket only; every watcher/socket is closed in `after`.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createWatcher } from "../src/ui/watch.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ah-ui-watch-"));
/** @type {(() => void)[]} */
const cleanups = [];
test.after(() => {
  for (const c of cleanups.reverse()) c();
  fs.rmSync(root, { recursive: true, force: true });
});

const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
const SETTLE = 250; // several debounce windows

let n = 0;
/** A fresh registry with the given profile dirs, plus a watcher recording every event. @param {string[]} [dirs] */
function setup(dirs = ["p"]) {
  const registry = path.join(root, `r${n++}`);
  fs.mkdirSync(registry);
  for (const d of dirs) fs.mkdirSync(path.join(registry, d), { recursive: true });
  /** @type {import('../src/ui/contract.js').UiEvent[]} */
  const events = [];
  const w = createWatcher(registry, (ev) => events.push(ev));
  cleanups.push(() => w.close());
  /** @param {(ev: any) => boolean} pred */
  const waitFor = async (pred, ms = 3000) => {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(10)) {
      const hit = events.find(pred);
      if (hit) return hit;
    }
    assert.fail(`timed out; saw ${JSON.stringify(events.map((e) => e.type))}`);
  };
  return { registry, dir: path.join(registry, "p"), events, w, waitFor };
}

const RUN = JSON.stringify({ a: { stepId: "code", startedAt: "2026-01-01T00:00:00Z", model: "m" } });

test("one write → exactly one ticket event; identical rewrite → nothing", async () => {
  const { dir, events } = setup();
  fs.writeFileSync(path.join(dir, "running.json"), RUN);
  fs.writeFileSync(path.join(dir, "running.json"), RUN); // several fs.watch events, one debounce
  await sleep(SETTLE);
  const tickets = events.filter((e) => e.type === "ticket");
  assert.equal(tickets.length, 1);
  assert.equal(tickets[0].type === "ticket" && tickets[0].ticket.status, "running");
  assert.equal(events.length, 1);

  events.length = 0;
  fs.writeFileSync(path.join(dir, "running.json"), RUN);
  await sleep(SETTLE);
  assert.deepEqual(events, []);
});

test("torn / unparsable state file keeps the last good value; only ENOENT empties it", async () => {
  const { dir, events, w, waitFor } = setup();
  fs.writeFileSync(path.join(dir, "running.json"), RUN);
  await waitFor((e) => e.type === "ticket");
  events.length = 0;
  fs.writeFileSync(path.join(dir, "running.json"), ""); // mid-write truncation
  await sleep(SETTLE);
  fs.writeFileSync(path.join(dir, "running.json"), '{"a":');
  await sleep(SETTLE);
  assert.deepEqual(events, []);
  assert.equal(w.snapshot().tickets[0].status, "running");
  fs.rmSync(path.join(dir, "running.json"));
  const gone = await waitFor((e) => e.type === "ticket_removed");
  assert.deepEqual(gone, { type: "ticket_removed", profile: "p", ref: "a" });
});

test("events.jsonl: one event per appended line, partial lines held, only new bytes read, truncation resets", async () => {
  const { dir, events, waitFor } = setup();
  const file = path.join(dir, "events.jsonl");
  const line = (/** @type {string} */ ref, i = 0) => JSON.stringify({ ts: String(i), event: "enqueued", ref, step: "code" }) + "\n";
  // A big pre-existing file is seeded once, not re-read.
  let big = "";
  for (let i = 0; i < 2000; i++) big += line(`old${i % 3}`, i);
  fs.writeFileSync(file, big);
  await sleep(SETTLE);
  events.length = 0;

  let bytesRead = 0;
  const readSync = fs.readSync;
  fs.readSync = /** @type {any} */ ((/** @type {any[]} */ ...a) => {
    const got = /** @type {any} */ (readSync)(...a);
    bytesRead += got;
    return got;
  });
  try {
    fs.appendFileSync(file, line("x") + line("y"));
    await waitFor((e) => e.type === "event" && e.event.ref === "y");
  } finally {
    fs.readSync = readSync;
  }
  assert.ok(bytesRead <= (line("x") + line("y")).length, `read ${bytesRead} bytes`);
  // The new refs only exist in the events tail, so they also produce ticket rows.
  assert.deepEqual(
    events.filter((e) => e.type === "event").map((e) => e.type === "event" && [e.profile, e.event.ref]),
    [["p", "x"], ["p", "y"]],
  );
  await waitFor((e) => e.type === "ticket" && e.ticket.ref === "y");

  events.length = 0;
  const z = line("z");
  fs.appendFileSync(file, z.slice(0, 10));
  await sleep(SETTLE);
  assert.equal(events.filter((e) => e.type === "event").length, 0);
  fs.appendFileSync(file, "not json\n" + z.slice(10));
  await sleep(SETTLE);
  // "{...partial" + "not json" is one garbage line; the rest of z is garbage too — nothing parses.
  assert.equal(events.filter((e) => e.type === "event").length, 0);
  fs.appendFileSync(file, z.slice(0, 10));
  await sleep(SETTLE);
  fs.appendFileSync(file, z.slice(10));
  const ze = await waitFor((e) => e.type === "event" && e.event.ref === "z");
  assert.equal(ze.event.step, "code");

  events.length = 0;
  fs.writeFileSync(file, ""); // truncated
  await sleep(SETTLE);
  fs.appendFileSync(file, line("after"));
  await waitFor((e) => e.type === "event" && e.event.ref === "after");
  assert.equal(events.filter((e) => e.type === "event").length, 1);
});

test("registry: a new profile dir → profile (+ its tickets); removing it → ticket_removed + profile_removed", async () => {
  const { registry, events, waitFor, w } = setup([]);
  const q = path.join(registry, "q");
  fs.mkdirSync(q);
  const prof = await waitFor((e) => e.type === "profile");
  assert.equal(prof.profile.name, "q");
  assert.equal(prof.profile.up, false);
  fs.writeFileSync(path.join(q, "refmeta.json"), JSON.stringify({ 7: { displayId: "#7" } }));
  await waitFor((e) => e.type === "ticket" && e.ticket.displayId === "#7");
  assert.deepEqual(
    w.snapshot().profiles.map((p) => p.name),
    ["q"],
  );
  fs.rmSync(q, { recursive: true });
  await waitFor((e) => e.type === "profile_removed" && e.name === "q");
  assert.ok(events.some((e) => e.type === "ticket_removed" && e.ref === "7"));
  assert.deepEqual(w.snapshot(), { profiles: [], tickets: [] });
});

test("registry that doesn't exist yet is picked up once created", async () => {
  const registry = path.join(root, `missing${n++}`);
  /** @type {any[]} */
  const events = [];
  const w = createWatcher(registry, (ev) => events.push(ev));
  cleanups.push(() => w.close());
  assert.deepEqual(w.snapshot(), { profiles: [], tickets: [] });
  fs.mkdirSync(registry);
  await sleep(SETTLE);
  fs.mkdirSync(path.join(registry, "late"));
  for (const end = Date.now() + 3000; Date.now() < end && !events.length; ) await sleep(10);
  assert.equal(events[0]?.type, "profile");
  assert.equal(events[0]?.profile.name, "late");
});

test("liveness: hello → up; socket close → up:false at once; a re-created socket reconnects", { skip: process.platform === "win32" }, async () => {
  const { dir, events, waitFor, w } = setup(["p"]);
  const sockPath = path.join(dir, "control.sock");
  /** @type {Set<net.Socket>} */
  const conns = new Set();
  const listen = () =>
    new Promise((resolve) => {
      const srv = net.createServer((s) => {
        conns.add(s);
        s.on("close", () => conns.delete(s));
        s.write(JSON.stringify({ type: "hello", name: "p", pid: 4242, startedAt: "x" }) + "\n");
      });
      srv.listen(sockPath, () => resolve(srv));
      cleanups.push(() => srv.close());
    });

  let srv = /** @type {net.Server} */ (await listen());
  const on = await waitFor((e) => e.type === "profile" && e.profile.up);
  assert.equal(on.profile.pid, 4242);
  assert.equal(w.snapshot().profiles[0].up, true);

  events.length = 0;
  const t0 = Date.now();
  srv.close();
  for (const s of conns) s.destroy();
  await waitFor((e) => e.type === "profile" && !e.profile.up);
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(w.snapshot().profiles[0].up, false);

  events.length = 0;
  await sleep(SETTLE);
  srv = /** @type {net.Server} */ (await listen());
  await waitFor((e) => e.type === "profile" && e.profile.up);
  srv.close();
  for (const s of conns) s.destroy();
  await waitFor((e) => e.type === "profile" && !e.profile.up);
});

test("liveness without a socket falls back to the pidfile", async () => {
  const { dir, waitFor, w } = setup(["p"]);
  assert.equal(w.snapshot().profiles[0].up, false);
  fs.writeFileSync(path.join(dir, "server.pid"), String(process.pid));
  const on = await waitFor((e) => e.type === "profile" && e.profile.up);
  assert.equal(on.profile.pid, process.pid);
  fs.rmSync(path.join(dir, "server.pid"));
  await waitFor((e) => e.type === "profile" && !e.profile.up);
});

test("instructions: external content change → one event with the new hash; touch / other files → nothing", async () => {
  const { dir, events, waitFor } = setup();
  const sha = (/** @type {string} */ t) => crypto.createHash("sha256").update(t).digest("hex");
  const a = path.join(root, `instr${n}`);
  const b = path.join(root, `instr${n}-b`);
  fs.mkdirSync(a);
  fs.mkdirSync(b);
  const file = path.join(a, "CODE.md");
  const other = path.join(a, "OTHER.md");
  const late = path.join(b, "LATE.md");
  fs.writeFileSync(file, "v1\n");
  fs.writeFileSync(late, "late\n");
  /** @param {string[]} paths */
  const heartbeat = (paths) =>
    fs.writeFileSync(
      path.join(dir, "heartbeat.json"),
      JSON.stringify({ name: "p", instructions: paths.map((p, i) => ({ path: p, scope: "step", ids: [`s${i}`] })) }),
    );
  heartbeat([file, path.join(root, "no-such-dir", "X.md")]); // a missing dir is skipped, no throw
  await sleep(SETTLE);
  const instr = () => events.filter((e) => e.type === "instructions");
  assert.deepEqual(instr(), []); // seeding is silent

  fs.writeFileSync(file, "v2\n");
  fs.writeFileSync(file, "v2\n"); // several fs.watch events, one debounce
  const ev = await waitFor((e) => e.type === "instructions");
  assert.deepEqual(ev, { type: "instructions", profile: "p", path: file, hash: sha("v2\n") });
  await sleep(SETTLE);
  assert.equal(instr().length, 1);

  const t = new Date(Date.now() + 5000);
  fs.utimesSync(file, t, t); // mtime only, same content
  fs.writeFileSync(other, "not allowlisted\n");
  await sleep(SETTLE);
  assert.equal(instr().length, 1);

  // A heartbeat that adds a file in a new dir: seeded silently, then watched.
  heartbeat([file, late]);
  await sleep(SETTLE);
  assert.equal(instr().length, 1);
  fs.writeFileSync(late, "late v2\n");
  await waitFor((e) => e.type === "instructions" && e.path === late);

  fs.rmSync(file);
  const gone = await waitFor((e) => e.type === "instructions" && e.path === file && e.hash === null);
  assert.equal(gone.hash, null);

  // Dropped from the allowlist → no longer watched.
  heartbeat([]);
  await sleep(SETTLE);
  const before = instr().length;
  fs.writeFileSync(late, "late v3\n");
  await sleep(SETTLE);
  assert.equal(instr().length, before);
});

test("src/ui never polls: no fs.watchFile, the only interval is the SSE ping", () => {
  const dir = fileURLToPath(new URL("../src/ui/", import.meta.url));
  let intervals = 0;
  for (const f of fs.readdirSync(dir)) {
    const src = fs.readFileSync(path.join(dir, f), "utf8");
    assert.ok(!/watchFile|unwatchFile/.test(src), `${f} uses fs.watchFile`);
    for (const m of src.matchAll(/setInterval\(([^\n]*)/g)) {
      intervals++;
      assert.match(m[1], /PING_MS\)/, `${f}: unexpected interval`);
    }
  }
  assert.equal(intervals, 1);
});
