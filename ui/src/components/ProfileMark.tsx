import { TILE_BG, accentStyle } from "../identity";
import type { Identity } from "../identity";

/** A profile's emoji on a tile tinted by its colour; `size` is the tile's side. Decorative: the name always sits beside it. */
export function ProfileMark({ p, size = "md" }: { p: Identity; size?: "sm" | "md" }) {
  const box = size === "sm" ? "size-6 text-body" : "size-10 text-title";
  return (
    <span aria-hidden="true" style={{ ...accentStyle(p.color), background: TILE_BG }} className={`flex shrink-0 items-center justify-center rounded-md ring-1 ring-inset ring-[var(--profile-accent)]/40 ${box}`}>
      {p.emoji}
    </span>
  );
}
