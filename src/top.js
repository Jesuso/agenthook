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
export function cut(s, n) {
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
 * running entries also carry `model`/`harness` from `running.json`, PR entries a `pr` URL and
 * their `prNeeds` word in `kind`, held/failed entries their reason). */
/** @typedef {{ref: string, id?: string, step?: string, title?: string, since?: string, at?: string, ageS?: number|null, model?: string, harness?: string, pr?: string, kind?: string, reason?: string, why?: string}} RowEntry */

/** The payload `renderTop` reads: `src/agent-api.js` `readTick` output, local-only fields. */
/** @typedef {{profile?: string, up?: boolean, slots?: {max?: number|null, active?: number, queued?: number}, held?: RowEntry[], failed?: RowEntry[], prWaiting?: RowEntry[], running?: RowEntry[]}} TopTick */

/**
 * One row: `MARKER id step age title`, the title truncated first and the whole visible line
 * truncated with `…` only if the fixed part alone overflows `width`. Indented two spaces, or
 * `> ` when `selected` (which, with color, is also inverse video so it reads without color).
 * @param {string} mk state marker (plain text — reads without color)
 * @param {RowEntry} r tick entry (ref/id, step, title, plus the age source)
 * @param {string|undefined} el formatted elapsed (left `undefined` omits the age token instead of "-" — PR rows with an unknown `at`)
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
  // the selected row is inverse video: the marker's bold ends with `22` (not `0`, which would
  // also kill the inverse) so the whole row, not just the marker, stays inverted
  const marked = `\u001b[1m${mk}${color && selected ? "\u001b[22m" : "\u001b[0m"}`;
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
  /** @param {string} mk @param {RowEntry} r @param {string|undefined} el @param {number} i index over needs+running */
  const line = (mk, r, el, i) => row(mk, r, el, width, color, selected === i);
  /** @type {string[]} */
  const needs = [];
  let i = 0;
  for (const r of held) needs.push(line("HELD", r, age(ageFrom(r.since, now)), i++));
  for (const r of failed) needs.push(line("FAIL", r, age(ageFrom(r.at, now)), i++));
  for (const r of prWaiting) needs.push(line("PR", r, ageFrom(r.at, now) === null ? undefined : age(ageFrom(r.at, now)), i++)); // PR rows drop the age token when `at` is unknown (not "-")
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

/** The needs-you kind in words — the detail line says the kind, not the row's id/step/title
 * again. PR rows fold in their `prNeeds` word (an unknown or absent word reads "PR waiting").
 * @param {SelectableEntry} sel the selected row
 * @returns {string} */
export function needsYouKind(sel) {
  if (sel.kind === "held") return "held";
  if (sel.kind === "failed") return "failed";
  switch (sel.entry.kind) {
    case "openOnDone":
      return "PR open, ticket done";
    case "awaitingMerge":
      return "PR open, awaiting merge";
    case "mergedOpen":
      return "PR merged, ticket open";
    case "closedUnmerged":
      return "PR closed unmerged, ticket open";
    default:
      return "PR waiting";
  }
}

/** The detail line's parts for a selected row — the one place harness/model appear, and the
 * place a needs-you row adds information instead of repeating the row: the kind in words
 * (`held at <step>` / `failed at <step>` / the PR kind in words, bare without a step), then the
 * title (cut to the whole line — the row showed it cut shorter) and the row's reason. Running
 * rows keep `id · step · harness · model` — with the measured bits where absent left out — and
 * the title last.
 * @param {SelectableEntry} sel the selected row
 * @returns {string[]} the parts, joined ` · ` by the callers
 */
function detailParts(sel) {
  const r = sel.entry;
  if (sel.kind === "running") {
    /** @type {string[]} */
    const parts = [r.id ?? r.ref];
    if (r.step) parts.push(r.step);
    if (r.harness) parts.push(`harness ${r.harness}`);
    if (r.model) parts.push(`model ${r.model}`);
    if (r.title) parts.push(r.title);
    return parts;
  }
  const word = needsYouKind(sel);
  /** @type {string[]} */
  const parts = [sel.kind === "pr" ? word : r.step ? `${word} at ${r.step}` : word];
  if (r.title) parts.push(r.title);
  if (sel.kind === "held" && r.reason) parts.push(r.reason);
  if (sel.kind === "failed" && r.why) parts.push(r.why);
  return parts;
}

/**
 * The detail line for the row at `selected` over `selectable(t)` — `detailParts` cut to
 * `width`. Empty string when the index has no entry.
 * @param {TopTick} t a tick payload
 * @param {number} selected index over `selectable(t)`
 * @param {{width?: number}} [o]
 * @returns {string}
 */
export function detailLine(t, selected, { width = 80 } = {}) {
  const sel = selectable(t)[selected];
  if (!sel) return "";
  return cut(`  ${detailParts(sel).join(" · ")}`, width);
}

/**
 * The Enter hint for a row that isn't running — the one-line "how to act on this". The shell
 * command is the last thing cut at a narrow width: the `head` and the `extra` drop first, then
 * the head alone, and only a cut of the command alone is last (it is the only part of the line
 * that does anything). The running kind returns "" (Enter follows it instead). Cut to `width`.
 * @param {SelectableEntry} sel
 * @param {{width?: number}} [o]
 * @returns {string}
 */
export function hintLine(sel, { width = 80 } = {}) {
  const r = sel.entry;
  /** @type {string} */
  let head, cmd;
  /** @type {string|null} */
  let extra = null;
  switch (sel.kind) {
    case "held":
      head = 'held — reply "@agent <answer>" on the ticket, or release';
      cmd = "agenthook ui";
      break;
    case "failed":
      // the ref, not the display id: the hint names commands you paste into a shell, and
      // a tracker id (`#797`, `ID-1234`) isn't a valid argument to them
      head = `failed${r.step ? ` at ${r.step}` : ""} — retry`;
      cmd = `agenthook run ${r.ref}${r.step ? ` ${r.step}` : ""} --force`;
      extra = "or Retry in agenthook ui";
      break;
    case "pr":
      head = "PR awaiting you — if it already merged/closed";
      cmd = `agenthook recheck ${r.ref}`;
      extra = r.pr || null;
      break;
    default:
      return "";
  }
  const full = extra ? `  ${head}: ${cmd} · ${extra}` : `  ${head}: ${cmd}`;
  if (len(full) <= width) return full;
  const headCmd = `  ${head}: ${cmd}`;
  if (len(headCmd) <= width) return headCmd;
  const cmdOnly = `  ${cmd}`;
  if (len(cmdOnly) <= width) return cmdOnly;
  return `  ${cut(cmd, width - 2)}`;
}

/**
 * The short fixed key help for the `?` toggle (full mode only — strip mode has none, only
 * `q`/Ctrl-C there).
 * @returns {string[]}
 */
export function helpLines() {
  return ["  j/k ↑/↓ move · Enter follow (running) / hint · ? help · q quit"];
}

// ---------------------------------------------------------------- multi-profile view (--all, #798)

/** One profile's block in the `renderAll` fit computation: its tick, state key, whether it is
 * idle (no needs-you and no running rows), whether it renders at all, and its current line
 * count after the fit rules (`cut` — first block only, on truncation — caps its lines). */
/** @typedef {{tick: TopTick, profile: string, idle: boolean, shown: boolean, shownLen: number, cut?: number}} AllBlock */

/** A selectable row in the multi-profile view — the row's profile state key plus its kind and entry. */
/** @typedef {{profile: string, kind: 'held'|'failed'|'pr'|'running', entry: RowEntry}} SelectableAllEntry */

/**
 * Stable sort of several ticks into three groups: (1) needs-you (held + failed + prWaiting > 0),
 * (2) else running (running.length > 0), (3) the rest. Inside a group the input order
 * (registry order for `--all`, name order otherwise) is kept.
 * @param {TopTick[]} ticks
 * @returns {TopTick[]}
 */
export function orderProfiles(ticks) {
  const rank =
    /** @param {TopTick} t */
    (t) =>
      (t.held?.length ?? 0) + (t.failed?.length ?? 0) + (t.prWaiting?.length ?? 0) > 0 ? 0 : (t.running?.length ?? 0) > 0 ? 1 : 2;
  /** @type {[number, number, TopTick][]} */
  const ranked = ticks.map((t, i) => [rank(t), i, t]);
  return ranked.sort((a, b) => a[0] - b[0] || a[1] - b[1]).map((x) => x[2]);
}

/**
 * The fit computation `renderAll`/`selectableAll` share: order the profiles (`orderProfiles`),
 * size each block (header + its rows + the queued line in full mode), then, when `height` is
 * given and everything doesn't fit: (1) collapse every idle block (no needs-you and no running
 * rows) to its header line (the queued count stays in the header); (2) if it still doesn't fit,
 * keep whole blocks from the top while they fit in `height − 1` — the remaining line is reserved
 * for the `+K more profiles` line — and, if the first block alone exceeds `height − 1`, show it
 * cut to `height − 1` lines. `b.shown` marks a block that renders; `b.cut` (first block only, on
 * truncation) caps its lines.
 * @param {TopTick[]} ticks
 * @param {{height?: number, strip?: boolean}} [o] `height` the total line budget; `strip` strip mode (no queued line)
 * @returns {{blocks: AllBlock[]}}
 */
export function allLayout(ticks, { height, strip = false } = {}) {
  /** @type {AllBlock[]} */
  const blocks = orderProfiles(ticks).map((t) => {
    const needs = (t.held?.length ?? 0) + (t.failed?.length ?? 0) + (t.prWaiting?.length ?? 0);
    const runs = t.up ? (t.running?.length ?? 0) : 0;
    const queued = t.up && !strip && (t.slots?.queued ?? 0) > 0;
    return { tick: t, profile: t.profile ?? "", idle: needs === 0 && runs === 0, shown: true, cut: undefined, shownLen: 1 + needs + runs + (queued ? 1 : 0) };
  });
  const total = () => blocks.reduce((s, b) => s + b.shownLen, 0);
  if (typeof height === "number" && height > 0 && total() > height) {
    for (const b of blocks) if (b.idle && b.shownLen > 1) {
      b.shownLen = 1; // collapse idle blocks to their header (the queued count stays in it)
      b.cut = 1;
    }
    if (total() > height) {
      const budget = Math.max(0, height - 1); // the last line is the `+K more profiles` line
      let i = 0;
      while (i < blocks.length && blocks.slice(0, i + 1).reduce((s, b) => s + b.shownLen, 0) <= budget) i += 1;
      blocks.forEach((b, j) => {
        b.shown = j < i;
      });
      if (i === 0) {
        // the first block alone exceeds the budget: show it cut to budget lines, count the rest in K
        blocks[0].shown = true;
        blocks[0].cut = budget;
      }
    }
  }
  return { blocks };
}

/**
 * The selectable rows across profiles in on-screen order, each tagged with its profile state
 * key — only rows that are actually shown after the `allLayout` fit rules count (a cut block
 * contributes its first `cut − 1` rows; hidden blocks none). A down profile contributes its
 * needs-you rows only. Headers, queued lines and the `+K more profiles` line are not selectable.
 * @param {{blocks: AllBlock[]}} layout an `allLayout` result
 * @returns {SelectableAllEntry[]}
 */
export function selectableAll(layout) {
  /** @type {SelectableAllEntry[]} */
  const out = [];
  for (const b of layout.blocks) {
    if (!b.shown) continue;
    const t = b.tick;
    /** @type {{kind: 'held'|'failed'|'pr'|'running', entry: RowEntry}[]} */
    const local = [];
    for (const entry of t.held ?? []) local.push({ kind: "held", entry });
    for (const entry of t.failed ?? []) local.push({ kind: "failed", entry });
    for (const entry of t.prWaiting ?? []) local.push({ kind: "pr", entry });
    if (t.up) for (const entry of t.running ?? []) local.push({ kind: "running", entry });
    const shown = typeof b.cut === "number" ? Math.min(Math.max(0, b.cut - 1), local.length) : local.length; // the header takes line 1 of the cut
    for (const s of local.slice(0, shown)) out.push({ profile: b.profile, ...s });
  }
  return out;
}

/**
 * Render every profile in one view (#798): one block per profile in `orderProfiles` order.
 * A block starts with the same header as `build`; an **up** profile then has its needs-you
 * rows, its running rows and — in full/once mode only (not strip, mirroring `renderTop` /
 * `renderStrip`) — its `  N queued` line. A **down** profile shows its needs-you rows only
 * (nothing runs while the receiver is down), so a down profile with no needs-you rows is its
 * header line alone. With `height` the `allLayout` fit rules apply (idle collapse, then whole
 * trailing blocks → a final `  +K more profiles` line, an oversize first block cut), and the
 * result never has more than `height` lines. `selected` marks the row at that index over
 * `selectableAll(allLayout(ticks, {height, strip}))` — omitted, no row is marked.
 * @param {TopTick[]} ticks one tick payload per profile (`readTick` output, `profile` = state key)
 * @param {{width?: number, now?: number, color?: boolean, height?: number, strip?: boolean, selected?: number}} [o]
 * @returns {string[]}
 */
export function renderAll(ticks, { width = 80, now, color = false, height, strip = false, selected } = {}) {
  const layout = allLayout(ticks, { height, strip });
  const sels = selectableAll(layout);
  /** @type {string[]} */
  const out = [];
  for (const b of layout.blocks) {
    if (!b.shown) continue;
    const t = b.tick;
    // the local selected index: this block's rows start at the count of earlier selectable rows
    const localBase = sels.findIndex((s) => s.profile === b.profile);
    const { header, needs, running } = build(t, {
      width,
      now,
      color,
      selected: typeof selected === "number" && selected >= localBase && localBase >= 0 ? selected - localBase : undefined,
    });
    const rows = t.up ? [...needs, ...running] : [...needs];
    /** @type {string[]} */
    const lines = [header, ...rows];
    if (t.up && !strip && (t.slots?.queued ?? 0) > 0) lines.push(color ? `  \u001b[1m${t.slots?.queued} queued\u001b[0m` : `  ${t.slots?.queued} queued`);
    out.push(...(typeof b.cut === "number" ? lines.slice(0, b.cut) : lines));
  }
  const hidden = layout.blocks.filter((b) => !b.shown).length;
  if (hidden > 0) out.push(cut(`  +${hidden} more profiles`, width));
  return out;
}

/**
 * The detail line for the row at `selected` over `selectableAll(layout)` — `detailParts` with
 * the row's profile name first, cut to `width`. Empty string when the index has no entry.
 * @param {{blocks: AllBlock[]}} layout an `allLayout` result (the same one the frame was drawn from)
 * @param {number} selected index over `selectableAll(layout)`
 * @param {{width?: number}} [o]
 * @returns {string}
 */
export function detailAll(layout, selected, { width = 80 } = {}) {
  const sel = selectableAll(layout)[selected];
  if (!sel) return "";
  return cut(`  ${[sel.profile, ...detailParts({ kind: sel.kind, entry: sel.entry })].join(" · ")}`, width);
}
