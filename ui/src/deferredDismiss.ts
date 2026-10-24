import { useEffect, useRef, useState } from "react";

// Dismiss is one click with no confirm, so it waits UNDO_MS before reaching the receiver: the row
// leaves at once, the toast offers Undo, and only an un-undone dismiss is sent. Leaving the page
// sends what is still pending (keepalive), so a dismiss is never silently lost.

export const UNDO_MS = 5000;

type Ref = { profile: string; ref: string };

export const dismissKey = (t: Ref) => `${t.profile}\u0000${t.ref}`;

export function useDeferredDismiss(send: (t: Ref) => void) {
  const timers = useRef(new Map<string, { t: Ref; timer: ReturnType<typeof setTimeout> }>());
  const sendRef = useRef(send);
  sendRef.current = send;
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  const sync = () => setPending(new Set(timers.current.keys()));

  const dismiss = (t: Ref) => {
    const k = dismissKey(t);
    if (timers.current.has(k)) return;
    const timer = setTimeout(() => {
      timers.current.delete(k);
      sync();
      sendRef.current(t);
    }, UNDO_MS);
    timers.current.set(k, { t, timer });
    sync();
  };

  const undo = (t: Ref) => {
    const k = dismissKey(t);
    const p = timers.current.get(k);
    if (!p) return;
    clearTimeout(p.timer);
    timers.current.delete(k);
    sync();
  };

  /** Undo the most recent pending dismiss; returns it, or null when none is pending. */
  const undoLast = (): Ref | null => {
    const last = [...timers.current.values()].at(-1);
    if (!last) return null;
    undo(last.t);
    return last.t;
  };

  useEffect(() => {
    const flush = () => {
      for (const { t, timer } of timers.current.values()) {
        clearTimeout(timer);
        sendRef.current(t);
      }
      timers.current.clear();
    };
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, []);

  return { pending, dismiss, undo, undoLast };
}
