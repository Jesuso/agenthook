import { useEffect, useState } from "react";
import type { DigestView } from "./contract";
import { digestOutcome, digestRequest, digestUrl, eventsSince } from "./digest";
import type { FeedEntry } from "./feed";
import { formatCost, formatRelative } from "./format";

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

  useEffect(() => {
    let live = true;
    setDigest(null);
    setLoaded(false);
    setError(null);
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
  const button = digest ? "Refresh" : "Catch me up";

  return (
    <section data-digest>
      <h2 className="mb-2 text-label font-semibold uppercase tracking-wide text-muted">Catch me up</h2>
      <div className="rounded-lg border border-border bg-surface px-3 py-3">
        {!loaded ? null : digest ? (
          <>
            <p className="whitespace-pre-wrap text-body text-fg" data-digest-text>
              {digest.text}
            </p>
            <p className="mt-2 text-meta text-faint">
              {formatRelative(digest.generatedAt, now)}
              {digest.costUsd !== undefined && ` · ${formatCost(digest.costUsd)}`}
              {since > 0 && <span className="text-status-held"> · {since} new {since === 1 ? "event" : "events"} since</span>}
            </p>
          </>
        ) : (
          <p className="text-body text-muted">No digest yet. An agent will read this profile's activity and tell you what needs you.</p>
        )}
        {error && (
          <p role="alert" className="mt-2 text-label text-status-failed">
            {error}
          </p>
        )}
        <div className="mt-3">
          <button
            type="button"
            disabled={busy || !up}
            title={up ? "Runs a short, tool-less agent over this profile's activity (costs a few cents)" : "The receiver is not running"}
            onClick={() => void generate()}
            className="rounded-md bg-accent px-3 py-1 text-label font-medium text-accent-fg disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-accent"
          >
            {busy ? "Writing…" : button}
          </button>
        </div>
      </div>
    </section>
  );
}
