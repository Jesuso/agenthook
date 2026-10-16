import type { ProfileView } from "./contract";
import { formatDate, profileBadge, profileLabel } from "./format";
import { FullAutoShield, Pill } from "./components";

/** A profile's name cell: label, fullAuto shield, ghost/config-missing badge, and the visible (tildified) config path. */
export function ProfileNameCell({ p }: { p: ProfileView }) {
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
      {p.configPath && (
        <div className="block max-w-[40ch] truncate font-mono text-label text-muted max-lg:max-w-[24ch]" title={p.configPath}>
          {p.configPath}
        </div>
      )}
    </>
  );
}
