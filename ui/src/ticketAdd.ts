import { translate } from "./i18n";

// The New ticket action's pure half (POST /api/ticket, src/ui/server.js): the guarded request
// and the status → outcome / text mapping. The Overview's NewTicketModal drives it.

/** A `POST /api/ticket` body (title required; the rest optional). */
export type TicketAddArgs = { profile: string; title: string; body?: string; step?: string; blockedBy?: string };

/** What a create answers with (200): the new ref, its starting step, stage, and any open blockers. */
export type TicketCreated = { ref: string; step?: string; stage?: string; blockedBy?: string[] };

export type TicketAddOutcome = { ok: true; ticket: TicketCreated } | { ok: false; error: string };

/** The guarded POST: JSON content type + `X-AH-UI: 1`; the browser adds Origin. */
export function ticketAddRequest(args: TicketAddArgs): { url: string; init: RequestInit } {
  const body: Record<string, unknown> = { profile: args.profile, title: args.title };
  if (args.body) body.body = args.body;
  if (args.step) body.step = args.step;
  if (args.blockedBy) body.blockedBy = args.blockedBy;
  return {
    url: "/api/ticket",
    init: { method: "POST", headers: { "Content-Type": "application/json", "X-AH-UI": "1" }, body: JSON.stringify(body) },
  };
}

/** 200 → created; 409/502 → the server's reason as written; 503/504 → translated; anything else (incl. network `0`) → translated. */
export function ticketAddOutcome(status: number, body: unknown, lang = "en"): TicketAddOutcome {
  const err = body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string" ? (body as { error: string }).error : null;
  if (status === 200 && body && typeof body === "object" && typeof (body as { ref?: unknown }).ref === "string")
    return { ok: true, ticket: body as TicketCreated };
  if (status === 409 || status === 502) return { ok: false, error: err ?? translate(lang, "ticket.statusN", { status }) };
  if (status === 503) return { ok: false, error: translate(lang, "ticket.down") };
  if (status === 504) return { ok: false, error: translate(lang, "ticket.timeout") };
  if (status === 0) return { ok: false, error: translate(lang, "ticket.network") };
  return { ok: false, error: err ?? translate(lang, "ticket.statusN", { status }) };
}
