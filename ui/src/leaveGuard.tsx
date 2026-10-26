import { useEffect, useRef } from "react";
import { useConfirm } from "./Modal";
import { useT } from "./i18n/react";
import { hashFor, parseHash, sameRoute } from "./route";
import type { Route } from "./route";

/**
 * App's hashchange handler. Every navigation (link, tab, back/forward) arrives as a hashchange;
 * leaving a route whose view holds an unsaved buffer (`prompt` returns its discard text) puts the
 * old hash back at once (no history entry added) and asks in the in-app modal. Stay leaves it there;
 * Discard puts the target hash back and calls `go` without asking again. A hash change while the
 * modal is open replaces the pending target rather than stacking a second modal.
 * Returns the modal element for App to render.
 */
export function useLeaveGuard(guard: { route: () => Route; prompt: (from: Route) => string | null; go: (next: Route) => void }): React.ReactNode {
  const g = useRef(guard);
  g.current = guard;
  const [ask, element] = useConfirm();
  const { t } = useT();
  const tr = useRef(t);
  tr.current = t;
  const pending = useRef<Route | null>(null);
  useEffect(() => {
    const onHash = () => {
      const next = parseHash(window.location.hash);
      const cur = g.current.route();
      if (sameRoute(cur, next)) return;
      const prompt = g.current.prompt(cur);
      if (!prompt) return g.current.go(next);
      window.history.replaceState(null, "", hashFor(cur));
      const asking = pending.current !== null;
      pending.current = next;
      if (asking) return;
      const t = tr.current;
      ask({ title: t("leave.title"), body: prompt, confirmLabel: t("leave.discard"), cancelLabel: t("leave.stay"), destructive: true }).then((ok) => {
        const target = pending.current;
        pending.current = null;
        if (!ok || !target) return;
        window.history.replaceState(null, "", hashFor(target));
        g.current.go(target);
      });
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  return element;
}
