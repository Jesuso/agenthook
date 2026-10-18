// The energy sampler (#396): reads machine power from the profile's `energy.source` at ~1 Hz while
// at least one opted-in run is active, and splits each window's energy across those runs by time
// share (src/energy.js `splitTick`). Owned by the dispatcher; never samples idle (the interval is
// cleared when the last run stops), never throws into a run, never touches a verdict.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { DEFAULT_HWMON_NAME, joulesToKwh, splitTick } from "./energy.js";

/** A `command` source's per-reading budget. */
export const COMMAND_TIMEOUT_MS = 2000;

/** A validated `energy.source` (src/energy.js `energyErrors`): `hwmon` + `name?`, `command` + `cmd`, `watts` + `watts`.
 * @typedef {{ type: "hwmon"|"command"|"watts", name?: string, cmd?: string, watts?: number }} EnergySource */

/**
 * Watts summed over every `<root>/*` hwmon node whose `name` file is `name` — never a hard-coded
 * `hwmonN` (the index moves between boots). Each node reads `power1_average`, else
 * `power1_input` (µW). Throws when no matching node reads.
 * @param {string} root @param {string} [name] @returns {number}
 */
export function readHwmon(root, name = DEFAULT_HWMON_NAME) {
  let watts = 0;
  let read = 0;
  for (const node of fs.readdirSync(root)) {
    const dir = path.join(root, node);
    let n;
    try {
      n = fs.readFileSync(path.join(dir, "name"), "utf8").trim();
    } catch {
      continue;
    }
    if (n !== name) continue;
    for (const f of ["power1_average", "power1_input"]) {
      let uw;
      try {
        uw = Number(fs.readFileSync(path.join(dir, f), "utf8").trim());
      } catch {
        continue;
      }
      if (!Number.isFinite(uw) || uw < 0) continue;
      watts += uw / 1e6;
      read++;
      break;
    }
  }
  if (!read) throw new Error(`no hwmon node named "${name}" with a readable power1_average/power1_input under ${root}`);
  return watts;
}

/**
 * Watts from a command's stdout: the sum of the first number on each non-empty line (one line
 * per GPU, e.g. `nvidia-smi --query-gpu=power.draw --format=csv,noheader,nounits`). Throws on
 * no lines or a line with no number. Pure.
 * @param {string} stdout @returns {number}
 */
export function parseWatts(stdout) {
  const lines = String(stdout).split("\n").map((l) => l.trim()).filter(Boolean);
  if (!lines.length) throw new Error("command printed nothing");
  let watts = 0;
  for (const line of lines) {
    const m = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/.exec(line);
    const w = m ? Number(m[0]) : NaN;
    if (!Number.isFinite(w) || w < 0) throw new Error(`command printed no watts on line ${JSON.stringify(line.slice(0, 80))}`);
    watts += w;
  }
  return watts;
}

/**
 * Run `cmd` via `/bin/sh -c` in its own process group (so a timeout kills the whole script, not
 * just the shell) and parse watts from its stdout. Rejects on a non-zero exit, a timeout or
 * unparsable output.
 * @param {string} cmd @param {number} [timeoutMs] @returns {Promise<number>}
 */
export function readCommand(cmd, timeoutMs = COMMAND_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let out = "";
    let done = false;
    /** @param {Error|null} err @param {number} [w] */
    const finish = (err, w) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(/** @type {number} */ (w));
    };
    const child = spawn("/bin/sh", ["-c", cmd], { stdio: ["ignore", "pipe", "ignore"], detached: true });
    const timer = setTimeout(() => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
      finish(new Error(`command timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout?.on("data", (d) => {
      if (out.length < 64 * 1024) out += d;
    });
    child.on("error", (e) => finish(e));
    child.on("close", (code) => {
      if (code !== 0) return finish(new Error(`command exited ${code ?? "on a signal"}`));
      try {
        finish(null, parseWatts(out));
      } catch (e) {
        finish(e);
      }
    });
  });
}

/**
 * One reading from a source, in watts. Never rejects: `{ error }` on failure.
 * @param {EnergySource} source @param {{ sysfsRoot: string, commandTimeoutMs: number }} o
 * @returns {Promise<{ watts: number } | { error: string }>}
 */
async function readSource(source, { sysfsRoot, commandTimeoutMs }) {
  try {
    if (source.type === "watts") return { watts: Number(source.watts) };
    if (source.type === "hwmon") return { watts: readHwmon(sysfsRoot, source.name) };
    if (source.type === "command") return { watts: await readCommand(String(source.cmd), commandTimeoutMs) };
    return { error: `unknown energy source type ${JSON.stringify(/** @type {any} */ (source).type)}` };
  } catch (e) {
    return { error: e?.message ?? String(e) };
  }
}

/**
 * The dispatcher's sampler. `start(runId, {onError})` / `stop(runId) → {kWh} | null`.
 *
 * Each window runs from one reading to the next and is credited (by `splitTick`) to the runs active
 * in it, at the mean of its two end readings (one, when the other failed; none — nothing credited —
 * when both failed). A window closes on every ~1 Hz tick, on every `start` (before the new run joins,
 * so it gets no share of time before it existed — the first `start` takes the baseline reading) and
 * on every `stop` (before the run leaves, so its last partial second counts). Readings are
 * single-flight: a tick while one is in flight is skipped; a `start`/`stop` shares it. A run that no
 * window ever credited returns null. `onError` is called at most once per run, with the first
 * failed reading's message, and must not throw.
 *
 * @param {{ source: EnergySource, sysfsRoot?: string, intervalMs?: number, commandTimeoutMs?: number,
 *   now?: () => number, setInterval?: (fn: () => void, ms: number) => any, clearInterval?: (t: any) => void }} o
 */
export function createEnergySampler({
  source,
  sysfsRoot = "/sys/class/hwmon",
  intervalMs = 1000,
  commandTimeoutMs = COMMAND_TIMEOUT_MS,
  now = Date.now,
  setInterval: setIv = setInterval,
  clearInterval: clearIv = clearInterval,
}) {
  /** runId → its error callback + whether it was already told. @type {Map<string, { onError?: (msg: string) => void, warned: boolean }>} */
  const runs = new Map();
  /** @type {Set<string>} */
  const active = new Set();
  /** runId → joules (an id is present once any window credited it). @type {Map<string, number>} */
  const acc = new Map();
  /** @type {any} */
  let timer = null;
  /** @type {number|null} */
  let lastAt = null;
  /** @type {Promise<{ watts: number } | { error: string }>|null} */
  let lastRead = null;
  /** @type {Promise<{ watts: number } | { error: string }>|null} */
  let inFlight = null;
  /** Every window's credit, in order — `stop` waits on it. @type {Promise<void>} */
  let credited = Promise.resolve();

  /** The in-flight reading, else a new one. A failed reading tells each active run (once). */
  function read() {
    if (inFlight) return inFlight;
    const p = readSource(source, { sysfsRoot, commandTimeoutMs }).then((r) => {
      if (inFlight === p) inFlight = null;
      if ("error" in r) {
        for (const id of active) {
          const run = runs.get(id);
          if (!run || run.warned) continue;
          run.warned = true;
          try {
            run.onError?.(r.error);
          } catch {
            /* a logger never breaks sampling */
          }
        }
      }
      return r;
    });
    inFlight = p;
    return p;
  }

  /** Close the current window at now(): credit it to the runs active right now. */
  function closeWindow() {
    const at = now();
    const ids = [...active];
    const startRead = lastRead;
    const endRead = read();
    const dtS = lastAt === null ? 0 : Math.max(0, at - lastAt) / 1000;
    lastAt = at;
    lastRead = endRead;
    if (!ids.length || !startRead) return;
    const credit = Promise.all([startRead, endRead]).then(([a, b]) => {
      const ws = [a, b].flatMap((r) => ("watts" in r ? [r.watts] : []));
      if (ws.length) splitTick(acc, ws.reduce((s, w) => s + w, 0) / ws.length, dtS, ids);
    });
    credited = credited.then(() => credit);
  }

  function tick() {
    if (inFlight || !active.size) return;
    closeWindow();
  }

  return {
    /** Begin attributing energy to `runId`. @param {string} runId @param {{ onError?: (msg: string) => void }} [o] */
    start(runId, { onError } = {}) {
      if (runs.has(runId)) return;
      runs.set(runId, { onError, warned: false });
      closeWindow();
      active.add(runId);
      if (!timer) {
        timer = setIv(tick, intervalMs);
        timer?.unref?.();
      }
    },
    /** Stop attributing to `runId`; its energy, or null when no reading ever succeeded for it.
     * @param {string} runId @returns {Promise<{ kWh: number } | null>} */
    async stop(runId) {
      if (!runs.has(runId)) return null;
      closeWindow();
      active.delete(runId);
      if (!active.size) {
        if (timer) clearIv(timer);
        timer = null;
        lastAt = null;
        lastRead = null;
      }
      await credited;
      runs.delete(runId);
      const j = acc.get(runId);
      acc.delete(runId);
      return j === undefined ? null : { kWh: joulesToKwh(j) };
    },
    /** True while the ~1 Hz interval is armed (tests). */
    get sampling() {
      return timer !== null;
    },
  };
}
