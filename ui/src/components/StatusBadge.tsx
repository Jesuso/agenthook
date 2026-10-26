import type { TicketStatus } from "../contract";
import type { MessageKey } from "../i18n";
import { useT } from "../i18n/react";

// Full class strings (not built from `status`) so Tailwind's scanner sees every one.
export const STATUS_CLASS: Record<TicketStatus, string> = {
  running: "text-status-running bg-status-running-bg",
  queued: "text-status-queued bg-status-queued-bg",
  held: "text-status-held bg-status-held-bg",
  interrupted: "text-status-interrupted bg-status-interrupted-bg",
  stalled: "text-status-stalled bg-status-stalled-bg",
  failed: "text-status-failed bg-status-failed-bg",
  done: "text-status-done bg-status-done-bg",
  cancelled: "text-status-cancelled bg-status-cancelled-bg",
  idle: "text-status-idle bg-status-idle-bg",
};

const STATUS_LABEL: Record<TicketStatus, MessageKey> = {
  running: "status.running",
  queued: "status.queued",
  held: "status.held",
  interrupted: "status.interrupted",
  stalled: "status.stalled",
  failed: "status.failed",
  done: "status.done",
  cancelled: "status.cancelled",
  idle: "status.idle",
};

/** A ticket status as dot + label in its status colour; the running dot pulses (not under reduced motion). */
export function StatusBadge({ status }: { status: TicketStatus }) {
  const { t } = useT();
  return (
    <span
      data-status={status}
      className={`inline-flex items-center gap-1.5 rounded-sm px-1.5 align-middle text-label font-medium whitespace-nowrap ${STATUS_CLASS[status]}`}
    >
      <span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full bg-current ${status === "running" ? "animate-status-pulse" : ""}`} />
      {t(STATUS_LABEL[status])}
    </span>
  );
}
