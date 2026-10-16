import { CONNECTION_LABEL } from "./connection";
import type { ConnectionState } from "./connection";
import { Pill } from "./components";
import { VIEWS } from "./route";
import type { View } from "./route";
import type { ProfileView } from "./contract";
import { profileLabel } from "./format";

const DOT_CLASS: Record<ConnectionState, string> = {
  connected: "bg-success",
  reconnecting: "bg-status-held",
  closed: "bg-status-failed",
};

/** The live-stream health: green live, amber reconnecting (also before the first open), red closed. */
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
};

/**
 * Brand + version and the connection dot. On Home that is all; inside a profile the bar also
 * carries `‹ Home`, a profile switcher and the Overview · Instructions · Config tabs. `nav`
 * absent (Home, loading / error screens) → no profile controls.
 */
export function AppBar({ connection, nav }: { connection: ConnectionState; nav?: ProfileNav }) {
  return (
    <header className="sticky top-0 z-20 flex h-11 items-center gap-6 border-b border-border bg-surface px-4">
      <div className="flex items-center gap-2">
        <span className="text-title font-semibold tracking-tight">agenthook</span>
        <Pill title="agenthook version">v{__APP_VERSION__}</Pill>
      </div>
      {nav && (
        <>
          <div className="flex items-center gap-2">
            <button
              type="button"
              data-home
              className="rounded-md px-2 py-1 text-label font-medium text-muted hover:bg-surface-raised hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"
              onClick={nav.onHome}
            >
              ‹ Home
            </button>
            <select
              aria-label="switch profile"
              data-profile-switcher
              className="rounded-md border border-border bg-transparent px-1.5 py-0.5 text-label font-medium"
              value={nav.profile}
              onChange={(e) => nav.onProfile(e.target.value)}
            >
              {!nav.profiles.some((p) => p.name === nav.profile) && <option value={nav.profile}>{nav.profile}</option>}
              {nav.profiles.map((p) => (
                <option key={p.name} value={p.name}>
                  {profileLabel(p)}
                </option>
              ))}
            </select>
          </div>
          <nav aria-label="views" className="flex items-center gap-1">
            {VIEWS.map((v) => (
              <button
                key={v}
                type="button"
                data-tab={v}
                aria-current={v === nav.view ? "page" : undefined}
                className={`rounded-md px-3 py-1 text-label font-medium capitalize ${
                  v === nav.view ? "bg-surface-raised text-fg ring-1 ring-inset ring-border-strong" : "text-muted hover:bg-surface-raised hover:text-fg"
                }`}
                onClick={() => nav.onView(v)}
              >
                {v}
              </button>
            ))}
          </nav>
        </>
      )}
      <div className="ml-auto">
        <ConnectionDot state={connection} />
      </div>
    </header>
  );
}
