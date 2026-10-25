import { useState } from "react";

const KEY = "ah-epics-open:";

/**
 * A <details>'s open state kept per tab (sessionStorage) under `id`, so leaving a page and coming
 * back (u, the back button) finds the same folds open. Storage may be absent or throw (private
 * windows, blocked site data): the fold then simply starts at `initial`.
 */
export function useDisclosure(id: string, initial = false): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(() => {
    try {
      const v = sessionStorage.getItem(KEY + id);
      return v === null ? initial : v === "1";
    } catch {
      return initial;
    }
  });
  const set = (next: boolean) => {
    setOpen(next);
    try {
      sessionStorage.setItem(KEY + id, next ? "1" : "0");
    } catch {
      // per-tab convenience only
    }
  };
  return [open, set];
}
