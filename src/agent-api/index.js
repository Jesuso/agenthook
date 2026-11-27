// Agent-facing read model, shared by the MCP server (src/mcp/), `agenthook tick` and
// `agenthook watch`. Everything here reads the state dir (heartbeat.json, running.json,
// queue.json, held.json, refmeta.json, events.jsonl, logs/) — never writes it, and works with
// the receiver down. Output is deliberately small: short keys, ids not blobs, truncated reasons,
// an `etag` so an unchanged poll costs ~10 tokens, and byte-offset `cursor`s so event reads are
// incremental. The live-only reads (board, prs) and every write go through the control socket.
export { LIVE_TIMEOUT_DEFAULT_MS, LIVE_TIMEOUT_MS, liveTimeoutMs, live } from "./live.js";
export { pickProfile, pickProfiles, defaultProfileKey, readProfiles } from "./profiles.js";
export { etagOf, readStatus, readRunStats } from "./status.js";
export { cursorMapError, parseCursorMap, eventsCursor, compactEvent, readEventsSince, waitForEvents, mergeTagged, waitForEventsMulti } from "./events.js";
export { readRuns, readRunLogTail } from "./runs.js";
export { readLocalEpics, readEpics, readTick } from "./tick.js";
