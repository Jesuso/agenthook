// `ah ui` run-log viewer backend (docs/web-ui.md). Lists a ref's runs straight from the
// profile's `logs/` dir (no config: the step is the text between `-step-` and the ref) and
// live-tails one log by byte offset off an fs.watch on the logs *dir*, debounced like the
// state watcher. Blind reader — validates every name against a real directory listing and
// never writes anything.
import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { listProfiles } from "../heartbeat.js";
import { DEBOUNCE_MS } from "./watch.js";
import { isObj, readStateFile } from "./rows.js";

/** The `init` frame carries at most this much of the log's tail. */
export const LOG_TAIL_BYTES = 64 * 1024;

/** `<ISO stamp with [:.]→->-step-` — the prefix dispatch.js gives every run log. */
const RUN_PREFIX_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-step-/;
const RUN_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-step-.+\.log$/;

/** dispatch.js's filename mapping of a ref. @param {string} ref */
export const safeRef = (ref) => String(ref).replace(/[^A-Za-z0-9_.-]/g, "_");

/** A known profile's state dir, or null. Only names `listProfiles` returns are accepted.
 * @param {string} registry @param {string} profile */
export function profileDir(registry, profile) {
  if (!profile || !listProfiles(registry).some((p) => p.name === profile)) return null;
  return path.join(registry, profile);
}

/**
 * The absolute path of one run log, or null unless: the profile is known, `run` is a plain
 * run-log basename that is actually listed in its `logs/`, and its realpath stays there
 * (a symlink out of the dir is rejected).
 * @param {string} registry @param {string} profile @param {string} run
 * @returns {string|null}
 */
export function resolveRunLog(registry, profile, run) {
  const dir = profileDir(registry, profile);
  if (!dir || typeof run !== "string") return null;
  if (run !== path.basename(run) || /[/\\\0]/.test(run) || run === "." || run === "..") return null;
  if (!RUN_RE.test(run)) return null;
  const logs = path.join(dir, "logs");
  try {
    if (!fs.readdirSync(logs).includes(run)) return null;
    const root = fs.realpathSync(logs);
    const real = fs.realpathSync(path.join(logs, run));
    if (!real.startsWith(root + path.sep) || !fs.statSync(real).isFile()) return null;
    return real;
  } catch {
    return null;
  }
}

/** `2026-10-08T15-31-28-123Z-step-…` → `2026-10-08T15:31:28.123Z`. @param {string} name */
const stampOf = (name) => {
  const m = RUN_PREFIX_RE.exec(name);
  return m ? `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z` : null;
};

/**
 * A ref's runs, newest first. `outcome`/`costUsd` come from the first `run_end` for the same
 * (ref, step) at or after the log's stamp and before that step's next run; null when it isn't
 * in `events` (still running, or older than the events tail). `running` = no outcome yet, it's
 * the ref's newest run, and running.json has the ref on that step.
 * @param {string} registry @param {string} profile @param {string} ref
 * @param {Record<string, any>[]} events  the profile's events tail, oldest first
 * @returns {import('./contract.js').RunView[]}
 */
export function listRuns(registry, profile, ref, events) {
  const dir = profileDir(registry, profile);
  if (!dir) return [];
  const logs = path.join(dir, "logs");
  /** @type {string[]} */
  let names;
  try {
    names = fs.readdirSync(logs);
  } catch {
    return [];
  }
  const suffix = `-${safeRef(ref)}.log`;
  // Steps this profile is known to run. A filename can't separate `<step>-<ref>` on its own:
  // ref "5"'s suffix also matches ref "x-5"'s `code-x-5`; an unknown step that extends a
  // known one with "-" is that longer ref's log, not ours.
  const known = new Set();
  for (const e of events) if (typeof e.step === "string" && e.step) known.add(e.step);
  const running = readStateFile(dir, "running");
  for (const r of Object.values(running)) if (isObj(r) && typeof r.stepId === "string") known.add(r.stepId);

  /** @type {{ run: string, step: string, startedAt: string, bytes: number }[]} */
  const found = [];
  for (const run of names) {
    const m = RUN_PREFIX_RE.exec(run);
    if (!m || !run.endsWith(suffix) || run.length <= m[0].length + suffix.length) continue;
    const step = run.slice(m[0].length, -suffix.length);
    if (!known.has(step) && [...known].some((k) => step.startsWith(k + "-"))) continue;
    /** @type {fs.Stats} */
    let st;
    try {
      st = fs.lstatSync(path.join(logs, run)); // lstat: a symlink is never a run (resolveRunLog agrees)
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    found.push({ run, step, startedAt: /** @type {string} */ (stampOf(run)), bytes: st.size });
  }
  found.sort((a, b) => (a.run < b.run ? -1 : a.run > b.run ? 1 : 0));

  const ends = events.filter((e) => e.event === "run_end" && e.ref === ref && typeof e.ts === "string");
  const cur = Object.hasOwn(running, ref) && isObj(running[ref]) ? running[ref] : null;
  /** @type {import('./contract.js').RunView[]} */
  const out = [];
  found.forEach((r, i) => {
    const next = found.slice(i + 1).find((n) => n.step === r.step)?.startedAt ?? null;
    const end = ends.find((e) => e.step === r.step && e.ts >= r.startedAt && (next === null || e.ts < next)) || null;
    const outcome = end && typeof end.outcome === "string" ? end.outcome : null;
    out.push({
      run: r.run,
      step: r.step,
      startedAt: r.startedAt,
      outcome,
      costUsd: end && typeof end.costUsd === "number" && Number.isFinite(end.costUsd) ? end.costUsd : null,
      running: !end && i === found.length - 1 && !!cur && cur.stepId === r.step,
      bytes: r.bytes,
    });
  });
  return out.reverse();
}

/**
 * @typedef {object} TailState
 * @property {number} offset  bytes consumed
 * @property {number} ino     inode at the last read (0 = unknown)
 */

/**
 * Read the bytes appended to `file` since `st.offset` and advance it. When the file shrank
 * or was replaced (inode change) nothing is read: `st` resets to offset 0 and `reset:true`
 * tells the caller to re-seed (e.g. from the tail). A missing file reads as nothing.
 * @param {string} file @param {TailState} st
 * @returns {{ chunk: Buffer, reset: boolean }}
 */
export function readAppended(file, st) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return { chunk: Buffer.alloc(0), reset: false };
  }
  try {
    const s = fs.fstatSync(fd);
    if (s.size < st.offset || (st.ino && s.ino !== st.ino)) {
      st.offset = 0;
      st.ino = s.ino;
      return { chunk: Buffer.alloc(0), reset: true };
    }
    st.ino = s.ino;
    const chunk = readRange(fd, st.offset, s.size);
    st.offset += chunk.length;
    return { chunk, reset: false };
  } catch {
    return { chunk: Buffer.alloc(0), reset: false };
  } finally {
    fs.closeSync(fd);
  }
}

/** @param {number} fd @param {number} from @param {number} to */
function readRange(fd, from, to) {
  const buf = Buffer.alloc(Math.max(0, to - from));
  let off = 0;
  while (off < buf.length) {
    const n = fs.readSync(fd, buf, off, buf.length - off, from + off);
    if (n <= 0) break;
    off += n;
  }
  return buf.subarray(0, off);
}

/**
 * Seed a tail: the last ≤ LOG_TAIL_BYTES of `file`, starting after the first "\n" when the
 * read began mid-file. Sets `st` to the end of what was read.
 * @param {string} file @param {TailState} st @param {number} [maxBytes]
 * @returns {{ chunk: Buffer, truncated: boolean, size: number }}
 */
export function readTail(file, st, maxBytes = LOG_TAIL_BYTES) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    st.offset = 0;
    st.ino = 0;
    return { chunk: Buffer.alloc(0), truncated: false, size: 0 };
  }
  try {
    const s = fs.fstatSync(fd);
    const start = Math.max(0, s.size - maxBytes);
    // One byte early, so a tail starting exactly on a line boundary keeps that line.
    const from = start > 0 ? start - 1 : 0;
    let chunk = readRange(fd, from, s.size);
    st.offset = from + chunk.length;
    st.ino = s.ino;
    if (start > 0) {
      const nl = chunk.indexOf(0x0a);
      chunk = nl === -1 ? Buffer.alloc(0) : chunk.subarray(nl + 1);
    }
    return { chunk, truncated: start > 0, size: s.size };
  } catch {
    return { chunk: Buffer.alloc(0), truncated: false, size: 0 };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Live-tail one run log. Calls `onFrame` with an `init` right away, then `append` for new
 * bytes and `reset` + `init` when the file is truncated or replaced. Follows via fs.watch on
 * the log's directory filtered to its name (~DEBOUNCE_MS), never by polling. Text is decoded
 * with a StringDecoder so a multibyte char split across reads arrives whole.
 * @param {string} file  a path from resolveRunLog
 * @param {(f: import('./contract.js').LogFrame) => void} onFrame
 * @returns {{ close(): void }}
 */
export function createLogTail(file, onFrame) {
  const name = path.basename(file);
  /** @type {TailState} */
  const st = { offset: 0, ino: 0 };
  let decoder = new StringDecoder("utf8");
  /** @type {NodeJS.Timeout|null} */
  let timer = null;
  /** @type {fs.FSWatcher|null} */
  let fsw = null;
  let closed = false;

  /** @param {import('./contract.js').LogFrame} f */
  const emit = (f) => {
    if (closed) return;
    try {
      onFrame(f);
    } catch {
      /* a broken subscriber must not stop the tail */
    }
  };

  const init = () => {
    decoder = new StringDecoder("utf8");
    const t = readTail(file, st);
    emit({ type: "init", text: decoder.write(t.chunk), truncated: t.truncated, size: t.size });
  };

  const flush = () => {
    timer = null;
    if (closed) return;
    const r = readAppended(file, st);
    if (r.reset) {
      emit({ type: "reset" });
      return init();
    }
    const text = r.chunk.length ? decoder.write(r.chunk) : "";
    if (text) emit({ type: "append", text });
  };

  try {
    fsw = fs.watch(path.dirname(file), (_ev, f) => {
      if (closed || (f != null && String(f) !== name)) return;
      if (!timer) timer = setTimeout(flush, DEBOUNCE_MS);
    });
    fsw.on("error", () => {
      fsw?.close();
      fsw = null;
    });
  } catch {
    /* logs dir vanished — the init below still shows what's there */
  }
  init();

  return {
    close() {
      closed = true;
      fsw?.close();
      fsw = null;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
