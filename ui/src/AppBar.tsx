import { CONNECTION_LABEL } from "./connection";
import type { ConnectionState } from "./connection";
import { Pill, ProfileMark, ReadingPanel } from "./components";
import { VIEWS } from "./route";
import type { View } from "./route";
import type { ProfileView } from "./contract";
import { formatQuota, profileLabel } from "./format";

const DOT_CLASS: Record<ConnectionState, string> = {
  connected: "bg-muted",
  reconnecting: "bg-status-held",
  closed: "bg-status-failed",
};

/** The UI's own live-stream health — not a receiver's: a quiet grey dot while updates flow, amber reconnecting
 * (also before the first open), red closed. Green is kept for "receiver up" so the two never read alike. */
export function ConnectionDot({ state }: { state: ConnectionState }) {
  const label = CONNECTION_LABEL[state];
  return (
    <span role="status" data-connection={state} title={label} aria-label={label} className="flex items-center gap-1.5 text-label text-muted">
      <span aria-hidden="true" className={`size-2 rounded-full ${DOT_CLASS[state]}`} />
      {label}
    </span>
  );
}

/** What the bar needs to render a profile page: where we are in it, who else we can switch to. */
export type ProfileNav = {
  profile: string;
  profiles: ProfileView[];
  view: View;
  onView: (v: View) => void;
  onProfile: (name: string) => void;
  onHome: () => void;
  /** Render clock for the quota readout's countdown and age. */
  now?: number;
};

/**
 * Brand + version, the `Aa` reading settings and the connection dot. On Home that is all; inside
 * a profile the bar also carries `‹ Home`, a profile switcher and the Overview · Instructions ·
 * Config tabs. `nav`
 * absent (Home, loading / error screens) → no profile controls. Below `lg` a forced line break
 * (a `basis-full lg:hidden` spacer) keeps DOM/reading order (brand · profile · tabs · quota ·
 * connection) intact across both rows instead of letting the tabs wrap behind the quota readout
 * and the dot — row 1 is brand + profile, row 2 is tabs · quota · ● live (scrolling sideways if
 * even that is too narrow) — so a phone or split window never scrolls the page sideways; from
 * `lg` up the spacer collapses and it is one 44px row.
 */
export function AppBar({ connection, nav }: { connection: ConnectionState; nav?: ProfileNav }) {
  const current = nav?.profiles.find((p) => p.name === nav.profile);
  const quota = current?.quota ? formatQuota(current.quota, nav?.now ?? Date.now()) : "";
  return (
    <header className="sticky top-0 z-20 flex min-h-11 flex-wrap items-center gap-x-4 gap-y-1 border-b border-border bg-surface px-4 py-1.5 lg:h-11 lg:flex-nowrap lg:gap-x-6 lg:py-0">
      <div className="flex shrink-0 items-center gap-2">
        <span className="text-title font-semibold tracking-tight">agenthook</span>
        <Pill title="agenthook version">v{__APP_VERSION__}</Pill>
      </div>
      {nav && (
        <>
          <div className="flex min-w-0 items-center gap-2">
            <button
              type="button"
              data-home
              className="rounded-md px-2 py-1 text-label font-medium text-muted hover:bg-surface-raised hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"
              onClick={nav.onHome}
            >
              ‹ Home
            </button>
            {current && <ProfileMark p={current} size="sm" />}
            <select
              aria-label="switch profile"
              data-profile-switcher
              className="min-w-0 max-w-full rounded-md border border-border bg-surface px-1.5 py-0.5 text-label font-medium"
              value={nav.profile}
              onChange={(e) => nav.onProfile(e.target.value)}
            >
              {!nav.profiles.some((p) => p.name === nav.profile) && <option value={nav.profile}>{nav.profile}</option>}
              {nav.profiles.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.emoji} {profileLabel(p)}
                </option>
              ))}
            </select>
          </div>
          <span aria-hidden="true" className="h-0 shrink-0 basis-full lg:hidden" />
          <nav aria-label="views" className="flex min-w-0 max-w-full items-center gap-1 overflow-x-auto">
            {VIEWS.map((v) => (
              <button
                key={v}
                type="button"
                data-tab={v}
                aria-current={v === nav.view ? "page" : undefined}
                className={`shrink-0 rounded-md px-3 py-1 text-label font-medium capitalize ${
                  v === nav.view ? "bg-surface-raised text-fg ring-1 ring-inset ring-border-strong" : "text-muted hover:bg-surface-raised hover:text-fg"
                }`}
                onClick={() => nav.onView(v)}
              >
                {v}
              </button>
            ))}
          </nav>
          {quota && (
            <span data-appbar-quota className="min-w-0 truncate text-label text-muted" title="Claude subscription quota, as of the last Claude run">
              {quota}
            </span>
          )}
        </>
      )}
      <div className="ml-auto flex shrink-0 items-center gap-2">
        <ReadingPanel />
        <ConnectionDot state={connection} />
      </div>
    </header>
  );
}
