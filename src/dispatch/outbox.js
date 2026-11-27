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

/** The fence line of a fenced code block: up to 3 leading spaces + 3-or-more backticks/tildes.
 * (A BACKTICK fence whose info string contains a backtick never opens a fence — CommonMark —
 * so a pseudo-fence like `` ``` a`b `` cannot smuggle live mentions past the neutralisation.) */
const FENCE = /^(\s{0,3})(`{3,}|~{3,})(.*)$/;
/** A GitHub-style mention target: `@user` or `@org/team` after start-of-text or a non-word
 * char (so `a@b.com` is never a mention). Text genuinely inside a code span or fenced block
 * is skipped by the protected-range check below, not by this regex — an UNMATCHED backtick is
 * literal text, and a mention after it must still be neutralised (fail closed). The login
 * itself may carry hyphens mid-name (GitHub allows them).
 */
const MENTION = /(^|[^\w])@([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\/[A-Za-z0-9._-]+)?)/g;

/**
 * Neutralise worker-written GitHub mentions before the hub publishes them under its own
 * identity (#829): wrap every `@user` / `@org/team` in backticks, which GitHub renders as
 * code and does NOT notify. `ownerLogin` (case-insensitive) is exempt. Text inside fenced
 * code blocks and inline code spans is left alone, as are emails (`a@b.com`). When no owner
 * login is known, EVERY mention is neutralised (fail closed). Code is detected CommonMark-
 * style: a fenced block only when the fence line really is a fence (a backtick fence with a
 * backtick in its info string is not), and an inline span only when the opening backtick run
 * is CLOSED by an equal-length run before the next blank line — an unmatched backtick is a
 * literal character, so a stray one cannot swallow the rest of the paragraph. Pure.
 * @param {string} text  the outbox PR title/body or comment
 * @param {string|undefined|null} [ownerLogin]  our tracker login, e.g. `octocat` (a leading `@` is stripped by the caller)
 * @returns {string}
 */
export function neutralizeMentions(text, ownerLogin) {
  if (typeof text !== "string") return text;
  const owner = ownerLogin && String(ownerLogin).length > 0 ? String(ownerLogin).toLowerCase() : null;
  const lines = text.split("\n");
  /** Per line: "fence" (whole line is code, untouched) or "text". */
  const kinds = new Array(lines.length).fill("text");
  let fenceChar = "";
  let fenceLen = 0;
  /** A backtick fence needs a backtick-free info string; a tilde fence always opens. */
  /** @param {RegExpMatchArray} m @returns {boolean} */
  const opensFence = (m) => !(m[2][0] === "`" && m[3].includes("`"));
  for (let i = 0; i < lines.length; i++) {
    const m = FENCE.exec(lines[i]);
    if (!fenceChar) {
      if (m && opensFence(m)) {
        fenceChar = m[2][0]; // opens a fenced block
        fenceLen = m[2].length;
        kinds[i] = "fence";
      }
    } else {
      kinds[i] = "fence"; // inside the fenced block — untouched
      if (m && m[2][0] === fenceChar && m[2].length >= fenceLen && m[3].trim() === "") fenceChar = ""; // closes the fenced block
    }
  }
  /** Absolute [start,end) offsets in `text` that are code (fence lines, matched inline spans). */
  /** @type {Array<[number, number]>} */
  const protectedRanges = [];
  const lineOffset = (/** @type {number} */ i) => lines.slice(0, i).reduce((n, l) => n + l.length + 1, 0);
  for (let i = 0; i < lines.length; i++) if (kinds[i] === "fence") protectedRanges.push([lineOffset(i), lineOffset(i) + lines[i].length]);
  // Inline code spans, paragraph by paragraph (a span cannot cross a blank line): an equal-
  // length run closes the opener; a run left UNOPENED-at-paragraph-end is literal text and
  // protects nothing.
  for (let i = 0; i < lines.length; i++) {
    if (kinds[i] === "fence" || lines[i].trim() === "") continue;
    let j = i;
    while (j < lines.length && kinds[j] !== "fence" && lines[j].trim() !== "") j++;
    const para = lines.slice(i, j).join("\n");
    const at = lineOffset(i);
    /** @type {Array<[number, number]>} */
    const runs = [...para.matchAll(/`+/g)].map((m) => [m.index, m[0].length]);
    /** @type {Array<[number, number]>} */
    const pairs = [];
    let open = -1;
    for (let k = 0; k < runs.length; k++) {
      if (open === -1) open = k;
      else if (runs[k][1] === runs[open][1]) {
        pairs.push([open, k]);
        open = -1;
      }
    } // an unmatched opener (open !== -1) is a literal backtick run — no protected range
    for (const [a, b] of pairs) protectedRanges.push([at + runs[a][0], at + runs[b][0] + runs[b][1]]);
  }
  /** Is the char at `pos` inside a protected (code) range? */
  const inCode = (/** @type {number} */ pos) => protectedRanges.some(([s, e]) => pos >= s && pos < e);
  let out = "";
  let last = 0;
  for (const m of text.matchAll(MENTION)) {
    const atM = m.index + m[1].length; // the @ itself
    if (inCode(atM)) continue; // inside a code span or fence — left alone
    if (owner !== null && m[2].toLowerCase() === owner) continue; // our own login stays live
    out += text.slice(last, atM) + "`@" + m[2] + "`";
    last = atM + 1 + m[2].length; // past the original `@who`
  }
  return out + text.slice(last);
}

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
