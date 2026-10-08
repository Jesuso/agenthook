import type { TicketStatus } from "../contract";
import { STATUS_CLASS } from "./StatusBadge";

export type PillTone = "neutral" | "accent" | TicketStatus;

const TONE_CLASS: Record<PillTone, string> = {
  neutral: "text-muted bg-surface-raised border border-border",
  accent: "text-accent-fg bg-accent",
  ...STATUS_CLASS,
};

/** A small rounded label (a count, a version, a flag). */
export function Pill({ tone = "neutral", title, children }: { tone?: PillTone; title?: string; children: React.ReactNode }) {
  return (
    <span title={title} className={`inline-flex items-center rounded-full px-2 text-label font-medium whitespace-nowrap ${TONE_CLASS[tone]}`}>
      {children}
    </span>
  );
}
