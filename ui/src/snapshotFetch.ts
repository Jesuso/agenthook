import type { Snapshot, UiEvent } from "./contract";
import { applyEvent } from "./state";

/**
 * Pure coordinator for the "re-fetch snapshot on every stream open, buffer
 * deltas that arrive mid-fetch, replay them in order once it resolves" dance.
 * A generation counter means only the *latest* fetch's response can land —
 * an overlapping, slower, earlier fetch is ignored instead of clobbering
 * state a newer fetch (or newer deltas) already moved past.
 */
export type FetchState = { gen: number; buffer: UiEvent[] | null };

export function initFetchState(): FetchState {
  return { gen: 0, buffer: null };
}

/** Call when starting a snapshot fetch. Returns the gen to pass to `resolveFetch`/`failFetch`. */
export function startFetch(state: FetchState): { state: FetchState; gen: number } {
  const gen = state.gen + 1;
  return { state: { gen, buffer: [] }, gen };
}

/** Call for every stream delta. Buffers it if a fetch is in flight, else leaves state untouched (caller applies directly). */
export function bufferEvent(state: FetchState, ev: UiEvent): FetchState {
  if (state.buffer === null) return state;
  return { ...state, buffer: [...state.buffer, ev] };
}

export function isBuffering(state: FetchState): boolean {
  return state.buffer !== null;
}

/**
 * Call when a fetch resolves with a snapshot. A stale `gen` (a newer fetch
 * has since started) is ignored — returns `snapshot: null`. Otherwise
 * replays whatever buffered during the fetch onto it.
 */
export function resolveFetch(
  state: FetchState,
  gen: number,
  snapshot: Snapshot,
): { state: FetchState; snapshot: Snapshot | null } {
  if (gen !== state.gen) return { state, snapshot: null };
  const buffered = state.buffer ?? [];
  return { state: { ...state, buffer: null }, snapshot: buffered.reduce(applyEvent, snapshot) };
}

/** Call when a fetch fails (network error, 401, non-ok status). Stops buffering for a stale gen too. */
export function failFetch(state: FetchState, gen: number): FetchState {
  if (gen !== state.gen) return state;
  return { ...state, buffer: null };
}
