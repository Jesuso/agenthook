import type { ProfileView, Snapshot } from "./contract";
import { scopeToProfile, summarize } from "./summary";
import type { Summary } from "./summary";

/** One profile's Home card: its row plus its own numbers. */
export type CardModel = {
  profile: ProfileView;
  summary: Summary;
  /** A failed ticket makes the Needs-you number red; held alone is amber. */
  hasFailed: boolean;
};

export type HomeModel = { active: CardModel[]; inactive: CardModel[] };

/**
 * Home's cards. A profile gets a full card when its receiver is up, or when it is down but still
 * has something that needs a human (Needs you still applies); the rest fall into the muted
 * Inactive strip. Active cards order by Needs you (desc), then running agents (desc), then name;
 * inactive ones by name.
 */
export function buildHome(snapshot: Snapshot, now: number): HomeModel {
  const cards: CardModel[] = snapshot.profiles.map((profile) => {
    const scoped = scopeToProfile(snapshot, profile.name);
    return { profile, summary: summarize(scoped, now), hasFailed: scoped.tickets.some((t) => t.status === "failed") };
  });
  const active = cards.filter((c) => c.profile.up || c.summary.needsYou > 0);
  const inactive = cards.filter((c) => !active.includes(c));
  active.sort((a, b) => b.summary.needsYou - a.summary.needsYou || b.summary.active - a.summary.active || a.profile.name.localeCompare(b.profile.name));
  inactive.sort((a, b) => a.profile.name.localeCompare(b.profile.name));
  return { active, inactive };
}
