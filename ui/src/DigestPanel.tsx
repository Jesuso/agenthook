import { Suspense, lazy, useEffect, useState } from "react";
import type { DigestView } from "./contract";
import { digestOutcome, digestRequest, digestUrl, eventsSince } from "./digest";
import type { FeedEntry } from "./feed";
import { formatCost, formatRelative } from "./format";

// react-markdown ships in the same lazy chunk as the Instructions preview, not the main bundle.
const DigestMarkdown = lazy(() => import("./DigestMarkdown"));

/**
 * "Catch me up": the profile's latest Digest (docs/web-ui.md § Digest agent) and the button that
 * asks the receiver for a fresh one. Never automatic — an agent run costs money. The cached text
 * is fetched once per profile; the stale hint counts live events since it was written.
 */
export function DigestPanel({ profile, up, feed, now }: { profile: string; up: boolean; feed: FeedEntry[]; now: number }) {
  const [digest, setDigest] = useState<DigestView | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let live = true;
    setDigest(null);
    setLoaded(false);
    setError(null);
    setExpanded(false);
    fetch(digestUrl(profile))
      .then((r) => (r.ok ? r.json() : null))
      .then((b) => live && setDigest(b?.digest ?? null))
      .catch(() => {})
      .finally(() => live && setLoaded(true));
    return () => {
      live = false;
    };
  }, [profile]);

  const generate = async () => {
    setBusy(true);
    setError(null);
    const { url, init } = digestRequest(profile);
    const out = await fetch(url, init)
      .then((res) => res.json().then((b) => digestOutcome(res.status, b), () => digestOutcome(res.status, null)))
      .catch(() => digestOutcome(0, null));
    setBusy(false);
    if (out.ok) setDigest(out.digest);
    else setError(out.error);
  };

  const since = digest ? eventsSince(feed, digest.generatedAt) : 0;
  const button = digest ? "Refresh digest" : "Write a digest";
  const stale = digestStale(digest, now);
  const showBody = loaded && (!stale || expanded);
  const bodyId = `digest-body-${profile}`;

  return (
    <section data-digest>
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 className="text-label font-semibold uppercase tracking-wide text-muted">Catch me up</h2>
        {digest && (
          <p className="text-label text-muted" data-digest-meta>
            snapshot from {formatRelative(digest.generatedAt, Math.max(now, Date.parse(digest.generatedAt)))}
            {digest.costUsd !== undefined && ` · cost ${formatCost(digest.costUsd)}`}
            {since > 0 && <span className="text-fg"> · {since} new {since === 1 ? "event" : "events"} since</span>}
          </p>
        )}
        <div className="ml-auto flex items-center gap-2">
          {stale && (
            <button
              type="button"
              aria-expanded={expanded}
              aria-controls={bodyId}
              data-digest-toggle
              onClick={() => setExpanded(!expanded)}
              className="rounded-md px-2 py-0.5 text-label text-muted hover:bg-surface-raised hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"
            >
              {expanded ? "Hide" : "Show"}
            </button>
          )}
          <button
            type="button"
            disabled={busy || !up}
            title={up ? "Runs a short, tool-less agent over this profile's activity (costs a few cents)" : "Needs the receiver running: it spawns the digest agent"}
            onClick={() => void generate()}
            className="rounded-md border border-border px-2 py-0.5 text-label font-medium hover:bg-surface-raised focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50 disabled:hover:bg-transparent"
          >
            {busy ? "Writing…" : button}
          </button>
        </div>
      </div>
      {error && (
        <p role="alert" className="mb-2 text-label text-status-failed">
          {error}
        </p>
      )}
      {showBody && (
        <div id={bodyId} className="rounded-lg border border-border bg-surface px-3 py-3">
          {digest ? (
            <Suspense fallback={<p className="whitespace-pre-wrap text-body text-fg">{digest.text}</p>}>
              <DigestMarkdown text={digest.text} />
            </Suspense>
          ) : (
            <p className="text-body text-muted">No digest yet. An agent will read this profile's activity and tell you what needs you.</p>
          )}
        </div>
      )}
    </section>
  );
}

/** A digest older than a day is collapsed by default: it may contradict the live zones above it. */
export const DIGEST_STALE_MS = 24 * 3600e3;
export function digestStale(digest: DigestView | null, now: number): boolean {
  return !!digest && now - Date.parse(digest.generatedAt) > DIGEST_STALE_MS;
}
