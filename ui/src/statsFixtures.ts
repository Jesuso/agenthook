// Test-only helper: a zeroed DayStats with overrides (never imported by app code, so not bundled).
import type { DayStats } from "./contract";

export const day = (date: string, over: Partial<DayStats> = {}): DayStats => ({
  date, finished: 0, merged: 0, runs: 0, rework: 0, failedRuns: 0, costUsd: 0, estUsd: 0, unestimatedRuns: 0, byStep: {},
  outcomes: { advance: 0, changes: 0, hold: 0, fail: 0, other: 0 }, ticketCost: null, ticketEst: null, ...over,
});
