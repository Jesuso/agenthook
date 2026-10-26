// One plain line for a failed run's reason (the Needs-you row and its accessible name). The receiver
// writes reasons for the log, not for a glance: "sandbox (docker) could not start the run: service
// "bad" not ready within 5s (wait: false) — last log lines: …". The drawer keeps the full text.
// The known classes are translated (`lang`, #562); the receiver's detail inside them stays as written.

import { translate } from "./i18n";
import type { MessageKey } from "./i18n";

const MAX = 90;

/** Cut a detail at its first " — " / newline (what follows is log context), then to MAX chars. */
const head = (s: string) => {
  const line = s.split(/\n| — /)[0].trim();
  return line.length > MAX ? `${line.slice(0, MAX - 1).trimEnd()}…` : line;
};

/** Each class: its pattern, its message, and the message's `{value}` from the match (if any). */
const CLASSES: [RegExp, MessageKey, (m: RegExpMatchArray) => string | undefined][] = [
  [/^interrupted by restart/i, "failure.interrupted", () => undefined],
  [/^non-zero exit \((-?\d+)\)/i, "failure.exitCode", (m) => m[1]],
  [/^timeout: exceeded maxMinutes=(\d+)/i, "failure.timedOut", (m) => m[1]],
  [/^timeout: no output for idleMinutes=(\d+)/i, "failure.idle", (m) => m[1]],
  [/^sandbox \([^)]*\) could not start the run: ([\s\S]*)/i, "failure.sandboxStart", (m) => head(m[1])],
  [/^sandbox setup failed: ([\s\S]*)/i, "failure.sandboxSetup", (m) => head(m[1])],
];

/** The one-line summary of a failure reason; null stays null (no reason recorded). */
export function failureSummary(reason: string | null | undefined, lang = "en"): string | null {
  const r = reason?.trim();
  if (!r) return null;
  for (const [re, key, value] of CLASSES) {
    const m = r.match(re);
    if (m) {
      const v = value(m);
      return translate(lang, key, v === undefined ? undefined : { value: v });
    }
  }
  return head(r);
}
