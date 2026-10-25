import type { RunView } from "./contract";

/**
 * A run log read as a story. The agent's log holds one line per assistant message (written
 * between tool calls) and ends with its report in markdown, but nothing delimits messages: a
 * plain line between plain lines is a message on its own (a "beat"), while list items, headings,
 * their lead-in lines and blank-line-separated paragraphs are the report's prose.
 */
export type StoryBlock = { kind: "beat"; text: string } | { kind: "prose"; text: string } | { kind: "notice"; text: string };

const LIST = /^\s*([-*+]|\d+[.)])\s/;
const NOTICE = "[agenthook]";

export function storyBlocks(lines: string[]): StoryBlock[] {
  // The first line is the `# <id>  <title>` header the receiver writes; the drawer already shows it.
  const body = lines.length && lines[0].startsWith("# ") ? lines.slice(1) : lines;
  // A notice line ends a paragraph like a blank line does: the receiver appends it after the agent exits.
  const blank = (i: number) => i < 0 || i >= body.length || body[i].trim() === "" || body[i].startsWith(NOTICE);
  const nextText = (i: number) => {
    for (let j = i + 1; j < body.length; j++) if (body[j].trim() !== "") return body[j];
    return null;
  };
  const out: StoryBlock[] = [];
  const pushProse = (line: string) => {
    const last = out[out.length - 1];
    if (last?.kind === "prose") last.text += "\n" + line;
    else out.push({ kind: "prose", text: line });
  };
  for (let i = 0; i < body.length; i++) {
    const line = body[i];
    if (line.trim() === "") {
      if (out[out.length - 1]?.kind === "prose") pushProse("");
      continue;
    }
    if (line.startsWith(NOTICE)) {
      out.push({ kind: "notice", text: line.slice(NOTICE.length).trim() });
      continue;
    }
    const next = nextText(i);
    const prose =
      LIST.test(line) ||
      line.startsWith("#") ||
      (next !== null && LIST.test(next)) ||
      (blank(i - 1) && blank(i + 1) && i > 0) ||
      (out[out.length - 1]?.kind === "prose" && !blank(i - 1));
    if (prose) pushProse(line);
    else out.push({ kind: "beat", text: line });
  }
  for (const b of out) if (b.kind === "prose") b.text = b.text.trim();
  return out.filter((b) => b.text !== "");
}

/** Runs oldest first (the API lists newest first). */
export function chronological(runs: RunView[]): RunView[] {
  return [...runs].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
}

/** A run that sent the ticket back to an earlier step. */
export function isBounce(r: Pick<RunView, "outcome">): boolean {
  return r.outcome === "changes";
}

/**
 * Pipeline order as this ticket saw it: every `advance` from step a to the next run's step b says
 * a comes before b. Steps no advance orders keep their first-seen position.
 */
export function stepOrder(runs: RunView[]): string[] {
  const seq = chronological(runs);
  const seen: string[] = [];
  for (const r of seq) if (!seen.includes(r.step)) seen.push(r.step);
  const before = new Map<string, Set<string>>(seen.map((s) => [s, new Set()]));
  for (let i = 0; i + 1 < seq.length; i++) {
    const a = seq[i].step;
    const b = seq[i + 1].step;
    if (seq[i].outcome === "advance" && a !== b) before.get(b)?.add(a);
  }
  const out: string[] = [];
  const visit = (s: string, stack: Set<string>) => {
    if (out.includes(s) || stack.has(s)) return;
    stack.add(s);
    for (const p of seen) if (before.get(s)?.has(p)) visit(p, stack);
    out.push(s);
  };
  for (const s of seen) visit(s, new Set());
  return out;
}

/** A long idle stretch the time axis squeezed: where it sits (0–100) and how long it really was. */
export type AxisBreak = { x: number; ms: number };

/**
 * A time axis over run spans where long idle gaps (a hold waiting on a human overnight) are
 * squeezed to a fixed width, so the runs themselves stay readable. `x` maps a timestamp to 0–100.
 */
export function timeScale(spans: { start: number; end: number }[]): { x: (ms: number) => number; breaks: AxisBreak[]; t0: number; t1: number } {
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  if (sorted.length === 0) return { x: () => 0, breaks: [], t0: 0, t1: 0 };
  const active = sorted.reduce((a, s) => a + Math.max(0, s.end - s.start), 0);
  const cap = Math.max(60_000, active * 0.12);
  // Piecewise-linear [real, squeezed] anchors.
  const pts: [number, number][] = [[sorted[0].start, 0]];
  const gaps: { real: number; at: number }[] = [];
  let real = sorted[0].start;
  let comp = 0;
  for (const s of sorted) {
    const gap = s.start - real;
    if (gap > 0) {
      const w = Math.min(gap, cap);
      if (gap > cap) gaps.push({ real: gap, at: comp + w / 2 });
      comp += w;
      real = s.start;
      pts.push([real, comp]);
    }
    if (s.end > real) {
      comp += s.end - real;
      real = s.end;
      pts.push([real, comp]);
    }
  }
  const total = Math.max(comp, 1);
  const x = (ms: number) => {
    if (ms <= pts[0][0]) return 0;
    for (let i = 1; i < pts.length; i++) {
      const [r1, c1] = pts[i];
      if (ms <= r1) {
        const [r0, c0] = pts[i - 1];
        return ((c0 + ((ms - r0) / Math.max(r1 - r0, 1)) * (c1 - c0)) / total) * 100;
      }
    }
    return 100;
  };
  return { x, breaks: gaps.map((g) => ({ x: (g.at / total) * 100, ms: g.real })), t0: sorted[0].start, t1: real };
}
