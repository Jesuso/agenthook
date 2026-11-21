import { useEffect } from "react";

/**
 * Sets the browser tab title to the non-empty `parts` joined with " · " over "agenthook", and
 * resets it to "agenthook" on unmount. The effect's dependency is the joined string, so a fresh
 * array literal on every render does not re-run it.
 */
export function usePageTitle(parts: ReadonlyArray<string | null | undefined>): void {
  const title = [...parts.filter(Boolean), "agenthook"].join(" · ");
  useEffect(() => {
    document.title = title;
    return () => {
      document.title = "agenthook";
    };
  }, [title]);
}
