import { Suspense, lazy, useEffect, useState } from "react";
import type { DigestView } from "./contract";
import { digestOutcome, digestRequest, digestUrl, eventsSince } from "./digest";
import type { FeedEntry } from "./feed";
import { formatCost, formatRelative } from "./format";
import { ShowHide, SpeakButton } from "./components";
import { useT } from "./i18n/react";

// react-markdown ships in the same lazy chunk as the Instructions preview, not the main bundle.
const DigestMarkdown = lazy(() => import("./DigestMarkdown"));

/**
 * "Catch me up": the profile's latest Digest (docs/web-ui.md § Digest agent) and the button that
 * asks the receiver for a fresh one. Never automatic — an agent run costs money. The digest is per
 * UI language: the cached text is fetched once per profile and language; the stale hint counts live
 * events since it was written.
 */
export function DigestPanel({ profile, up, feed, now }: { profile: string; up: boolean; feed: FeedEntry[]; now: number }) {
  const { t, lang } = useT();
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
    fetch(digestUrl(profile, lang))
      .then((r) => (r.ok ? r.json() : null))
      .then((b) => live && setDigest(b?.digest ?? null))
      .catch(() => {})
      .finally(() => live && setLoaded(true));
    return () => {
      live = false;
    };
  }, [profile, lang]);

  const generate = async () => {
    setBusy(true);
    setError(null);
    const { url, init } = digestRequest(profile, lang);
    const out = await fetch(url, init)
      .then((res) => res.json().then((b) => digestOutcome(res.status, b, lang), () => digestOutcome(res.status, null, lang)))
      .catch(() => digestOutcome(0, null, lang));
    setBusy(false);
    if (out.ok) setDigest(out.digest);
    else setError(out.error);
  };

  const since = digest ? eventsSince(feed, digest.generatedAt) : 0;
  const button = digest ? t("digest.refresh") : t("digest.write");
  const stale = digestStale(digest, now);
  const showBody = loaded && (!stale || expanded);
  const bodyId = `digest-body-${profile}`;

  return (
    <section data-digest>
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 className="text-label font-semibold uppercase tracking-wide text-muted">{t("digest.title")}</h2>
        {digest && (
          <p className="text-label text-muted" data-digest-meta>
            {t("digest.snapshotFrom", { when: formatRelative(digest.generatedAt, Math.max(now, Date.parse(digest.generatedAt)), lang) })}
            {digest.costUsd !== undefined && ` · ${t("digest.cost", { cost: formatCost(digest.costUsd, lang) })}`}
            {since > 0 && <span className="text-fg"> · {t("digest.newEvents", { count: since })}</span>}
          </p>
        )}
        <div className="ml-auto flex items-center gap-2">
          {digest && showBody && <SpeakButton text={digest.text} label={t("speak.digest")} />}
          {stale && (
            <ShowHide open={expanded} onToggle={() => setExpanded(!expanded)} controls={bodyId} label={t("digest.label")} data-digest-toggle />
          )}
          {/* Down: say why in words, not in a tooltip on a dead button keyboard and touch can't reach. */}
          {!up ? (
            <span className="text-label text-muted" data-digest-down>
              {t("digest.down")}
            </span>
          ) : (
          <button
            type="button"
            disabled={busy}
            title={t("digest.buttonTitle")}
            onClick={() => void generate()}
            className="rounded-md border border-border px-2 py-0.5 text-label font-medium hover:bg-surface-raised focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50 disabled:hover:bg-transparent"
          >
            {busy ? t("digest.writing") : button}
          </button>
          )}
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
            <p className="text-body text-muted">{t("digest.empty")}</p>
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
