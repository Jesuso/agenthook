import { PROFILE_COLORS, PROFILE_EMOJIS } from "../../src/identity.js";
import type { ProfileView } from "./contract";

export { PROFILE_COLORS, PROFILE_EMOJIS, deriveIdentity } from "../../src/identity.js";

/**
 * Inline style that scopes `--profile-accent` to a profile's palette colour; everything that
 * paints the identity (card bar, emoji tile tint, app-bar chip) reads that one variable.
 * An unknown id (a stale build) falls back to the neutral muted token.
 */
export function accentStyle(color: string): React.CSSProperties {
  const known = (PROFILE_COLORS as readonly string[]).includes(color);
  return { ["--profile-accent" as string]: known ? `var(--color-profile-${color})` : "var(--color-muted)" };
}

/** The emoji tile's tint: the accent mixed into the surface so it reads in both schemes. */
export const TILE_BG = "color-mix(in srgb, var(--profile-accent) 18%, var(--color-surface))";

export type Identity = Pick<ProfileView, "color" | "emoji">;
export const isKnownEmoji = (e: string) => (PROFILE_EMOJIS as readonly string[]).includes(e);
