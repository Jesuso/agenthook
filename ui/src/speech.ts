// Read aloud (#560) over the browser's own `window.speechSynthesis`: no dependency, and nothing
// runs until a reader turns it on in the reading panel. The synth is read from `globalThis` at call
// time so tests can install a mock. One "currently speaking" source id is subscribable, so a
// SpeakButton can show its pressed state; while anything plays, Escape stops it and nothing else.

/** The Web Speech API is present (both the synth and the utterance constructor). */
export const speechSupported = (): boolean =>
  typeof globalThis.speechSynthesis !== "undefined" && typeof globalThis.SpeechSynthesisUtterance !== "undefined";

/**
 * Markdown as something a voice can read: fenced code becomes the words "code block", inline code,
 * links and images keep their text, a bare URL becomes "link", HTML tags and markdown syntax go,
 * and each line that doesn't already end in `.!?:` gets a `.` so the voice pauses.
 */
export function speechText(md: string): string {
  const code: string[] = [];
  const lines = md
    .replace(/\r\n?/g, "\n")
    // Fenced code (``` or ~~~); an unclosed fence runs to the end, as markdown renders it.
    // The body is optional (lazily, so an empty fence closes on the very next line).
    .replace(/^[ \t]*(`{3,}|~{3,})[^\n]*(?:\n(?:[\s\S]*?\n)??[ \t]*\1[ \t]*(?=\n|$)|[\s\S]*)/gm, "\ncode block\n")
    // Inline code keeps its text, untouched by the syntax stripping below.
    .replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_, _ticks, text: string) => `\u0000${code.push(text.trim()) - 1}\u0000`)
    // A link target may hold one level of balanced parens and a quoted title.
    .replace(/!\[([^\]]*)\]\((?:[^()\s]|\([^()\s]*\))*(?:\s+"[^"]*")?\)/g, "$1")
    .replace(/\[([^\]]+)\]\((?:[^()\s]|\([^()\s]*\))*(?:\s+"[^"]*")?\)/g, "$1")
    .replace(/<https?:\/\/[^>\s]+>/g, "link")
    .replace(/https?:\/\/[^\s<>()]+/g, "link")
    .replace(/<\/?[a-zA-Z][^>]*>/g, "")
    .split("\n");
  const out: string[] = [];
  for (const raw of lines) {
    // A table's |---|:--:| separator row, a thematic break.
    if ((raw.includes("|") && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(raw)) || /^\s*([-*_])(\s*\1){2,}\s*$/.test(raw)) continue;
    let line = raw
      .replace(/^\s{0,3}#{1,6}\s+/, "")
      .replace(/\s+#+\s*$/, "")
      .replace(/^\s*(>\s?)+/, "")
      .replace(/^\s*([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/, "")
      .replace(/^\s*\|/, "")
      .replace(/\|\s*$/, "")
      .replace(/\s*\|\s*/g, ", ")
      // Emphasis only as a flanked pair, so `2*3*4` and `a * b` keep their stars.
      .replace(/(^|[^\w*])(\*{1,3})(?=\S)(.*?\S)\2(?![\w*])/g, "$1$3")
      .replace(/~~/g, "")
      .replace(/(^|[^\w])_+([^_\n]+?)_+(?=[^\w]|$)/g, "$1$2")
      .replace(/\u0000(\d+)\u0000/g, (_, i: string) => code[Number(i)])
      .replace(/\s+/g, " ")
      .trim();
    if (!line) continue;
    if (!/[.!?:]$/.test(line)) line += ".";
    out.push(line);
  }
  return out.join(" ");
}

type Voice = Pick<SpeechSynthesisVoice, "lang" | "default" | "localService">;

/** The first voice in `lang`'s language (primary subtag, any case), preferring the system default,
 * then an on-device one; undefined when none matches (the browser then picks by `utterance.lang`). */
export function pickVoice<V extends Voice>(voices: readonly V[], lang: string): V | undefined {
  const primary = (l: string) => l.split(/[-_]/)[0].toLowerCase();
  const want = primary(lang);
  const match = voices.filter((v) => primary(v.lang) === want);
  return match.find((v) => v.default) ?? match.find((v) => v.localService) ?? match[0];
}

/** The keys not yet in `seen`, in order, each added to it: what is new since the page loaded. */
export function newEntries(seen: Set<string>, keys: string[]): string[] {
  const fresh: string[] = [];
  for (const k of keys) {
    if (seen.has(k)) continue;
    seen.add(k);
    fresh.push(k);
  }
  return fresh;
}

let playing: { u: SpeechSynthesisUtterance; id: string | null } | null = null;
const listeners = new Set<() => void>();

function setPlaying(next: typeof playing): void {
  playing = next;
  for (const fn of [...listeners]) fn();
}

/** The source id of the utterance playing now, or null. */
export const speakingId = (): string | null => playing?.id ?? null;
export const isSpeaking = (): boolean => playing !== null;

export function subscribeSpeaking(fn: () => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

let escapeBound = false;
/** Capture phase on window, ahead of the drawer's and the panel's Escape: only while speech plays. */
function onEscape(e: KeyboardEvent): void {
  if (e.key !== "Escape" || !playing) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  stopSpeech();
}

/**
 * Speak `text` at `rate` in the page's language. `interrupt` (a button press) cancels whatever is
 * playing or queued first; without it (auto-read) the utterance joins the browser's queue and never
 * cuts off speech already playing. `id` names the source for `speakingId`.
 */
export function speak(text: string, { rate = 1, interrupt, id = null }: { rate?: number; interrupt: boolean; id?: string | null }): void {
  const synth = globalThis.speechSynthesis;
  if (!speechSupported() || !text) return;
  if (!escapeBound && typeof window !== "undefined") {
    window.addEventListener("keydown", onEscape, true);
    escapeBound = true;
  }
  if (interrupt) synth.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.rate = rate;
  u.lang = document.documentElement.lang || "en";
  // Voices can be empty until `voiceschanged`; picking here, at speak time, sees them once loaded.
  const voice = pickVoice(synth.getVoices?.() ?? [], u.lang);
  if (voice) u.voice = voice;
  u.onstart = () => {
    if (playing?.u !== u) setPlaying({ u, id });
  };
  u.onend = u.onerror = () => {
    if (playing?.u === u) setPlaying(null);
  };
  if (interrupt) setPlaying({ u, id });
  synth.speak(u);
}

/** Stop the playing utterance and drop the queue. */
export function stopSpeech(): void {
  if (speechSupported()) globalThis.speechSynthesis.cancel();
  if (playing) setPlaying(null);
}
