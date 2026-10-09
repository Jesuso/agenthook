import { CONNECTION_LABEL } from "./connection";
import type { ConnectionState } from "./connection";
import { Pill } from "./components";

export type Tab = "dashboard" | "instructions" | "config";
export const TABS: Tab[] = ["dashboard", "instructions", "config"];

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

/** Brand + version, the tab nav (omitted on the loading / error screens) and the connection dot. */
export function AppBar({ connection, tab, onTab }: { connection: ConnectionState; tab?: Tab; onTab?: (t: Tab) => void }) {
  return (
    <header className="sticky top-0 z-20 flex h-11 items-center gap-6 border-b border-border bg-surface px-4">
      <div className="flex items-center gap-2">
        <span className="text-title font-semibold tracking-tight">agenthook</span>
        <Pill title="agenthook version">v{__APP_VERSION__}</Pill>
      </div>
      {onTab && (
        <nav aria-label="views" className="flex items-center gap-1">
          {TABS.map((t) => (
            <button
              key={t}
              type="button"
              data-tab={t}
              aria-current={t === tab ? "page" : undefined}
              className={`rounded-md px-3 py-1 text-label font-medium capitalize ${
                t === tab ? "bg-surface-raised text-fg ring-1 ring-inset ring-border-strong" : "text-muted hover:bg-surface-raised hover:text-fg"
              }`}
              onClick={() => onTab(t)}
            >
              {t}
            </button>
          ))}
        </nav>
      )}
      <div className="ml-auto">
        <ConnectionDot state={connection} />
      </div>
    </header>
  );
}
