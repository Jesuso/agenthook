/** fullAuto: an amber shield — agents on this profile skip every permission prompt. */
export function FullAutoShield() {
  const text = "fullAuto: agents run with --dangerously-skip-permissions";
  return (
    <span title={text} aria-label={text} role="img" className="inline-flex text-status-held">
      <svg viewBox="0 0 16 16" className="size-3.5" fill="currentColor" aria-hidden="true">
        <path d="M8 1 2.5 3v4.2c0 3.4 2.3 6.4 5.5 7.8 3.2-1.4 5.5-4.4 5.5-7.8V3L8 1Z" />
      </svg>
    </span>
  );
}
