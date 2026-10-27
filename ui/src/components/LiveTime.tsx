import { createContext, useContext, useEffect, useState } from "react";
import type { ConnectionState } from "../connection";
import { elapsedTickMs, formatElapsed, formatRelative, relativeTickMs } from "../format";
import { useT } from "../i18n/react";

// Live time labels (#579). Each label owns its clock and re-renders exactly when its text changes —
// N independent ticks at each label's own boundary, not one global clock re-rendering every row.
// No network: only a local timer. Never aria-live: a ticking value is read on demand, not announced.

/** False while the event stream is down: labels stop at their last reading (an agent may have finished meanwhile). */
export const LiveContext = createContext(true);

/** How long a `reconnecting` stream still counts as live: the first open on load, and a blip, aren't outages. */
export const LIVE_GRACE_MS = 15_000;

/** The LiveContext value for a connection state: `closed` is down at once, `reconnecting` only after the grace. */
export function useLive(connection: ConnectionState, graceMs = LIVE_GRACE_MS): boolean {
  const [expired, setExpired] = useState(false);
  useEffect(() => {
    setExpired(false);
    if (connection !== "reconnecting") return;
    const timer = setTimeout(() => setExpired(true), graceMs);
    return () => clearTimeout(timer);
  }, [connection, graceMs]);
  return connection === "connected" || (connection === "reconnecting" && !expired);
}

const REDUCED = "(prefers-reduced-motion: reduce)";

/** prefers-reduced-motion, following the setting if it changes while the page is open. */
export function useReducedMotion(): boolean {
  const query = () => (typeof matchMedia === "function" ? matchMedia(REDUCED) : null);
  const [reduced, setReduced] = useState(() => query()?.matches ?? false);
  useEffect(() => {
    const mq = query();
    if (!mq) return;
    const onChange = () => setReduced(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

/**
 * `Date.now()`, refreshed whenever `tickMs(now - start)` says the label changes next. `seed` is the first
 * reading (the caller's render-time `now`, so server/static renders stay deterministic). A hidden tab's
 * timers throttle; returning to it re-reads at once.
 */
export function useTicking(start: number, tickMs: (elapsed: number) => number, seed: number): number {
  const live = useContext(LiveContext);
  const [now, setNow] = useState(seed);
  useEffect(() => {
    if (!live || !Number.isFinite(start)) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = () => {
      const t = Date.now();
      setNow(t);
      timer = setTimeout(read, tickMs(t - start));
    };
    const onVisible = () => {
      if (document.hidden) return;
      clearTimeout(timer);
      read();
    };
    read();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [start, live, tickMs]);
  return now;
}

const parse = (iso: string | null) => (iso ? Date.parse(iso) : NaN);

/** The mark a held (not live) reading carries in text, so staleness never rests on colour alone. */
const STALE = "~";

/**
 * `formatRelative(iso)` kept current; a timestamp slightly in the future (clock skew) reads "just now".
 * Held while the stream is down, marked "~".
 */
export function useAgo(iso: string | null, seed: number): string {
  const { lang } = useT();
  const live = useContext(LiveContext);
  const start = parse(iso);
  const now = useTicking(start, relativeTickMs, seed);
  const text = formatRelative(iso, Number.isFinite(start) ? Math.max(now, start) : now, lang);
  return live || text === "—" ? text : `${STALE}${text}`;
}

export function Ago({ iso, seed }: { iso: string | null; seed: number }) {
  return <>{useAgo(iso, seed)}</>;
}

const elapsedTick = (elapsed: number) => elapsedTickMs(elapsed, false);
const elapsedTickCoarse = (elapsed: number) => elapsedTickMs(elapsed, true);

/** "4 minutes" / "1 hour 4 minutes" / "less than a minute" in `lang`, for screen readers ("4m" reads as metres). */
function spokenElapsed(ms: number, coarse: boolean, lang: string, underMinute: string): string {
  const unit = (n: number, u: "second" | "minute" | "hour") => new Intl.NumberFormat(lang, { style: "unit", unit: u, unitDisplay: "long" }).format(n);
  const secs = Math.max(0, Math.floor(ms / 1000));
  if (secs < 60) return coarse ? underMinute : unit(secs, "second");
  const mins = Math.floor(secs / 60);
  if (mins < 60) return unit(mins, "minute");
  const rest = mins % 60;
  return rest ? `${unit(Math.floor(mins / 60), "hour")} ${unit(rest, "minute")}` : unit(Math.floor(mins / 60), "hour");
}

/**
 * A running agent's elapsed time since `iso`. While the stream is down it holds its last reading,
 * marked "~" and muted, with the "as of" time in its title and its spoken text.
 */
export function Elapsed({ iso, seed, className = "" }: { iso: string | null; seed: number; className?: string }) {
  const { t, lang } = useT();
  const live = useContext(LiveContext);
  const coarse = useReducedMotion();
  const start = parse(iso);
  const now = useTicking(start, coarse ? elapsedTickCoarse : elapsedTick, seed);
  if (!Number.isFinite(start)) return <span data-elapsed className={`font-mono ${className}`}>—</span>;
  const ms = now - start;
  const text = formatElapsed(ms, coarse);
  const spoken = t("time.elapsedSpoken", { duration: spokenElapsed(ms, coarse, lang, t("time.underMinute")) });
  const notLive = t("time.notLive", { time: new Date(now).toLocaleTimeString(lang, { hour: "2-digit", minute: "2-digit" }) });
  return (
    <time
      data-elapsed
      data-live={live}
      dateTime={`PT${Math.max(0, Math.floor(ms / 1000))}S`}
      className={[`font-mono tabular-nums`, live ? "" : "text-muted", className].filter(Boolean).join(" ")}
      title={live ? t("overview.elapsed") : notLive}
    >
      <span aria-hidden="true">{live ? text : `${STALE}${text}`}</span>
      <span className="sr-only">{live ? spoken : `${spoken}, ${notLive}`}</span>
    </time>
  );
}
