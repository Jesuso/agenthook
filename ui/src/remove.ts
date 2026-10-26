import type { ProfileView } from "./contract";
import { translate } from "./i18n";

// The Remove… action's pure half (POST /api/profile/remove, src/ui/server.js): the confirm gate,
// the guarded request, and the status → outcome / text mapping. RemoveProfile.tsx drives it.

/** The confirm input must equal the display label exactly — no trim, no case folding. */
export function canConfirmRemove(typed: string, label: string): boolean {
  return label !== "" && typed === label;
}

/** The guarded POST: JSON content type + `X-AH-UI: 1`; the browser adds Origin. */
export function removeRequest(profile: string, unregister: boolean): { url: string; init: RequestInit } {
  return {
    url: "/api/profile/remove",
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-AH-UI": "1" },
      body: JSON.stringify({ profile, unregister }),
    },
  };
}

/**
 * 200 → archived (stopped: the UI server moved the dir), 202 → pending (running: the receiver
 * decommissions itself at idle), 409/502 → refused (a live pid behind a dead socket, an archive
 * refusal, or the receiver said no), anything else (incl. network `0`) → error.
 */
export function classifyRemoveResponse(status: number): "archived" | "pending" | "refused" | "error" {
  if (status === 200) return "archived";
  if (status === 202) return "pending";
  if (status === 409 || status === 502) return "refused";
  return "error";
}

/** The modal's inline error; `body` is the parsed response (`{error}`) or null, its `error` shown as written. */
export function removeErrorText(status: number, body: unknown, lang = "en"): string {
  const err = body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string" ? (body as { error: string }).error : null;
  if (status === 0) return translate(lang, "remove.error.network");
  if (status === 404) return translate(lang, "remove.error.notFound");
  if (status === 504) return translate(lang, "remove.error.timeout");
  if (classifyRemoveResponse(status) === "refused") return translate(lang, "remove.error.refused", { error: err ?? translate(lang, "remove.error.statusN", { status }) });
  return err ? translate(lang, "remove.error.failedDetail", { status, error: err }) : translate(lang, "remove.error.failed", { status });
}

/** The profile row's text while a decommission is pending, from its live view. */
export function pendingText(p: Pick<ProfileView, "up" | "active">, lang = "en"): string {
  if (!p.up) return translate(lang, "remove.archiving");
  return translate(lang, "remove.whenIdle", { count: p.active ?? 0 });
}
