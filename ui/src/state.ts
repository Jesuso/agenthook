import type { Snapshot, UiEvent } from "./contract";

/**
 * Pure, immutable reducer applying one `UiEvent` to a `Snapshot`. Handles
 * `profile`/`profile_removed`/`ticket`/`ticket_removed`. `event` is feed-only
 * (the snapshot carries no events) and leaves the state unchanged.
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
  if (ev.type === "ticket") {
    const tickets = state.tickets.filter((t) => !(t.profile === ev.ticket.profile && t.ref === ev.ticket.ref));
    tickets.push(ev.ticket);
    return { ...state, tickets };
  }
  if (ev.type === "ticket_removed") {
    return {
      ...state,
      tickets: state.tickets.filter((t) => !(t.profile === ev.profile && t.ref === ev.ref)),
    };
  }
  return state;
}

/** The App-level picks that name a profile (the open TicketDrawer, the ticket filter). */
export type ProfilePicks = { open: { profile: string; ref: string } | null; profileFilter: string };

/** Drop whichever picks name `name` once its `profile_removed` arrives; others are kept as is. */
export function clearRemovedProfile(view: ProfilePicks, name: string): ProfilePicks {
  return {
    open: view.open?.profile === name ? null : view.open,
    profileFilter: view.profileFilter === name ? "" : view.profileFilter,
  };
}
