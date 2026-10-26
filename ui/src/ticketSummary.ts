// The drawer's localized ticket summary (src/summarize.js): `POST /api/summary` asks the receiver for
// a short summary of the ticket's current description in the UI language — cached there, one cheap
// tool-less run on a miss. Anything but a 200 with text keeps the regex summary, silently.

/** `POST /api/summary` for `ref` in `lang`, with the write guard header (a miss spends money). */
export function summaryRequest(profile: string, ref: string, lang: string): { url: string; init: RequestInit } {
  return {
    url: "/api/summary",
    init: { method: "POST", headers: { "Content-Type": "application/json", "X-AH-UI": "1" }, body: JSON.stringify({ profile, ref, lang }) },
  };
}

/** The localized text from `POST /api/summary`'s status + body, or null (keep the regex text). */
export function summaryText(status: number, body: any): string | null {
  return status === 200 && body && typeof body.text === "string" && body.text.trim() ? body.text.trim() : null;
}
