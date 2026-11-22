// `agenthook top` renderer — the operator's glance view over a tick payload (src/agent-api.js
// `readTick`, local state only; `src/commands/tick.js` `digest` is the dense agent-oriented one).
// Always a header, then the needs-you rows (held → failed → PR) and the running rows, then one
// queued-count line. Glance rule: a state marker, id/ref, step, age and a truncated title — no
// cost, model, harness, ctx or reasons. Pure: no I/O, no `process.*`, no `Date.now()`; the
// caller passes `width`, `now` and `color`.
/** Strip ANSI SGR sequences. @param {string} s */
function plain(s) {
  return s.replace(/\u001b\[[0-9;?]*m/g, "");
}

/** Visible length in code points (ANSI stripped). @param {string} s */
function len(s) {
  return [...plain(s)].length;
}

/** Shorten to at most `n` visible code points, ending in `…` when cut. @param {string} s @param {number} n */
function cut(s, n) {
  const cps = [...plain(s)];
  return cps.length <= n ? s : cps.slice(0, Math.max(0, n - 1)).join("") + "…";
}

/** "3m" under the hour, "1h05m" under the day, "2d" after — or "-" for a missing/invalid age. @param {number|null} sec */
function age(sec) {
  if (typeof sec !== "number" || !Number.isFinite(sec) || sec < 0) return "-";
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${String(m - h * 60).padStart(2, "0")}m`;
  return `${Math.floor(h / 24)}d`;
}

/** Seconds between an ISO `ts` and `now`, or null when `ts` is missing/invalid. @param {string|undefined} ts @param {number|undefined} now */
function ageFrom(ts, now) {
  if (typeof now !== "number" || typeof ts !== "string") return null;
  const t = Date.parse(ts);
  return Number.isNaN(t) ? null : Math.max(0, (now - t) / 1000);
}

/** A tick entry rendered as a row (the age comes from `since`/`at`/`ageS` depending on its kind). */
/** @typedef {{ref: string, id?: string, step?: string, title?: string, since?: string, at?: string, ageS?: number|null}} RowEntry */

/** The payload `renderTop` reads: `src/agent-api.js` `readTick` output, local-only fields. */
/** @typedef {{profile?: string, up?: boolean, slots?: {max?: number|null, active?: number, queued?: number}, held?: RowEntry[], failed?: RowEntry[], prWaiting?: RowEntry[], running?: RowEntry[]}} TopTick */

/**
 * One row: `MARKER id step age title`, the title truncated first and the whole visible line
 * truncated with `…` only if the fixed part alone overflows `width`. Indented two spaces.
 * @param {string} mk state marker (plain text — reads without color)
 * @param {RowEntry} r tick entry (ref/id, step, title, plus the age source)
 * @param {string} el formatted elapsed
 * @param {number} width
 * @param {boolean} color
 */
function row(mk, r, el, width, color) {
  const fixed = [mk, r.id ?? r.ref, r.step ?? (mk === "PR" ? "PR" : undefined), el].filter((p) => p !== undefined).join(" ");
  const w = width - 2; // the indent
  let out;
  if (len(fixed) >= w) out = cut(fixed, w);
  else {
    const budget = w - len(fixed) - 1;
    const title = r.title && budget >= 1 ? cut(String(r.title), budget).trimEnd() : "";
    out = title ? `${fixed} ${title}` : fixed;
  }
  const marked = `\u001b[1m${mk}\u001b[0m`;
  return `  ${color ? out.replace(mk, marked) : out}`;
}

/**
 * The header + rows both renderers share. `header` is the (color-applied) line 0;
 * `needs` the needs-you rows (held → failed → PR) and `running` the running rows —
 * neither includes the queued-count line (the header already carries that count).
 * @param {TopTick} t
 * @param {{width?: number, now?: number, color?: boolean}} [o]
 * @returns {{header: string, needs: string[], running: string[]}}
 */
function build(t, { width = 80, now, color = false } = {}) {
  const s = t.slots ?? {};
  const held = t.held ?? [];
  const failed = t.failed ?? [];
  const prWaiting = t.prWaiting ?? [];
  const running = t.running ?? [];
  const needsYou = held.length + failed.length + prWaiting.length;
  const header = cut(`${t.profile} ${t.up ? "up" : "down"} · agents ${s.active ?? 0}/${s.max ?? "?"} · ${s.queued ?? 0} queued · ${needsYou} needs you`, width);
  /** @param {string} mk @param {RowEntry} r @param {string} el */
  const line = (mk, r, el) => row(mk, r, el, width, color);
  /** @type {string[]} */
  const needs = [];
  for (const r of held) needs.push(line("HELD", r, age(ageFrom(r.since, now))));
  for (const r of failed) needs.push(line("FAIL", r, age(ageFrom(r.at, now))));
  for (const r of prWaiting) needs.push(line("PR", r, age(ageFrom(r.at, now))));
  /** @type {string[]} */
  const runs = [];
  for (const r of running) runs.push(line("RUN", r, age(r.ageS ?? null)));
  return { header: color ? `\u001b[1m${header}\u001b[0m` : header, needs, running: runs };
}

/**
 * Render the one-shot glance. Line 0 is always the header:
 * `<profile> up|down · agents <active>/<max or ?> · <queued> queued · <N> needs you`,
 * N = held + failed + prWaiting. With `up:false` it returns the header alone.
 * @param {TopTick} t a status/tick payload (src/agent-api.js `readTick`)
 * @param {{width?: number, now?: number, color?: boolean}} [o] `now` (ms) — no clock in here; omitted ages render "-"
 * @returns {string[]}
 */
export function renderTop(t, { width = 80, now, color = false } = {}) {
  const { header, needs, running } = build(t, { width, now, color });
  const lines = [header];
  if (!t.up) return lines;
  lines.push(...needs, ...running);
  const queued = t.slots?.queued ?? 0;
  if (queued > 0) lines.push(color ? `  \u001b[1m${queued} queued\u001b[0m` : `  ${queued} queued`);
  return lines;
}

/**
 * Render the strip (#796): the glance cut to at most `lines` lines for a fixed-height
 * terminal pane. Line 0 is the same header as `renderTop`'s line 0 (the queued count lives
 * in it — there is no queued line here). Rows are needs-you (held → failed → PR), then
 * running; when they don't fit the last line is `  +K more · A needs you · B running`
 * (K hidden rows, A/B the hidden needs-you / running split, both counts always printed).
 * With `up:false` or `lines <= 1` it returns the header alone. Never returns more than
 * `lines` lines.
 * @param {TopTick} t a status/tick payload (src/agent-api.js `readTick`)
 * @param {{lines: number, width?: number, now?: number, color?: boolean}} o `lines` the strip height (≥ 1); `now` (ms) as `renderTop`
 * @returns {string[]}
 */
export function renderStrip(t, { lines, width = 80, now, color = false }) {
  const { header, needs, running } = build(t, { width, now, color });
  if (!t.up || lines <= 1) return [header];
  const rows = [...needs, ...running];
  const budget = lines - 1; // the header's line
  if (rows.length <= budget) return [header, ...rows];
  const shown = budget - 1; // leave the last line for the overflow summary
  const out = [header, ...rows.slice(0, shown)];
  const a = needs.length - Math.min(needs.length, shown); // hidden needs-you rows
  const k = rows.length - shown; // hidden rows
  out.push(cut(`  +${k} more · ${a} needs you · ${k - a} running`, width));
  return out;
}
