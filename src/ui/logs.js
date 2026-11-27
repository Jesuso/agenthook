// `ah ui` run-log live tail (docs/web-ui.md). Live-tails one log by byte offset off an
// fs.watch on the logs *dir*, debounced like the state watcher. Blind reader — never writes
// anything.
import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { DEBOUNCE_MS } from "./watch.js";

/** The `init` frame carries at most this much of the log's tail. */
export const LOG_TAIL_BYTES = 64 * 1024;

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
 * @param {(f: import('../shared/contract.js').LogFrame) => void} onFrame
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

  /** @param {import('../shared/contract.js').LogFrame} f */
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
