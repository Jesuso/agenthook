import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// Local energy basis (#396): the pure core (validation, time-share split, record fields,
// formatting), the sources (hwmon against a fake sysfs tree, command via fake scripts), the
// sampler with an injected clock/timer, and dispatch end-to-end through a fake `claude`.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { energyErrors, splitTick, joulesToKwh, energyFields, formatEnergy } from "../src/energy.js";
import { readHwmon, parseWatts, readCommand, createEnergySampler } from "../src/energy-sampler.js";
import { createDispatcher } from "../src/dispatch.js";
import { createStore } from "../src/store.js";
import { costOf } from "../src/pricing.js";

/** A fresh temp dir. @param {string} tag */
const tmp = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `agenthook-energy-${tag}-`));

// --- validation ---

test("energyErrors: absent is fine; every bad shape is named", () => {
  assert.deepEqual(energyErrors(undefined), []);
  assert.deepEqual(energyErrors({ usdPerKwh: 0.15, source: { type: "hwmon" } }), []);
  assert.deepEqual(energyErrors({ usdPerKwh: 0, source: { type: "hwmon", name: "amdgpu" } }), []);
  assert.deepEqual(energyErrors({ usdPerKwh: 0.15, source: { type: "command", cmd: "nvidia-smi" } }), []);
  assert.deepEqual(energyErrors({ usdPerKwh: 0.15, source: { type: "watts", watts: 250 } }), []);
  /** @param {unknown} e @param {RegExp} re */
  const has = (e, re) => assert.ok(energyErrors(e).some((m) => re.test(m)), `${JSON.stringify(e)} → ${JSON.stringify(energyErrors(e))}`);
  has([], /"energy" must be an object/);
  has({ source: { type: "watts", watts: 1 } }, /usdPerKwh must be a finite number ≥ 0/);
  has({ usdPerKwh: -1, source: { type: "watts", watts: 1 } }, /usdPerKwh must be a finite number ≥ 0/);
  has({ usdPerKwh: "0.15", source: { type: "watts", watts: 1 } }, /usdPerKwh/);
  has({ usdPerKwh: 0.15 }, /energy\.source must be an object/);
  has({ usdPerKwh: 0.15, source: { type: "rapl" } }, /source\.type must be one of hwmon, command, watts/);
  has({ usdPerKwh: 0.15, source: { type: "command" } }, /source\.cmd is required/);
  has({ usdPerKwh: 0.15, source: { type: "command", cmd: "  " } }, /source\.cmd is required/);
  has({ usdPerKwh: 0.15, source: { type: "watts" } }, /source\.watts is required/);
  has({ usdPerKwh: 0.15, source: { type: "watts", watts: 0 } }, /must be a number > 0/);
  has({ usdPerKwh: 0.15, source: { type: "hwmon", name: "" } }, /source\.name must be a non-empty string/);
  has({ usdPerKwh: 0.15, source: { type: "watts", watts: 5, cmd: "x" } }, /unknown key "cmd" for type "watts"/);
  has({ usdPerKwh: 0.15, source: { type: "watts", watts: 5 }, price: 1 }, /unknown key "price"/);
});

// --- splitTick: time share across overlapping runs ---

test("splitTick: one run gets the whole window", () => {
  const acc = splitTick(new Map(), 250, 2, ["a"]);
  assert.equal(acc.get("a"), 500);
});

test("splitTick: two fully overlapping runs each get half", () => {
  const acc = new Map();
  for (let i = 0; i < 10; i++) splitTick(acc, 300, 1, ["a", "b"]);
  assert.equal(acc.get("a"), 1500);
  assert.equal(acc.get("b"), 1500);
});

test("splitTick: partially overlapping runs split by time share, and the sum is the total integrated energy (no double count)", () => {
  // a runs t=0..4, b runs t=2..6; 100 W throughout → 600 J total.
  const acc = new Map();
  splitTick(acc, 100, 2, ["a"]); // 0..2
  splitTick(acc, 100, 2, ["a", "b"]); // 2..4
  splitTick(acc, 100, 2, ["b"]); // 4..6
  assert.equal(acc.get("a"), 300);
  assert.equal(acc.get("b"), 300);
  assert.equal([...acc.values()].reduce((s, j) => s + j, 0), 600);
  // varying power: the sum still matches Σ watts·dt
  const acc2 = new Map();
  const windows = [[200, 1, ["a"]], [350, 0.5, ["a", "b", "c"]], [90, 3, ["c"]], [10, 1, []]];
  for (const [w, dt, ids] of windows) splitTick(acc2, /** @type {number} */ (w), /** @type {number} */ (dt), /** @type {string[]} */ (ids));
  const total = 200 * 1 + 350 * 0.5 + 90 * 3; // the idle window (no active run) credits nobody
  assert.ok(Math.abs([...acc2.values()].reduce((s, j) => s + j, 0) - total) < 1e-9);
});

test("splitTick: an empty active set is a no-op; a zero window still marks the run measured", () => {
  const acc = splitTick(new Map(), 100, 1, []);
  assert.equal(acc.size, 0);
  assert.equal(splitTick(new Map(), 100, 0, ["a"]).get("a"), 0);
});

test("joulesToKwh / energyFields: kWh to 1e-9, dollars to 1e-6 (not cents)", () => {
  assert.equal(joulesToKwh(3.6e6), 1);
  // the spike: 27 s at 257 W avg ≈ 1.93 Wh
  const kWh = joulesToKwh(257 * 27);
  assert.deepEqual(energyFields(kWh, 0.15, "hwmon"), { energyKwh: 0.0019275, energyUsd: 0.000289, energySource: "hwmon" });
});

test("formatEnergy: sub-cent dollars keep two significant digits; Wh / kWh scale", () => {
  assert.equal(formatEnergy({ energyKwh: 0.0019275, energyUsd: 0.000289 }), "energy $0.00029 (1.9 Wh)");
  assert.equal(formatEnergy({ energyKwh: 0.25, energyUsd: 0.0375 }), "energy $0.04 (250 Wh)");
  assert.equal(formatEnergy({ energyKwh: 1.5, energyUsd: 0.225 }), "energy $0.23 (1.50 kWh)");
  assert.equal(formatEnergy({ energyKwh: 0.00005, energyUsd: 0.000008 }), "energy $0.000008 (0.05 Wh)");
  assert.equal(formatEnergy({ energyKwh: 0, energyUsd: 0 }), "energy $0 (0.0 Wh)");
  assert.equal(formatEnergy({}), "");
  assert.equal(formatEnergy(null), "");
});

// --- hwmon source against a fake sysfs tree ---

/** @param {Record<string, Record<string, string>>} nodes  hwmonN → file → contents */
function fakeSysfs(nodes) {
  const root = tmp("sysfs");
  for (const [n, files] of Object.entries(nodes)) {
    fs.mkdirSync(path.join(root, n));
    for (const [f, v] of Object.entries(files)) fs.writeFileSync(path.join(root, n, f), v);
  }
  return root;
}

test("readHwmon: finds the node by name (never a fixed hwmonN), µW → W, power1_input fallback, sums matches", () => {
  const root = fakeSysfs({
    hwmon0: { name: "nvme\n", power1_average: "999000000\n" },
    hwmon3: { name: "amdgpu\n", power1_average: "257000000\n", power1_cap: "339000000\n" },
  });
  assert.equal(readHwmon(root, "amdgpu"), 257);
  assert.equal(readHwmon(root), 257, "defaults to amdgpu");
  const two = fakeSysfs({
    hwmon1: { name: "amdgpu", power1_average: "100000000" },
    hwmon2: { name: "amdgpu", power1_input: "50500000" }, // only power1_input
    hwmon4: { name: "amdgpu" }, // no power file: skipped
  });
  assert.equal(readHwmon(two, "amdgpu"), 150.5);
});

test("readHwmon: no matching node (or none that reads) → throws", () => {
  const root = fakeSysfs({ hwmon0: { name: "nvme", power1_average: "1" }, hwmon1: { name: "amdgpu" } });
  assert.throws(() => readHwmon(root, "amdgpu"), /no hwmon node named "amdgpu"/);
  assert.throws(() => readHwmon(path.join(root, "missing")), /ENOENT/);
});

// --- command source ---

test("parseWatts: first number per non-empty line, summed; garbage or nothing throws", () => {
  assert.equal(parseWatts("257.5\n"), 257.5);
  assert.equal(parseWatts("120.3\n\n 80.2 W\n"), 200.5);
  assert.throws(() => parseWatts(""), /printed nothing/);
  assert.throws(() => parseWatts("N/A\n"), /no watts/);
  assert.throws(() => parseWatts("100\n[Not Supported]\n"), /no watts/);
});

/** A fake power script. @param {string} body */
function script(body) {
  const f = path.join(tmp("cmd"), "power.sh");
  fs.writeFileSync(f, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return f;
}

test("readCommand: single line, multi-line sum (multi-GPU)", async () => {
  assert.equal(await readCommand(script("echo 257")), 257);
  assert.equal(await readCommand(script("printf '120.5\\n80.25\\n'")), 200.75);
});

test("readCommand: garbage, a non-zero exit and a slow script all fail", async () => {
  await assert.rejects(readCommand(script("echo hello")), /no watts/);
  await assert.rejects(readCommand(script("echo 100; exit 3")), /exited 3/);
  const t0 = Date.now();
  await assert.rejects(readCommand(script("echo 100; sleep 5"), 200), /timed out after 200ms/);
  assert.ok(Date.now() - t0 < 2000, "the timeout does not wait for the script's children");
});

// --- the sampler, on an injected clock + timer ---

/** A fake clock + interval: `advance(ms)` moves time and fires due ticks. */
function fakeTime() {
  let t = 1_000_000;
  /** @type {{fn: () => void, ms: number, next: number}|null} */
  let iv = null;
  let armed = 0;
  return {
    now: () => t,
    setInterval: (/** @type {() => void} */ fn, /** @type {number} */ ms) => {
      armed++;
      iv = { fn, ms, next: t + ms };
      return iv;
    },
    clearInterval: (/** @type {any} */ h) => {
      if (h === iv) iv = null;
    },
    /** @param {number} ms */
    async advance(ms) {
      const end = t + ms;
      while (iv && iv.next <= end) {
        t = iv.next;
        iv.next += iv.ms;
        iv.fn();
        await new Promise((r) => setImmediate(r));
      }
      t = end;
    },
    get armed() {
      return armed;
    },
    get active() {
      return iv !== null;
    },
  };
}

test("sampler: one run at a fixed draw integrates watts × time", async () => {
  const time = fakeTime();
  const s = createEnergySampler({ source: { type: "watts", watts: 360 }, ...time });
  s.start("a");
  await time.advance(10_000);
  const r = await s.stop("a");
  assert.ok(r);
  assert.ok(Math.abs(r.kWh - joulesToKwh(3600)) < 1e-12, String(r.kWh));
});

test("sampler: overlapping runs split by time share; the sum equals the total (no double count)", async () => {
  const time = fakeTime();
  const s = createEnergySampler({ source: { type: "watts", watts: 100 }, ...time });
  s.start("a");
  await time.advance(2000);
  s.start("b");
  await time.advance(2000);
  const a = await s.stop("a");
  await time.advance(2000);
  const b = await s.stop("b");
  assert.ok(a && b);
  assert.ok(Math.abs(a.kWh - joulesToKwh(300)) < 1e-12, `a=${a.kWh}`);
  assert.ok(Math.abs(b.kWh - joulesToKwh(300)) < 1e-12, `b=${b.kWh}`);
});

test("sampler: never samples idle — the interval is armed only while a run is active", async () => {
  const time = fakeTime();
  let reads = 0;
  const root = fakeSysfs({ hwmon0: { name: "amdgpu", power1_average: "100000000" } });
  const orig = fs.readdirSync;
  const s = createEnergySampler({ source: { type: "hwmon" }, sysfsRoot: root, ...time });
  // count readings through the sysfs dir listing
  fs.readdirSync = /** @type {any} */ ((/** @type {any[]} */ ...a) => {
    if (a[0] === root) reads++;
    return /** @type {any} */ (orig)(...a);
  });
  try {
    assert.equal(s.sampling, false);
    assert.equal(time.armed, 0);
    s.start("a");
    assert.equal(s.sampling, true);
    await time.advance(3000);
    await s.stop("a");
    assert.equal(s.sampling, false, "cleared when the set empties");
    assert.equal(time.active, false);
    const after = reads;
    await time.advance(60_000);
    assert.equal(reads, after, "no reads while idle");
    s.start("b");
    assert.equal(time.armed, 2, "re-armed for the next run");
    await s.stop("b");
  } finally {
    fs.readdirSync = orig;
  }
});

test("sampler: a source that never reads → null and exactly one onError per run; non-tracked runs get nothing", async () => {
  const time = fakeTime();
  const s = createEnergySampler({ source: { type: "hwmon", name: "nope" }, sysfsRoot: fakeSysfs({ hwmon0: { name: "amdgpu" } }), ...time });
  /** @type {string[]} */
  const errs = [];
  s.start("a", { onError: (m) => errs.push(m) });
  await time.advance(5000);
  assert.equal(await s.stop("a"), null);
  assert.equal(errs.length, 1);
  assert.match(errs[0], /no hwmon node named "nope"/);
  assert.equal(await s.stop("never-started"), null);
});

test("sampler: a reading that fails mid-run only drops its own windows; the run is still measured", async () => {
  const time = fakeTime();
  const root = fakeSysfs({ hwmon0: { name: "amdgpu", power1_average: "100000000" } });
  const s = createEnergySampler({ source: { type: "hwmon" }, sysfsRoot: root, ...time });
  /** @type {string[]} */
  const errs = [];
  s.start("a", { onError: (m) => errs.push(m) });
  await time.advance(2000);
  fs.renameSync(path.join(root, "hwmon0", "power1_average"), path.join(root, "hwmon0", "gone"));
  await time.advance(2000);
  const r = await s.stop("a");
  assert.ok(r && r.kWh > 0);
  assert.equal(errs.length, 1);
});

test("sampler: a slow command is single-flight — ticks while a reading is in flight are skipped", async () => {
  const marker = path.join(tmp("count"), "n");
  const cmd = `echo x >> "${marker}"; sleep 0.3; echo 100`;
  const s = createEnergySampler({ source: { type: "command", cmd }, intervalMs: 20 });
  s.start("a");
  await new Promise((r) => setTimeout(r, 400));
  const r = await s.stop("a");
  const runs = fs.readFileSync(marker, "utf8").trim().split("\n").length;
  assert.ok(runs <= 3, `${runs} command runs in 400 ms at a 20 ms tick`);
  assert.ok(r && r.kWh > 0);
});

// --- dispatch end-to-end ---

/**
 * One `code` step through the real dispatcher with a fake `claude` that prints a stream-json
 * result and writes an advance verdict.
 * `localBin` runs it as the step's own `bin` (a copy), so the run is unpriced and gets a rate-table estimate.
 * @param {{ step?: any, energy?: any, sampler?: any, sleep?: number, localBin?: boolean }} o
 */
async function runEnergy({ step = {}, energy, sampler, sleep = 0, localBin = false } = {}) {
  const dir = tmp("dispatch");
  const bin = path.join(dir, "fake-claude.sh");
  const result = JSON.stringify({ type: "result", total_cost_usd: 0.5, usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, session_id: "s1" });
  fs.writeFileSync(bin, `#!/bin/sh\n${sleep ? `sleep ${sleep}\n` : ""}printf '%s\\n' '${result}'\nprintf '{"outcome":"advance"}' > "$AGENTHOOK_VERDICT_FILE"\n`, { mode: 0o755 });
  if (localBin) fs.copyFileSync(bin, path.join(dir, "claude-local.sh"));
  const cfg = /** @type {any} */ ({
    pipeline: [{ id: "code", ...(localBin ? { bin: path.join(dir, "claude-local.sh") } : {}), ...step }, { id: "done", manual: true }],
    claudeBin: bin,
    repoPath: dir,
    dataDir: dir,
    logDir: dir,
    instructionsFile: path.join(dir, "none.md"),
    ...(energy ? { energy } : {}),
  });
  const store = createStore(dir);
  /** @type {any[]} */
  const advanced = [];
  /** @type {any[]} */
  const events = [];
  const adapter = /** @type {any} */ ({
    describe: () => ({ platform: "GitHub", taskNoun: "issue", trigger: "@agent", commentHowTo: "comment" }),
    fetchTask: async (/** @type {string} */ ref) => ({ ref, name: "t", description: "d", url: "u", completed: false, assignedToUs: true }),
    advance: async (/** @type {string} */ _ref, /** @type {string} */ _s, /** @type {any} */ v) => advanced.push(v),
  });
  const run = createDispatcher(cfg, adapter, undefined, store, (/** @type {string} */ event, /** @type {string} */ _r, /** @type {string} */ _s, /** @type {any} */ extra) => events.push({ event, ...extra }), null, undefined, sampler ? { energySampler: sampler } : {});
  const log = console.log;
  const err = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    await run({ kind: "pipeline", ref: "42", stepId: "code", dedupKey: "k" });
  } finally {
    console.log = log;
    console.error = err;
  }
  const logText = fs.readdirSync(dir).filter((f) => f.endsWith(".log")).map((f) => fs.readFileSync(path.join(dir, f), "utf8")).join("");
  return { advanced, end: events.find((e) => e.event === "run_end"), usage: store.readUsage(), logText };
}

const KWH = 0.0019275;
/** A sampler stub that reports KWH for every run, recording its calls. */
function stubSampler() {
  /** @type {string[]} */
  const calls = [];
  return {
    calls,
    start: (/** @type {string} */ id) => void calls.push(`start:${id.split("\0")[0]}`),
    stop: async (/** @type {string} */ id) => (calls.push(`stop:${id.split("\0")[0]}`), { kWh: KWH }),
  };
}

test("dispatch: an energy:true step records energyKwh/energyUsd/energySource on usage.jsonl and run_end; costBasis/costUsd untouched", async () => {
  const sampler = stubSampler();
  const r = await runEnergy({ step: { energy: true }, energy: { usdPerKwh: 0.15, source: { type: "hwmon" } }, sampler });
  assert.deepEqual(sampler.calls, ["start:42", "stop:42"]);
  assert.equal(r.advanced[0].outcome, "advance");
  const u = r.usage[0];
  assert.deepEqual([u.energyKwh, u.energyUsd, u.energySource], [KWH, 0.000289, "hwmon"]);
  assert.equal(u.costUsd, 0.5);
  assert.equal(u.costBasis, "reported");
  assert.deepEqual([r.end.energyKwh, r.end.energyUsd, r.end.energySource], [KWH, 0.000289, "hwmon"]);
  assert.equal(r.end.costUsd, 0.5);
  assert.equal(r.end.costBasis, "reported");
});

test("dispatch: a rate-table run keeps its estimate unchanged beside energy (energy is never folded in)", async () => {
  const sampler = stubSampler();
  const r0 = await runEnergy({ step: { model: "claude-sonnet-5-5" }, localBin: true });
  const r = await runEnergy({ step: { energy: true, model: "claude-sonnet-5-5" }, energy: { usdPerKwh: 0.15, source: { type: "watts", watts: 250 } }, sampler, localBin: true });
  // same tokens, same model: the energy run's estimate/basis equal the plain run's
  assert.equal(r0.usage[0].costBasis, "rate-table");
  assert.ok(r0.usage[0].estUsd > 0);
  assert.equal(r.end.costBasis, "rate-table");
  assert.equal(r.end.estUsd, r0.end.estUsd);
  assert.equal(r.usage[0].costBasis, r0.usage[0].costBasis);
  assert.equal(r.usage[0].estUsd, r0.usage[0].estUsd);
  assert.deepEqual(costOf(r.usage[0]), costOf(r0.usage[0]));
  assert.equal(r.end.energySource, "watts");
});

test("dispatch: a step without energy:true never starts the sampler and carries no energy fields", async () => {
  const sampler = stubSampler();
  const r = await runEnergy({ energy: { usdPerKwh: 0.15, source: { type: "hwmon" } }, sampler });
  assert.deepEqual(sampler.calls, []);
  assert.equal("energyKwh" in r.usage[0], false);
  assert.equal("energyKwh" in r.end, false);
});

test("dispatch: a real watts source measures the run", async () => {
  const r = await runEnergy({ step: { energy: true }, energy: { usdPerKwh: 0.15, source: { type: "watts", watts: 300 } }, sleep: 0.2 });
  assert.ok(r.end.energyKwh > 0, JSON.stringify(r.end));
  assert.equal(r.end.energySource, "watts");
  assert.equal(r.usage[0].energyKwh, r.end.energyKwh);
});

test("dispatch: an unreadable source → no energy fields, outcome unaffected, one log line", async () => {
  const r = await runEnergy({ step: { energy: true }, energy: { usdPerKwh: 0.15, source: { type: "command", cmd: "exit 1" } }, sleep: 1.5 });
  assert.equal(r.advanced[0].outcome, "advance");
  assert.equal("energyKwh" in r.end, false);
  assert.equal("energyKwh" in r.usage[0], false);
  assert.equal(r.logText.match(/\[agenthook\] energy reading failed:/g)?.length, 1, r.logText);
  assert.match(r.logText, /command exited 1/);
});

test("dispatch: a sampler that throws never touches the run", async () => {
  const sampler = {
    start: () => {
      throw new Error("boom");
    },
    stop: async () => {
      throw new Error("never reached");
    },
  };
  const r = await runEnergy({ step: { energy: true }, energy: { usdPerKwh: 0.15, source: { type: "hwmon" } }, sampler });
  assert.equal(r.advanced[0].outcome, "advance");
  assert.equal("energyKwh" in r.end, false);
  assert.match(r.logText, /energy reading failed: boom/);
});
