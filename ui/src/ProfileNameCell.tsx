import type { ProfileView } from "./contract";
import { formatDate, profileBadge, profileLabel, quotaPausedTitle } from "./format";
import { FullAutoShield, Pill } from "./components";

/** A profile's name cell: label, fullAuto shield, ghost/config-missing badge, and the visible (tildified) config path. */
export function ProfileNameCell({ p, path = true }: { p: ProfileView; path?: boolean }) {
  const badge = profileBadge(p);
  return (
    <>
      <div className="flex items-center gap-1.5 whitespace-nowrap">
        <span className="font-mono" title={p.configPath ?? undefined}>
          {profileLabel(p)}
        </span>
        {p.fullAuto && <FullAutoShield />}
        {p.paused === true && (
          <Pill tone="held" title="operator pause: no new runs start; running agents finish (a restart clears it)">
            paused
          </Pill>
        )}
        {p.quotaPaused && (
          <Pill tone="held" title={quotaPausedTitle(p.quotaPaused)}>
            quota paused
          </Pill>
        )}
        {badge && (
          <Pill tone={badge.kind === "missing" ? "held" : "neutral"} title={badge.title}>
            {badge.text}
          </Pill>
        )}
        {badge?.kind === "ghost" && (
          <span className="text-label text-muted" title={badge.title}>
            created {formatDate(p.createdAt)}
          </span>
        )}
      </div>
      {path && p.configPath && (
        <div className="block max-w-[40ch] truncate font-mono text-label text-muted max-lg:max-w-[24ch]" title={p.configPath}>
          {p.configPath}
        </div>
      )}
    </>
  );
}
