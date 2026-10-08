import type { TicketStatus } from "../contract";

// Full class strings (not built from `status`) so Tailwind's scanner sees every one.
export const STATUS_CLASS: Record<TicketStatus, string> = {
  running: "text-status-running bg-status-running-bg",
  queued: "text-status-queued bg-status-queued-bg",
  held: "text-status-held bg-status-held-bg",
  failed: "text-status-failed bg-status-failed-bg",
  done: "text-status-done bg-status-done-bg",
  idle: "text-status-idle bg-status-idle-bg",
};

/** A ticket status as dot + label in its status colour; the running dot pulses (not under reduced motion). */
export function StatusBadge({ status }: { status: TicketStatus }) {
  return (
    <span
      data-status={status}
      className={`inline-flex items-center gap-1.5 rounded-sm px-1.5 align-middle text-label font-medium whitespace-nowrap ${STATUS_CLASS[status]}`}
    >
      <span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full bg-current ${status === "running" ? "animate-status-pulse" : ""}`} />
      {status}
    </span>
  );
}
