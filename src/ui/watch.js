// `ah ui` realtime source (docs/web-ui.md § Realtime model). Watches the registry and every
// profile's state dir with fs.watch (directories, never files — writers truncate or rename
// over them), debounces ~50 ms per profile, re-reads only the changed files, and emits a
// typed UiEvent only when a ProfileView / TicketRow hash actually changed. events.jsonl is
// tailed by byte offset; liveness rides the receiver's control socket. The parent dirs of
// each profile's allowlisted instruction files (heartbeat.instructions) and its config file
// (heartbeat.configPath) are watched too, and a content change (sha256) emits an
// `instructions` / `config` event. No polling: the only timers are
// the one-shot debounces. Blind reader — writes nothing.
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { isAlive, profileMeta } from "../heartbeat.js";
import { MARKER } from "../profile.js";
import { controlSockPath } from "../paths.js";
import {
  EVENTS_TAIL_BYTES,
  STATE_FILES,
  buildRows,
  hashFile,
  instructionEntries,
  isObj,
  parseEventLine,
  profileView,
  readJson,
  readStateFile,
  seedEventsTail,
} from "./rows.js";

export const DEBOUNCE_MS = 50;

const SOCK = "control.sock";
const WATCHED = new Set(["heartbeat.json", "server.pid", MARKER, "events.jsonl", SOCK, ...Object.values(STATE_FILES).map((f) => f[0])]);
/** @type {[import('./rows.js').StateKey, string][]} */
const STATE_KEYS = /** @type {any} */ (Object.entries(STATE_FILES).map(([k, f]) => [k, f[0]]));

/** @param {any} v */
const hash = (v) => JSON.stringify(v);

/**
 * @typedef {object} Prof
 * @property {string} name                    the state key (dir name)
 * @property {any} marker                    parsed profile.json (label + provenance; heartbeat.name wins the label)
 * @property {string} dir
 * @property {string} sockPath
 * @property {fs.FSWatcher|null} fsw
 * @property {NodeJS.Timeout|null} timer
 * @property {Set<string>|null} dirty         changed filenames since the last flush; null = everything
 * @property {boolean} removed
 * @property {any} heartbeat
 * @property {number} pid                     server.pid
 * @property {import('./rows.js').ProfileState} state
 * @property {number[]} eventBytes            line size of each `state.events` entry (the buffer bound)
 * @property {number} eventTotal
 * @property {number} offset                  events.jsonl bytes consumed
 * @property {number} ino
 * @property {Buffer} partial                 a trailing line still being appended
 * @property {net.Socket|null} sock
 * @property {{ pid: number }|null} hello     set while the control socket is connected
 * @property {number} deadPid                 the pid whose socket closed — never "up" via the pid fallback
 * @property {boolean} retry                  a socket change arrived mid-connection: reconnect once it settles
 * @property {string} viewHash
 * @property {Map<string, { hash: string, row: import('./contract.js').TicketRow }>} rows
 * @property {string|null} configPath              heartbeat.configPath
 * @property {Map<string, fs.FSWatcher>} instrDirs   parent dir of an allowlisted file (or the config) → its watcher
 * @property {Map<string, string|null>} instrHashes  allowlisted path (and configPath) → last seen content hash
 * @property {Set<string>} instrDirty                paths touched since the last instructions flush
 * @property {NodeJS.Timeout|null} instrTimer
 */

/**
 * @param {string} registry  ~/.agenthook (overridable for tests)
 * @param {(ev: import('./contract.js').UiEvent) => void} onEvent
 * @returns {{ snapshot(): import('./contract.js').Snapshot, noteWrite(profile: string, file: string, hash: string): void, close(): void }}
 */
export function createWatcher(registry, onEvent) {
  const posix = process.platform !== "win32";
  /** @type {Map<string, Prof>} */
  const profiles = new Map();
  /** @type {fs.FSWatcher|null} */
  let regWatcher = null;
  /** @type {NodeJS.Timeout|null} */
  let regTimer = null;
  let closed = false;

  /** @param {import('./contract.js').UiEvent} ev */
  const emit = (ev) => {
    if (closed) return;
    try {
      onEvent(ev);
    } catch {
      /* a broken subscriber must not stop the watcher */
    }
  };

  /** Liveness: a connected control socket wins; otherwise the pidfile pid, unless it's the
   * pid whose socket we just saw close (the receiver is exiting).
   * @param {Prof} p */
  const up = (p) => !!p.hello || (!!p.pid && p.pid !== p.deadPid && isAlive(p.pid));

  /** Provenance (profileMeta) is re-derived on every recompute: ghost-ness and config existence
   * aren't watched, only refreshed whenever something in the state dir changes.
   * @param {Prof} p */
  const view = (p) =>
    profileView({
      name: p.name,
      label: typeof p.marker?.name === "string" ? p.marker.name : undefined,
      pid: p.pid || p.hello?.pid || 0,
      up: up(p),
      heartbeat: p.heartbeat,
      ...profileMeta(p.dir, p.heartbeat, p.marker),
      events: p.state.events,
    });

  /** @param {Prof} p */
  const rowsOf = (p) =>
    buildRows(p.name, p.state, { repository: isObj(p.heartbeat) ? p.heartbeat.repository : null, up: up(p) });

  /** Re-derive the profile's view + rows and emit what changed. @param {Prof} p @param {boolean} [silent] */
  function recompute(p, silent = false) {
    if (closed || p.removed) return;
    const v = view(p);
    const vh = hash(v);
    if (vh !== p.viewHash) {
      p.viewHash = vh;
      if (!silent) emit({ type: "profile", profile: v });
    }
    const seen = new Set();
    for (const row of rowsOf(p)) {
      seen.add(row.ref);
      const h = hash(row);
      if (p.rows.get(row.ref)?.hash === h) continue;
      p.rows.set(row.ref, { hash: h, row });
      if (!silent) emit({ type: "ticket", ticket: row });
    }
    for (const ref of [...p.rows.keys()]) {
      if (seen.has(ref)) continue;
      p.rows.delete(ref);
      if (!silent) emit({ type: "ticket_removed", profile: p.name, ref });
    }
  }

  /** @param {Prof} p @param {Record<string, any>} e @param {number} bytes */
  function pushEvent(p, e, bytes) {
    p.state.events.push(e);
    p.eventBytes.push(bytes);
    p.eventTotal += bytes;
    // Same budget as the snapshot's readEventsTail, so row costUsd agrees with a fresh load.
    while (p.eventTotal > EVENTS_TAIL_BYTES && p.state.events.length > 1) {
      p.state.events.shift();
      p.eventTotal -= /** @type {number} */ (p.eventBytes.shift());
    }
  }

  /** @param {Prof} p */
  function resetEvents(p) {
    p.state.events = [];
    p.eventBytes = [];
    p.eventTotal = 0;
    p.offset = 0;
    p.partial = Buffer.alloc(0);
  }

  /** Read only the bytes appended since the last read; emit one `event` per complete line. @param {Prof} p */
  function tailEvents(p) {
    let fd;
    try {
      fd = fs.openSync(path.join(p.dir, "events.jsonl"), "r");
    } catch {
      if (p.offset || p.state.events.length) resetEvents(p); // deleted
      p.ino = 0;
      return;
    }
    /** @type {Buffer} */
    let chunk = Buffer.alloc(0);
    try {
      const st = fs.fstatSync(fd);
      // Truncated or replaced: start over from byte 0 (the old lines are gone from disk too).
      if (st.size < p.offset || (p.ino && st.ino !== p.ino)) resetEvents(p);
      p.ino = st.ino;
      if (st.size > p.offset) {
        chunk = Buffer.alloc(st.size - p.offset);
        let off = 0;
        while (off < chunk.length) {
          const n = fs.readSync(fd, chunk, off, chunk.length - off, p.offset + off);
          if (n <= 0) break;
          off += n;
        }
        chunk = chunk.subarray(0, off);
        p.offset += off;
      }
    } catch {
      return;
    } finally {
      fs.closeSync(fd);
    }
    if (!chunk.length) return;
    let buf = p.partial.length ? Buffer.concat([p.partial, chunk]) : chunk;
    let nl;
    while ((nl = buf.indexOf(0x0a)) !== -1) {
      const e = parseEventLine(buf.subarray(0, nl).toString("utf8"));
      if (e) {
        pushEvent(p, e, nl + 1);
        emit({ type: "event", profile: p.name, event: e });
      }
      buf = buf.subarray(nl + 1);
    }
    p.partial = Buffer.from(buf); // copy: don't pin the whole read buffer
  }

  /** @param {Prof} p @param {Set<string>|null} names */
  function readFiles(p, names) {
    const all = names === null;
    for (const [key, file] of STATE_KEYS) {
      if (all || names.has(file)) p.state[key] = readStateFile(p.dir, key, p.state[key]);
    }
    if (all || names.has("heartbeat.json")) p.heartbeat = readJson(path.join(p.dir, "heartbeat.json"), null, isObj, p.heartbeat);
    if (all || names.has(MARKER)) p.marker = readJson(path.join(p.dir, MARKER), null, isObj, p.marker);
    if (all || names.has("server.pid")) {
      try {
        const n = Number(fs.readFileSync(path.join(p.dir, "server.pid"), "utf8").trim());
        if (Number.isInteger(n) && n > 0) p.pid = n; // empty / torn → keep the last good pid
      } catch (e) {
        if (e.code === "ENOENT") p.pid = 0;
      }
    }
  }

  /** Connect to the control socket. Only ever called from a dir event (or once on discovery).
   * @param {Prof} p */
  function connect(p) {
    if (closed || p.removed) return;
    if (p.sock) {
      p.retry = true;
      return;
    }
    p.retry = false;
    const sock = net.connect(p.sockPath);
    p.sock = sock;
    let buf = "";
    sock.setEncoding("utf8");
    sock.on("data", (/** @type {string} */ data) => {
      if (p.hello || p.sock !== sock) return;
      buf += data;
      const nl = buf.indexOf("\n");
      if (nl === -1) {
        if (buf.length > 4096) sock.destroy();
        return;
      }
      /** @type {any} */
      let msg = null;
      try {
        msg = JSON.parse(buf.slice(0, nl));
      } catch {
        /* not a receiver */
      }
      if (!isObj(msg) || msg.type !== "hello") return void sock.destroy();
      p.hello = { pid: Number.isInteger(msg.pid) ? msg.pid : 0 };
      recompute(p);
    });
    sock.on("error", () => {
      /* ENOENT / ECONNREFUSED → no socket: the pid fallback stands; "close" follows */
    });
    sock.on("close", () => {
      if (p.sock !== sock) return;
      p.sock = null;
      if (p.hello) {
        p.deadPid = p.hello.pid || p.pid;
        p.hello = null;
      }
      recompute(p); // immediate: the receiver is gone, no debounce
      if (p.retry) connect(p);
    });
  }

  /** Mark changed allowlisted files in `dir` (all of them for a nameless event) and debounce.
   * @param {Prof} p @param {string} dir @param {string|null} file */
  function touchInstr(p, dir, file) {
    if (closed || p.removed) return;
    if (file === null) {
      for (const f of p.instrHashes.keys()) if (path.dirname(f) === dir) p.instrDirty.add(f);
    } else {
      const f = path.join(dir, file);
      if (!p.instrHashes.has(f)) return;
      p.instrDirty.add(f);
    }
    if (!p.instrTimer) p.instrTimer = setTimeout(() => flushInstr(p), DEBOUNCE_MS);
  }

  /** Re-hash the touched files; emit only a real content change (a touch is no change). @param {Prof} p */
  function flushInstr(p) {
    p.instrTimer = null;
    if (closed || p.removed) return;
    const dirty = p.instrDirty;
    p.instrDirty = new Set();
    for (const f of dirty) {
      if (!p.instrHashes.has(f)) continue; // dropped from the allowlist meanwhile
      const h = hashFile(f);
      if (h === p.instrHashes.get(f)) continue;
      p.instrHashes.set(f, h);
      if (f === p.configPath) emit({ type: "config", profile: p.name, hash: h, source: "disk" });
      else emit({ type: "instructions", profile: p.name, path: f, hash: h, source: "disk" });
    }
  }

  /** Reconcile the instruction dir watchers with the heartbeat's allowlist + configPath: watch
   * new parent dirs (a missing one is skipped), close dropped ones, and seed new paths' hashes
   * silently.
   * @param {Prof} p */
  function syncInstr(p) {
    if (closed || p.removed) return;
    const paths = new Set(instructionEntries(p.heartbeat).map((e) => e.path));
    const cp = isObj(p.heartbeat) && typeof p.heartbeat.configPath === "string" && p.heartbeat.configPath ? p.heartbeat.configPath : null;
    p.configPath = cp;
    if (cp) paths.add(cp);
    for (const f of [...p.instrHashes.keys()]) if (!paths.has(f)) p.instrHashes.delete(f);
    for (const f of paths) if (!p.instrHashes.has(f)) p.instrHashes.set(f, hashFile(f));
    const dirs = new Set([...paths].map((f) => path.dirname(f)));
    for (const [d, w] of [...p.instrDirs]) {
      if (dirs.has(d)) continue;
      w.close();
      p.instrDirs.delete(d);
    }
    for (const d of dirs) {
      if (p.instrDirs.has(d)) continue;
      try {
        const w = fs.watch(d, (_ev, f) => touchInstr(p, d, f == null ? null : String(f)));
        w.on("error", () => {
          w.close();
          if (p.instrDirs.get(d) === w) p.instrDirs.delete(d);
        });
        p.instrDirs.set(d, w);
      } catch {
        /* dir doesn't exist (yet) — picked up on a later heartbeat change */
      }
    }
  }

  /** @param {Prof} p */
  function closeInstr(p) {
    for (const w of p.instrDirs.values()) w.close();
    p.instrDirs.clear();
    if (p.instrTimer) clearTimeout(p.instrTimer);
    p.instrTimer = null;
  }

  /** @param {Prof} p */
  function flush(p) {
    p.timer = null;
    if (closed || p.removed) return;
    const names = p.dirty;
    p.dirty = new Set();
    readFiles(p, names);
    if (names === null || names.has("heartbeat.json")) syncInstr(p);
    if (names === null || names.has("events.jsonl")) tailEvents(p);
    recompute(p);
    // Reconnect only on a socket-file change; win32's named pipe has no file, so a
    // receiver (re)start shows up as server.pid / heartbeat.json instead.
    const sockChanged = posix ? names?.has(SOCK) : names?.has("server.pid") || names?.has("heartbeat.json");
    if (names === null || sockChanged) connect(p);
  }

  /** @param {Prof} p @param {string|null} file */
  function touch(p, file) {
    if (closed || p.removed) return;
    if (file === null) p.dirty = null;
    else if (!WATCHED.has(file)) return;
    else p.dirty?.add(file);
    if (!p.timer) p.timer = setTimeout(() => flush(p), DEBOUNCE_MS);
  }

  /** Start tracking a profile dir. @param {string} name @param {boolean} silent */
  function addProfile(name, silent) {
    const dir = path.join(registry, name);
    /** @type {Prof} */
    const p = {
      name,
      marker: null,
      dir,
      sockPath: controlSockPath(dir, name),
      fsw: null,
      timer: null,
      dirty: new Set(),
      removed: false,
      heartbeat: null,
      pid: 0,
      state: { running: {}, queue: [], held: {}, refmeta: {}, events: [] },
      eventBytes: [],
      eventTotal: 0,
      offset: 0,
      ino: 0,
      partial: Buffer.alloc(0),
      sock: null,
      hello: null,
      deadPid: 0,
      retry: false,
      viewHash: "",
      rows: new Map(),
      configPath: null,
      instrDirs: new Map(),
      instrHashes: new Map(),
      instrDirty: new Set(),
      instrTimer: null,
    };
    profiles.set(name, p);
    try {
      p.fsw = fs.watch(dir, (_ev, f) => touch(p, f == null ? null : String(f)));
      p.fsw.on("error", () => {
        p.fsw?.close();
        p.fsw = null;
      });
    } catch {
      /* dir vanished already — the registry watch will remove it */
    }
    readFiles(p, null);
    syncInstr(p);
    // Seed the events buffer once from the tail; from here on only appended bytes are read.
    const eventsFile = path.join(dir, "events.jsonl");
    const seed = seedEventsTail(eventsFile);
    for (const e of seed.events) pushEvent(p, e, Buffer.byteLength(JSON.stringify(e)) + 1);
    p.offset = seed.end;
    try {
      p.ino = fs.statSync(eventsFile).ino;
    } catch {
      p.ino = 0;
    }
    recompute(p, silent);
    connect(p);
  }

  /** @param {Prof} p */
  function removeProfile(p) {
    p.removed = true;
    profiles.delete(p.name);
    p.fsw?.close();
    if (p.timer) clearTimeout(p.timer);
    closeInstr(p);
    p.sock?.destroy();
    for (const ref of p.rows.keys()) emit({ type: "ticket_removed", profile: p.name, ref });
    emit({ type: "profile_removed", name: p.name });
  }

  /** Diff the registry's subdirs against the known set. @param {boolean} silent */
  function scan(silent) {
    regTimer = null;
    if (closed) return;
    /** @type {Set<string>} */
    let names;
    try {
      names = new Set(
        fs
          .readdirSync(registry, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => d.name),
      );
    } catch {
      // Registry gone: drop everything and wait for it to come back.
      for (const p of [...profiles.values()]) removeProfile(p);
      watchParent();
      return;
    }
    for (const p of [...profiles.values()]) if (!names.has(p.name)) removeProfile(p);
    for (const n of [...names].sort()) if (!profiles.has(n)) addProfile(n, silent);
  }

  const scheduleScan = () => {
    if (!closed && !regTimer) regTimer = setTimeout(() => scan(false), DEBOUNCE_MS);
  };

  /** @param {boolean} silent */
  function watchRegistry(silent) {
    regWatcher?.close();
    regWatcher = null;
    try {
      regWatcher = fs.watch(registry, scheduleScan);
      regWatcher.on("error", () => {
        regWatcher?.close();
        regWatcher = null;
        scheduleScan();
      });
    } catch {
      return watchParent();
    }
    scan(silent);
  }

  /** The registry doesn't exist (yet): watch its parent for it to appear. */
  function watchParent() {
    regWatcher?.close();
    regWatcher = null;
    if (closed) return;
    const base = path.basename(registry);
    try {
      regWatcher = fs.watch(path.dirname(registry), (_ev, f) => {
        if (f != null && String(f) !== base) return;
        try {
          if (!fs.statSync(registry).isDirectory()) return;
        } catch {
          return;
        }
        watchRegistry(false);
      });
      regWatcher.on("error", () => {
        regWatcher?.close();
        regWatcher = null;
      });
    } catch {
      /* parent missing too — nothing to watch */
    }
  }

  watchRegistry(true);

  return {
    snapshot() {
      /** @type {import('./contract.js').Snapshot} */
      const snap = { profiles: [], tickets: [] };
      for (const name of [...profiles.keys()].sort()) {
        const p = /** @type {Prof} */ (profiles.get(name));
        snap.profiles.push(view(p));
        for (const { row } of p.rows.values()) snap.tickets.push(row);
      }
      return snap;
    },
    /** The server just saved `file` (now `hash`) — an instruction file or the config: record
     * it so the dir watch that follows sees no change and doesn't re-broadcast the save as an
     * external edit.
     * @param {string} profile @param {string} file @param {string} hash */
    noteWrite(profile, file, hash) {
      const p = profiles.get(profile);
      if (p && p.instrHashes.has(file)) p.instrHashes.set(file, hash);
    },
    close() {
      closed = true;
      regWatcher?.close();
      regWatcher = null;
      if (regTimer) clearTimeout(regTimer);
      for (const p of profiles.values()) {
        p.removed = true;
        p.fsw?.close();
        if (p.timer) clearTimeout(p.timer);
        closeInstr(p);
        p.sock?.destroy();
      }
      profiles.clear();
    },
  };
}
