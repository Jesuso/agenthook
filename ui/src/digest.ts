import type { DigestView } from "./contract";
import type { FeedEntry } from "./feed";
import { translate } from "./i18n";

const guarded = (method: string, body: unknown): RequestInit => ({ method, headers: { "Content-Type": "application/json", "X-AH-UI": "1" }, body: JSON.stringify(body) });

/** Generate (or join the running) digest in the UI language `lang`: `POST /api/digest`. It answers when the agent is done. */
export function digestRequest(profile: string, lang?: string): { url: string; init: RequestInit } {
  return { url: "/api/digest", init: guarded("POST", lang ? { profile, lang } : { profile }) };
}

/** The cached digest in `lang`: `GET /api/digest?profile=&lang=`. */
export function digestUrl(profile: string, lang?: string): string {
  return `/api/digest?profile=${encodeURIComponent(profile)}${lang ? `&lang=${encodeURIComponent(lang)}` : ""}`;
}

export type DigestOutcome = { ok: true; digest: DigestView } | { ok: false; error: string };

/** Map `POST /api/digest`'s status + body (0 = network error) to its outcome; the error reads in `lang`. */
export function digestOutcome(status: number, body: any, lang = "en"): DigestOutcome {
  if (status === 200 && body && typeof body.text === "string") return { ok: true, digest: body as DigestView };
  if (status === 502) return { ok: false, error: typeof body?.error === "string" ? body.error : translate(lang, "shell.digest.agentFailed") };
  if (status === 503) return { ok: false, error: translate(lang, "shell.digest.down") };
  if (status === 504) return { ok: false, error: translate(lang, "shell.digest.timeout") };
  if (status === 0) return { ok: false, error: translate(lang, "shell.digest.network") };
  return { ok: false, error: translate(lang, "shell.digest.status", { status }) };
}

/** Meaningful live events (run_end, failed, blocked, pipeline_done, merged) since the digest was written. */
export const MEANINGFUL = new Set(["run_end", "failed", "blocked", "pipeline_done", "merged"]);
export function eventsSince(feed: FeedEntry[], generatedAt: string): number {
  const at = Date.parse(generatedAt);
  if (Number.isNaN(at)) return 0;
  return feed.filter((f) => MEANINGFUL.has(String(f.event.event)) && Date.parse(String(f.event.ts)) > at).length;
}
