import { createContext, useContext, useEffect, useState } from "react";
import { elapsedTickMs, formatElapsed, formatRelative, relativeTickMs } from "../format";
import { useT } from "../i18n/react";

// Live time labels (#579). Each label owns its clock and re-renders exactly when its text changes —
// N independent ticks at each label's own boundary, not one global clock re-rendering every row.
// No network: only a local timer. Never aria-live: a ticking value is read on demand, not announced.

/** False while the event stream is down: labels stop at their last reading (an agent may have finished meanwhile). */
export const LiveContext = createContext(true);

const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

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

/** `formatRelative(iso)` kept current; a timestamp slightly in the future (clock skew) reads "just now". */
export function useAgo(iso: string | null, seed: number): string {
  const { lang } = useT();
  const start = parse(iso);
  const now = useTicking(start, relativeTickMs, seed);
  return formatRelative(iso, Number.isFinite(start) ? Math.max(now, start) : now, lang);
}

export function Ago({ iso, seed }: { iso: string | null; seed: number }) {
  return <>{useAgo(iso, seed)}</>;
}

const elapsedTick = (elapsed: number) => elapsedTickMs(elapsed, false);
const elapsedTickCoarse = (elapsed: number) => elapsedTickMs(elapsed, true);

/** A running agent's elapsed time since `iso`; frozen and dimmed while the stream is down. */
export function Elapsed({ iso, seed, className = "" }: { iso: string | null; seed: number; className?: string }) {
  const { t, lang } = useT();
  const live = useContext(LiveContext);
  const [coarse] = useState(reducedMotion);
  const start = parse(iso);
  const now = useTicking(start, coarse ? elapsedTickCoarse : elapsedTick, seed);
  const text = Number.isFinite(start) ? formatElapsed(now - start, coarse) : "—";
  const asOf = new Date(now).toLocaleTimeString(lang, { hour: "2-digit", minute: "2-digit" });
  return (
    <span data-elapsed data-live={live} className={`font-mono tabular-nums ${live ? "" : "text-muted"} ${className}`} title={live ? t("overview.elapsed") : t("time.notLive", { time: asOf })}>
      {text}
    </span>
  );
}
