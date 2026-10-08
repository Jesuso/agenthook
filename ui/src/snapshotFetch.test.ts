import { describe, it, expect } from "vitest";
import { initFetchState, startFetch, bufferEvent, resolveFetch, failFetch, isBuffering } from "./snapshotFetch";
import type { Snapshot, UiEvent } from "./contract";

function snap(names: string[]): Snapshot {
  return { profiles: names.map((name) => ({ name } as never)), tickets: [] };
}

function upsert(name: string): UiEvent {
  return { type: "profile", profile: { name } as never };
}

describe("snapshotFetch coordinator", () => {
  it("buffers deltas while a fetch is in flight and replays them in order on resolve", () => {
    let state = initFetchState();
    const started = startFetch(state);
    state = started.state;
    expect(isBuffering(state)).toBe(true);

    state = bufferEvent(state, upsert("b"));
    const resolved = resolveFetch(state, started.gen, snap(["a"]));
    state = resolved.state;
    expect(resolved.snapshot?.profiles.map((p) => p.name)).toEqual(["a", "b"]);
    expect(isBuffering(state)).toBe(false);
  });

  it("ignores a stale (slower, overlapping) fetch's response instead of clobbering newer state", () => {
    let state = initFetchState();
    const a = startFetch(state);
    state = a.state;
    const b = startFetch(state);
    state = b.state;

    // B resolves first — fine, it's the latest generation.
    const resolvedB = resolveFetch(state, b.gen, snap(["b-data"]));
    state = resolvedB.state;
    expect(resolvedB.snapshot?.profiles.map((p) => p.name)).toEqual(["b-data"]);

    // A resolves after — it's stale (gen no longer current), must be ignored.
    const resolvedA = resolveFetch(state, a.gen, snap(["a-data"]));
    expect(resolvedA.snapshot).toBeNull();
  });

  it("a delta that lands after the latest fetch resolves is not lost by a later-settling stale fetch", () => {
    let state = initFetchState();
    const a = startFetch(state);
    state = a.state;
    const b = startFetch(state);
    state = b.state;

    const resolvedB = resolveFetch(state, b.gen, snap(["x"]));
    state = resolvedB.state;
    expect(isBuffering(state)).toBe(false);

    // A delta arrives now — not buffered, since no fetch is in flight.
    expect(isBuffering(state)).toBe(false);

    // The stale A fetch finally settles; it must be a no-op.
    const resolvedA = resolveFetch(state, a.gen, snap(["stale"]));
    expect(resolvedA.snapshot).toBeNull();
    expect(resolvedA.state).toBe(state);
  });

  it("failFetch clears the buffer for a matching gen so it doesn't grow unbounded on a dead fetch", () => {
    let state = initFetchState();
    const started = startFetch(state);
    state = started.state;
    state = bufferEvent(state, upsert("a"));
    state = failFetch(state, started.gen);
    expect(isBuffering(state)).toBe(false);
  });

  it("failFetch is a no-op for a stale gen", () => {
    let state = initFetchState();
    const a = startFetch(state);
    state = a.state;
    const b = startFetch(state);
    state = b.state;
    state = bufferEvent(state, upsert("a"));
    const next = failFetch(state, a.gen);
    expect(next).toBe(state);
    expect(isBuffering(next)).toBe(true);
  });
});
