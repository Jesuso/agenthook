import type { ProfileView, Snapshot } from "./contract";
import { scopeToProfile, summarize } from "./summary";
import type { Summary } from "./summary";

/** One profile's Home card: its row plus its own numbers. */
export type CardModel = {
  profile: ProfileView;
  summary: Summary;
  /** A failed ticket makes the Needs-you number red; held alone is amber. */
  hasFailed: boolean;
  /** The receiver crashed or was killed rather than stopped — see ProfileView.died. */
  died: boolean;
  /** The receiver is not up: its Needs-you count is the last value it wrote, not a live read. */
  stale: boolean;
};

export type HomeModel = { active: CardModel[]; inactive: CardModel[] };

/**
 * Home's cards. A profile gets a full card when its receiver is up, when it died (crashed or was
 * killed rather than stopped), or when it is down but still has something that needs a human
 * (Needs you still applies); the rest fall into the muted Inactive strip. Active cards sort in
 * three groups, ordered by what the operator can act on now: died profiles (needs you desc, then
 * name), then up profiles (needs you desc, then running agents desc, then name), then
 * stopped-but-not-died profiles with something pending (needs you desc, then name). Inactive ones
 * sort by name.
 */
export function buildHome(snapshot: Snapshot, now: number): HomeModel {
  const cards: CardModel[] = snapshot.profiles.map((profile) => {
    const scoped = scopeToProfile(snapshot, profile.name);
    return {
      profile,
      summary: summarize(scoped, now),
      hasFailed: scoped.tickets.some((t) => t.status === "failed"),
      died: profile.died,
      stale: !profile.up,
    };
  });
  const active = cards.filter((c) => c.profile.up || c.died || c.summary.needsYou > 0);
  const inactive = cards.filter((c) => !active.includes(c));
  const byNeedsYouThenName = (a: CardModel, b: CardModel) => b.summary.needsYou - a.summary.needsYou || a.profile.name.localeCompare(b.profile.name);
  const died = active.filter((c) => c.died).sort(byNeedsYouThenName);
  const up = active.filter((c) => !c.died && c.profile.up).sort((a, b) => b.summary.needsYou - a.summary.needsYou || b.summary.active - a.summary.active || a.profile.name.localeCompare(b.profile.name));
  const stoppedWithItems = active.filter((c) => !c.died && !c.profile.up).sort(byNeedsYouThenName);
  inactive.sort((a, b) => a.profile.name.localeCompare(b.profile.name));
  return { active: [...died, ...up, ...stoppedWithItems], inactive };
}
