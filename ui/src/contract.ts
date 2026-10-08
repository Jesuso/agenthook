// Re-export of the server ↔ browser contract (src/ui/contract.js). No duplicated
// shapes — the frontend types against the same JSDoc typedefs the server returns.
export type { ProfileView, LastEvent, TicketStatus, TicketRow, Snapshot, UiEvent } from "../../src/ui/contract.js";
