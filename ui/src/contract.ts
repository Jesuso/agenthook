// Re-export of the server ↔ browser contract (src/ui/contract.js). No duplicated
// shapes — the frontend types against the same JSDoc typedefs the server returns (plus the
// shared runtime pieces: SENSITIVE_FIELDS and the import-free sensitiveChanges diff).
export type { ProfileView, LastEvent, TicketStatus, TicketRow, Snapshot, UiEvent, RunView, LogFrame, InstructionFileView, InstructionsView, PromptPreview, ConfigView } from "../../src/ui/contract.js";
export { SENSITIVE_FIELDS } from "../../src/ui/contract.js";
export { sensitiveChanges } from "../../src/ui/sensitive.js";
