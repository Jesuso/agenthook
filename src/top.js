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

/** A tick entry rendered as a row (the age comes from `since`/`at`/`ageS` depending on its kind;
 * running entries also carry `model`/`harness` from `running.json`, PR entries a `pr` URL). */
/** @typedef {{ref: string, id?: string, step?: string, title?: string, since?: string, at?: string, ageS?: number|null, model?: string, harness?: string, pr?: string}} RowEntry */

/** The payload `renderTop` reads: `src/agent-api.js` `readTick` output, local-only fields. */
/** @typedef {{profile?: string, up?: boolean, slots?: {max?: number|null, active?: number, queued?: number}, held?: RowEntry[], failed?: RowEntry[], prWaiting?: RowEntry[], running?: RowEntry[]}} TopTick */

/**
 * One row: `MARKER id step age title`, the title truncated first and the whole visible line
 * truncated with `…` only if the fixed part alone overflows `width`. Indented two spaces, or
 * `> ` when `selected` (which, with color, is also inverse video so it reads without color).
 * @param {string} mk state marker (plain text — reads without color)
 * @param {RowEntry} r tick entry (ref/id, step, title, plus the age source)
 * @param {string} el formatted elapsed
 * @param {number} width
 * @param {boolean} color
 * @param {boolean} [selected]
 */
function row(mk, r, el, width, color, selected = false) {
  const fixed = [mk, r.id ?? r.ref, r.step ?? (mk === "PR" ? "PR" : undefined), el].filter((p) => p !== undefined).join(" ");
  const w = width - 2; // the indent / `> `
  let out;
  if (len(fixed) >= w) out = cut(fixed, w);
  else {
    const budget = w - len(fixed) - 1;
    const title = r.title && budget >= 1 ? cut(String(r.title), budget).trimEnd() : "";
    out = title ? `${fixed} ${title}` : fixed;
  }
  const marked = `\u001b[1m${mk}\u001b[0m`;
  const body = color ? out.replace(mk, marked) : out;
  return selected && color ? `> \u001b[7m${body}\u001b[27m` : `${selected ? "> " : "  "}${body}`;
}

/**
 * The header + rows both renderers share. `header` is the (color-applied) line 0;
 * `needs` the needs-you rows (held → failed → PR) and `running` the running rows —
 * neither includes the queued-count line (the header already carries that count). `selected`
 * marks the row at that index over `needs` followed by `running` (the `> ` prefix).
 * @param {TopTick} t
 * @param {{width?: number, now?: number, color?: boolean, selected?: number}} [o]
 * @returns {{header: string, needs: string[], running: string[]}}
 */
export function build(t, { width = 80, now, color = false, selected } = {}) {
  const s = t.slots ?? {};
  const held = t.held ?? [];
  const failed = t.failed ?? [];
  const prWaiting = t.prWaiting ?? [];
  const running = t.running ?? [];
  const needsYou = held.length + failed.length + prWaiting.length;
  const header = cut(`${t.profile} ${t.up ? "up" : "down"} · agents ${s.active ?? 0}/${s.max ?? "?"} · ${s.queued ?? 0} queued · ${needsYou} needs you`, width);
  /** @param {string} mk @param {RowEntry} r @param {string} el @param {number} i index over needs+running */
  const line = (mk, r, el, i) => row(mk, r, el, width, color, selected === i);
  /** @type {string[]} */
  const needs = [];
  let i = 0;
  for (const r of held) needs.push(line("HELD", r, age(ageFrom(r.since, now)), i++));
  for (const r of failed) needs.push(line("FAIL", r, age(ageFrom(r.at, now)), i++));
  for (const r of prWaiting) needs.push(line("PR", r, age(ageFrom(r.at, now)), i++));
  /** @type {string[]} */
  const runs = [];
  for (const r of running) runs.push(line("RUN", r, age(r.ageS ?? null), i++));
  return { header: color ? `\u001b[1m${header}\u001b[0m` : header, needs, running: runs };
}

/**
 * Render the one-shot glance. Line 0 is always the header:
 * `<profile> up|down · agents <active>/<max or ?> · <queued> queued · <N> needs you`,
 * N = held + failed + prWaiting. With `up:false` it returns the header alone. `selected` marks
 * the row at that index over `selectable(t)` (needs-you then running) with the `> ` prefix —
 * omitted, the output is byte-identical to the unselected render.
 * @param {TopTick} t a status/tick payload (src/agent-api.js `readTick`)
 * @param {{width?: number, now?: number, color?: boolean, selected?: number}} [o] `now` (ms) — no clock in here; omitted ages render "-"
 * @returns {string[]}
 */
export function renderTop(t, { width = 80, now, color = false, selected } = {}) {
  const { header, needs, running } = build(t, { width, now, color, selected });
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

/** One selectable row: its kind (which selects its marker and hint) and the tick entry. */
/** @typedef {{kind: 'held'|'failed'|'pr'|'running', entry: RowEntry}} SelectableEntry */

/**
 * The ordered selectable entries — the needs-you rows (held → failed → PR) then the running
 * rows, the same order `renderTop` draws them. The header and the queued-count line are not
 * selectable. The live loop maps selection ↔ ref through this.
 * @param {TopTick} t a tick payload
 * @returns {SelectableEntry[]}
 */
export function selectable(t) {
  /** @type {SelectableEntry[]} */
  const out = [];
  for (const entry of t.held ?? []) out.push({ kind: "held", entry });
  for (const entry of t.failed ?? []) out.push({ kind: "failed", entry });
  for (const entry of t.prWaiting ?? []) out.push({ kind: "pr", entry });
  for (const entry of t.running ?? []) out.push({ kind: "running", entry });
  return out;
}

/**
 * The detail line for the row at `selected` over `selectable(t)`: `  <id ?? ref> · <step>`
 * plus, for a running row only, ` · harness <h>` / ` · model <m>` (each part left out when
 * absent) and ` · <title>` when the entry has one. Cut to `width`. Empty string when the
 * index has no entry. The one place harness/model appear — never on the rows.
 * @param {TopTick} t a tick payload
 * @param {number} selected index over `selectable(t)`
 * @param {{width?: number}} [o]
 * @returns {string}
 */
export function detailLine(t, selected, { width = 80 } = {}) {
  const sel = selectable(t)[selected];
  if (!sel) return "";
  const r = sel.entry;
  /** @type {string[]} */
  const parts = [r.id ?? r.ref];
  if (r.step) parts.push(r.step);
  if (sel.kind === "running") {
    if (r.harness) parts.push(`harness ${r.harness}`);
    if (r.model) parts.push(`model ${r.model}`);
  }
  if (r.title) parts.push(r.title);
  return cut(`  ${parts.join(" · ")}`, width);
}

/**
 * The Enter hint for a row that isn't running — the one-line "how to act on this", naming
 * only commands that exist (a held ticket resumes on an `@agent` reply; release/retry live in
 * `agenthook ui`). The running kind returns "" (Enter follows it instead). Cut to `width`.
 * @param {SelectableEntry} sel
 * @param {{width?: number}} [o]
 * @returns {string}
 */
export function hintLine(sel, { width = 80 } = {}) {
  const r = sel.entry;
  /** @type {string} */
  let h;
  switch (sel.kind) {
    case "held":
      h = 'held — reply "@agent <answer>" on the ticket, or release it in agenthook ui';
      break;
    case "failed":
      // the ref, not the display id: the hint names commands you paste into a shell, and
      // a tracker id (`#797`, `ID-1234`) isn't a valid argument to them
      h = `failed at ${r.step ?? "?"} — retry: agenthook run ${r.ref} ${r.step ?? ""} --force (or Retry in agenthook ui)`;
      break;
    case "pr":
      h = r.pr
        ? `PR awaiting you — ${r.pr} · agenthook recheck ${r.ref} if it already merged/closed`
        : `PR awaiting you — agenthook recheck ${r.ref} if it already merged/closed`;
      break;
    default:
      return "";
  }
  return cut(`  ${h}`, width);
}

/**
 * The short fixed key help for the `?` toggle (full mode only — strip mode has none, only
 * `q`/Ctrl-C there).
 * @returns {string[]}
 */
export function helpLines() {
  return ["  j/k ↑/↓ move · Enter follow (running) / hint · ? help · q quit"];
}
