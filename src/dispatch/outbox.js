// Outbox: files a REMOTE (ssh) run's agent may leave next to its verdict — `pr.json`
// (title + body for a draft PR) and `comment.md` (a comment on the ticket). The agent
// never holds the tracker's or the forge's credentials, so it cannot post anything itself
// (#681 phase 5a): the hub copies the two files back over ssh (executor-ssh.js `done()`,
// same caps + symlink/FIFO refusal as the verdict copy-back) and publishes them with the
// hub's own credentials (src/dispatch/publish.js). Everything in the outbox is untrusted
// text: size-capped, never executed or shell-interpolated, and a comment that would
// self-trigger the `@agent` resume gate is dropped.
import fs from "node:fs";
import path from "node:path";
import { startsWithTrigger } from "../pipeline.js";

/** `pr.json` title cap (characters, after trim). GitHub's own limit is 60 KB; ours is smaller. */
export const OUTBOX_TITLE_MAX = 200;
/** `pr.json` body and `comment.md` cap (UTF-8 bytes). */
export const OUTBOX_FIELD_MAX_BYTES = 60 * 1024;
/** The only two names the ssh copy-back reads from the worker's outbox dir (executor-ssh.js). */
export const OUTBOX_FILE_NAMES = Object.freeze(["pr.json", "comment.md"]);
/** Per-file ssh copy-back cap (executor-ssh.js `head -c`). Larger than any VALID outbox file
 * (a valid pr.json is at most the body cap + title + JSON overhead); a larger file is dropped. */
export const OUTBOX_COPY_CAP_BYTES = 128 * 1024;

/** @typedef {{ pr?: { title: string, body: string }, comment?: string }} Outbox */

/**
 * Read and validate `<dir>/outbox/pr.json` and `<dir>/outbox/comment.md`. Pure apart from the fs reads and
 * never throws — every bad case is dropped with exactly ONE log line through `log` naming the
 * file and the reason: the outbox dir being a symlink or not a directory; an entry being a
 * symlink or not a regular file (FIFOs are never OPENED — lstat alone); any other filename in
 * the dir (never read); malformed JSON; wrong types; an empty, oversized or multi-line title;
 * an oversized body or comment; a `comment.md` that would self-trigger the configured resume
 * gate.
 * @param {string} dir  the hub-side per-run dir that CONTAINS the outbox dir (the dir the
 *    copied-back verdict came from — `path.dirname(verdictFile)`)
 * @param {(line: string) => void} log
 * @param {string|undefined} [trigger]  `cfg.trigger` — a `comment.md` starting with it is dropped,
 *    because the hub posts it under its OWN identity and would then act on it as an owner reply
 * @returns {Outbox}
 */
export function readOutbox(dir, log, trigger) {
  const out = /** @type {Outbox} */ ({});
  const boxDir = path.join(dir, "outbox");
  /** @param {string} line */
  const say = (line) => {
    try {
      log(line);
    } catch {
      /* a broken log must not take the step down */
    }
  };
  let dirStat;
  try {
    dirStat = fs.lstatSync(boxDir);
  } catch {
    return out; // no outbox dir at all — not an error
  }
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
    say(`[outbox] ignoring ${boxDir}: not a directory${dirStat.isSymbolicLink() ? " (symlink)" : ""}`);
    return out;
  }
  let names;
  try {
    names = fs.readdirSync(boxDir);
  } catch {
    return out; // the dir vanished between the lstat and the readdir — treat as no outbox
  }
  for (const name of names) {
    if (OUTBOX_FILE_NAMES.includes(name)) continue;
    // Never OPENED — readdir only — one line per unknown name so a planted payload is visible
    // in the run log without ever being read.
    say(`[outbox] ignoring outbox/${name}: not an outbox file (only pr.json and comment.md are read)`);
  }
  for (const name of OUTBOX_FILE_NAMES) {
    const file = path.join(boxDir, name);
    let st;
    try {
      st = fs.lstatSync(file);
    } catch {
      continue; // missing — fine
    }
    if (st.isSymbolicLink() || !st.isFile()) {
      say(`[outbox] ignoring outbox/${name}: ${st.isSymbolicLink() ? "symlink" : "not a regular file"}`);
      continue;
    }
    let buf;
    try {
      const fd = fs.openSync(file, "r");
      try {
        // The lstat above already proved it is a regular file, so readSync cannot block.
        const room = OUTBOX_FIELD_MAX_BYTES + 1;
        const b = Buffer.alloc(room);
        const n = fs.readSync(fd, b, 0, room, 0);
        buf = b.subarray(0, n);
      } finally {
        fs.closeSync(fd);
      }
    } catch (e) {
      say(`[outbox] ignoring outbox/${name}: unreadable (${e.message})`);
      continue;
    }
    if (buf.length > OUTBOX_FIELD_MAX_BYTES) {
      say(`[outbox] ignoring outbox/${name}: ${buf.length} bytes exceeds the ${OUTBOX_FIELD_MAX_BYTES}-byte cap`);
      continue;
    }
    if (name === "pr.json") {
      let parsed;
      try {
        parsed = JSON.parse(buf.toString("utf8"));
      } catch {
        say(`[outbox] ignoring outbox/pr.json: not valid JSON`);
        continue;
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        say(`[outbox] ignoring outbox/pr.json: not a JSON object`);
        continue;
      }
      if (typeof parsed.title !== "string") {
        say(`[outbox] ignoring outbox/pr.json: title is not a string`);
        continue;
      }
      const title = parsed.title.trim();
      if (title.length === 0) {
        say(`[outbox] ignoring outbox/pr.json: title is empty`);
        continue;
      }
      if (title.includes("\n") || title.includes("\r")) {
        say(`[outbox] ignoring outbox/pr.json: title is not a single line`);
        continue;
      }
      if (title.length > OUTBOX_TITLE_MAX) {
        say(`[outbox] ignoring outbox/pr.json: title is ${title.length} chars (cap ${OUTBOX_TITLE_MAX})`);
        continue;
      }
      if (typeof parsed.body !== "string") {
        say(`[outbox] ignoring outbox/pr.json: body is not a string`);
        continue;
      }
      if (Buffer.byteLength(parsed.body, "utf8") > OUTBOX_FIELD_MAX_BYTES) {
        say(`[outbox] ignoring outbox/pr.json: body exceeds the ${OUTBOX_FIELD_MAX_BYTES}-byte cap`);
        continue;
      }
      out.pr = { title, body: parsed.body };
    } else {
      const text = buf.toString("utf8");
      if (text.trim().length === 0) {
        say(`[outbox] ignoring outbox/comment.md: empty`);
        continue;
      }
      if (trigger && startsWithTrigger(trigger, text)) {
        say(`[outbox] ignoring outbox/comment.md: starts with the "${trigger}" trigger — it would self-trigger the resume gate`);
        continue;
      }
      out.comment = text;
    }
  }
  return out;
}
