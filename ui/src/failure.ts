// One plain line for a failed run's reason (the Needs-you row and its accessible name). The receiver
// writes reasons for the log, not for a glance: "sandbox (docker) could not start the run: service
// "bad" not ready within 5s (wait: false) — last log lines: …". The drawer keeps the full text.

const MAX = 90;

/** Cut a detail at its first " — " / newline (what follows is log context), then to MAX chars. */
const head = (s: string) => {
  const line = s.split(/\n| — /)[0].trim();
  return line.length > MAX ? `${line.slice(0, MAX - 1).trimEnd()}…` : line;
};

const CLASSES: [RegExp, (m: RegExpMatchArray) => string][] = [
  [/^interrupted by restart/i, () => "Interrupted when the receiver restarted"],
  [/^non-zero exit \((-?\d+)\)/i, (m) => `The agent exited with code ${m[1]}`],
  [/^timeout: exceeded maxMinutes=(\d+)/i, (m) => `Timed out after ${m[1]} min`],
  [/^timeout: no output for idleMinutes=(\d+)/i, (m) => `Stopped after ${m[1]} min without output`],
  [/^sandbox \([^)]*\) could not start the run: ([\s\S]*)/i, (m) => `Sandbox could not start: ${head(m[1])}`],
  [/^sandbox setup failed: ([\s\S]*)/i, (m) => `Sandbox setup failed: ${head(m[1])}`],
];

/** The one-line summary of a failure reason; null stays null (no reason recorded). */
export function failureSummary(reason: string | null | undefined): string | null {
  const r = reason?.trim();
  if (!r) return null;
  for (const [re, say] of CLASSES) {
    const m = r.match(re);
    if (m) return say(m);
  }
  return head(r);
}
