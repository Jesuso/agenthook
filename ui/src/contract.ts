// Re-export of the server ↔ browser contract (src/ui/contract.js). No duplicated
// shapes — the frontend types against the same JSDoc typedefs the server returns (plus the
// shared runtime pieces: SENSITIVE_FIELDS and the import-free sensitiveChanges diff).
export type { ProfileView, LastEvent, RecentRun, QuotaReading, QuotaTrip, TicketStatus, TicketRow, Snapshot, UiEvent, RunView, LogFrame, InstructionFileView, InstructionsView, PromptPreview, ConfigView, RemovePreview, DigestView, TicketEpic, SandboxReadiness } from "../../src/ui/contract.js";
export type { StatsView, DayStats } from "../../src/ui/stats.js";
export type { EpicStats, EpicDetail, EpicDetailTicket, EpicBucket } from "../../src/epics.js";
import type { EpicStats, EpicDetail } from "../../src/epics.js";

/** `GET /api/epics` body (docs/web-ui.md § Epics data). `live:false` = built locally, receiver down. */
export type EpicsResponse = { at: string; live: boolean; supported: boolean; epics: EpicStats[] };
/** `GET /api/epics/<ref>` body; `epic` is null only with `supported:false`. */
export type EpicResponse = { at: string; live: boolean; supported: boolean; epic: EpicDetail | null };
export { SENSITIVE_FIELDS } from "../../src/ui/contract.js";
export { sensitiveChanges } from "../../src/ui/sensitive.js";
