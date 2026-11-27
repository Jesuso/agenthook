// Tiny JSON-file persistence shared by the engine and providers.
//   - secrets: handshake secrets keyed by webhook path (Asana). Mode 0600.
//   - seen:    dedup keys so one event triggers exactly one run.
//   - running: in-flight pipeline jobs (ref -> {stepId,pid,...}) for crash recovery.
//   - held:    refs parked by a `hold` verdict (ref -> {stepId,reason?,heldAt}), so an
//              owner's `@agent` reply comment knows which step to resume.
//   - repo:    per-ref sticky repo id (multi-repo routing), so a ref keeps the checkout
//              its first step routed to even if its route keys change mid-flow.
//   - paths / locks / overlap: the opt-in file-overlap guard (src/overlap.js) — predicted
//              paths per ref, in-flight locks (ref -> {paths,stepId}), and refs waiting on
//              another ref's lock (ref -> {stepId,blockedBy,heldAt}). Only written when
//              cfg.overlapGuard is on.
//   - refmeta: per-ref display metadata ({displayId,title,pr,prState,url,summary}) for the CLIs. Never
//     cleared — unlike running, status/events need it after the run ends (only `prState` is
//     dropped, when a new agent run starts or its PR shows open again).
//   - cired:   red-CI bounces parked while a step runs on the ref (dispatch applies
//              them when that run exits).
//   - summaries: per-(ref, step) supervisor summaries from verdicts ({summary,outcome,run,at}),
//              shown on `runs`/`prs`. Outlive a manual drain (the PR is still open); cleared
//              on terminal fail/cancel and merge; capped at MAX_SUMMARY_REFS refs.
//   - queue:   jobs accepted but still waiting behind maxConcurrent (insertion order,
//              keyed by `${ref}:${stepId}`), so a crash/force-kill doesn't lose them.
//   - merge-watermark: `{mergedAt}` of the newest merged agent PR the explicit merge catch-up
//              (`runMergeCatchup`) listed, so the next one only asks the forge for later merges.
//
// seen is reloaded from disk on every read (reloadSeen) because external tools
// (the `catchup` CLI) edit it out-of-band; the in-memory set would otherwise mask
// those edits and silently dedup-skip a re-dispatch.
//
// `running` is OUR OWN crash-recovery state, never a poll: on boot the engine reads
// it (a file, no network) to find jobs interrupted by a restart. Forward motion is
// always event-driven; recovering a half-run job is the one thing the board can't
// tell us (it can't distinguish "mid-run" from "fresh"), so we record it locally.
import { secretsSlice } from "./secrets.js";
import { seenSlice, isStateDedupKey } from "./seen.js";
import { runningSlice } from "./running.js";
import { queueSlice } from "./queue.js";
import { attemptsSlice } from "./attempts.js";
import { difficultySlice } from "./difficulty.js";
import { repoSlice } from "./repo.js";
import { heldSlice } from "./held.js";
import { overlapSlice } from "./overlap.js";
import { refmetaSlice } from "./refmeta.js";
import { mergeWatermarkSlice } from "./merge-watermark.js";
import { harnessHealthSlice } from "./harness-health.js";
import { overridesSlice } from "./overrides.js";
import { findingsSlice } from "./findings.js";
import { summariesSlice, MAX_SUMMARY_REFS } from "./summaries.js";
import { ciRedSlice } from "./cired.js";
import { usageSlice } from "./usage.js";

export { isStateDedupKey, MAX_SUMMARY_REFS };

/**
 * @param {string} dataDir
 * @returns {import('../types/index.js').Store}
 */
export function createStore(dataDir) {
  return {
    ...secretsSlice(dataDir),
    ...seenSlice(dataDir),
    ...runningSlice(dataDir),
    ...queueSlice(dataDir),
    ...attemptsSlice(dataDir),
    ...difficultySlice(dataDir),
    ...repoSlice(dataDir),
    ...heldSlice(dataDir),
    ...overlapSlice(dataDir),
    ...refmetaSlice(dataDir),
    ...mergeWatermarkSlice(dataDir),
    ...harnessHealthSlice(dataDir),
    ...overridesSlice(dataDir),
    ...findingsSlice(dataDir),
    ...summariesSlice(dataDir),
    ...ciRedSlice(dataDir),
    ...usageSlice(dataDir),
  };
}
