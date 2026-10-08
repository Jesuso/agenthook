import type { Snapshot, UiEvent } from "./contract";

/**
 * Pure, immutable reducer applying one `UiEvent` to a `Snapshot`. Scoped to
 * `profile`/`profile_removed` — #137 extends this with `ticket`/`ticket_removed`/`event`.
 */
export function applyEvent(state: Snapshot, ev: UiEvent): Snapshot {
  if (ev.type === "profile") {
    const profiles = state.profiles.filter((p) => p.name !== ev.profile.name);
    profiles.push(ev.profile);
    profiles.sort((a, b) => a.name.localeCompare(b.name));
    return { ...state, profiles };
  }
  if (ev.type === "profile_removed") {
    return {
      ...state,
      profiles: state.profiles.filter((p) => p.name !== ev.name),
      tickets: state.tickets.filter((t) => t.profile !== ev.name),
    };
  }
  return state;
}
