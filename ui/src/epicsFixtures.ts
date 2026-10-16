// Test-only helpers: synthetic EpicStats / EpicDetail (never imported by app code, so not bundled).
import type { EpicBucket, EpicDetail, EpicDetailTicket, EpicStats } from "./contract";
import { day } from "./statsFixtures";

const ZERO: Record<EpicBucket, number> = { backlog: 0, running: 0, needsYou: 0, finished: 0, merged: 0, untracked: 0 };

/** 14 days ending 2026-10-16, `finished` per day from `counts` (zero-filled). */
export const velocityDays = (counts: number[] = []) =>
  Array.from({ length: 14 }, (_, i) => day(`2026-10-${String(3 + i).padStart(2, "0")}`, { finished: counts[i] ?? 0 }));

export function epicStats(over: Partial<Omit<EpicStats, "byStage">> & { ref: string; byStage?: Partial<Record<EpicBucket, number>> }): EpicStats {
  const byStage = { ...ZERO, ...over.byStage };
  const total = Object.values(byStage).reduce((n, v) => n + v, 0);
  return {
    name: `Epic ${over.ref}`,
    url: `https://app.asana.com/0/1/${over.ref}`,
    status: null,
    completed: false,
    total,
    needsYou: [],
    startedAt: null,
    velocity: { days: velocityDays(), finished14: 0, activeDays: 0, perDay: null },
    eta: null,
    ...over,
    byStage,
  };
}

export const epicTicket = (ref: string, bucket: EpicBucket, over: Partial<EpicDetailTicket> = {}): EpicDetailTicket => ({
  ref,
  name: `Ticket ${ref}`,
  completed: bucket === "finished" || bucket === "merged",
  stage: bucket === "untracked" ? null : "In progress",
  bucket,
  status: null,
  ...over,
});

export function epicDetail(over: Partial<EpicStats> & { ref: string }, tickets: EpicDetailTicket[]): EpicDetail {
  const byStage = { ...ZERO };
  for (const t of tickets) byStage[t.bucket]++;
  return { ...epicStats({ ...over, byStage }), needsYou: tickets.filter((t) => t.bucket === "needsYou").map((t) => t.ref), tickets };
}
