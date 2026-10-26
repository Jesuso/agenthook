import type { ProfileView, Snapshot } from "./contract";
import { formatAgents, formatLastEvent, formatSpend, formatRelative, profileBadge, profileLabel, quotaPausedTitle } from "./format";
import { buildHome } from "./home";
import type { CardModel } from "./home";
import { hashFor } from "./route";
import { FullAutoShield, Menu, Pill, ProfileMark, ReceiverStatus } from "./components";
import { accentStyle } from "./identity";
import type { MenuItem } from "./components";
import { rich, useT } from "./i18n/react";

export type HomePageProps = {
  snapshot: Snapshot;
  now: number;
  /** The ⋯ menu for a profile (restart, pause, remove… — owned by App, which holds their state). */
  menuItems: (p: ProfileView) => MenuItem[];
  /** A small status line under a card's title (removal / restart pending), "" for none. */
  note: (p: ProfileView) => string;
};

/** Home: one card per profile led by its Needs-you number; down profiles fold into a muted strip. */
export function HomePage({ snapshot, now, menuItems, note }: HomePageProps) {
  const { t } = useT();
  const { active, inactive } = buildHome(snapshot, now);
  const displayId = (p: ProfileView) => (p.lastEvent ? snapshot.tickets.find((t) => t.profile === p.name && t.ref === p.lastEvent?.ref)?.displayId ?? null : null);

  if (!snapshot.profiles.length)
    return (
      <p className="text-body text-muted">
        {rich(t("home.empty"), { cmd: <code className="font-mono">agenthook init</code> })}
      </p>
    );

  return (
    <div className="mx-auto max-w-6xl">
      <h1 className="mb-4 text-title font-semibold">{t("home.profiles")}</h1>
      {active.length > 0 && (
        <div data-home-grid className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {active.map((c) => (
            <ProfileCard key={c.profile.name} card={c} now={now} lastEventId={displayId(c.profile)} items={menuItems(c.profile)} note={note(c.profile)} />
          ))}
        </div>
      )}
      {inactive.length > 0 && (
        <section data-inactive className={active.length ? "mt-8" : ""}>
          <h2 className="mb-2 text-label font-semibold uppercase tracking-wide text-muted">{t("home.inactive", { count: inactive.length })}</h2>
          <ul className="divide-y divide-border-subtle rounded-lg border border-border bg-surface">
            {inactive.map((c) => (
              <InactiveRow key={c.profile.name} p={c.profile} now={now} items={menuItems(c.profile)} note={note(c.profile)} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}


/** The card's headline: how many tickets need a human; red when any failed, amber when only held. */
function NeedsYou({ n, hasFailed }: { n: number; hasFailed: boolean }) {
  const { t } = useT();
  const tone = n === 0 ? "text-muted" : hasFailed ? "text-status-failed" : "text-status-held";
  return (
    <div data-needs-you={n}>
      <div className="text-label uppercase tracking-wide text-muted">{t("home.needsYou")}</div>
      {n === 0 ? (
        <div className="text-title leading-8 text-muted">{t("home.allClear")}</div>
      ) : (
        <div className={`font-mono text-stat font-semibold tabular-nums ${tone}`}>{n}</div>
      )}
    </div>
  );
}

function ProfileCard({ card, now, lastEventId, items, note }: { card: CardModel; now: number; lastEventId: string | null; items: MenuItem[]; note: string }) {
  const { t, lang } = useT();
  const { profile: p, summary, hasFailed } = card;
  const badge = profileBadge(p, lang);
  const last = formatLastEvent(p.lastEvent, lastEventId, now, lang);
  return (
    <article
      data-profile-card={p.name}
      style={accentStyle(p.color)}
      className="relative overflow-hidden rounded-lg border border-border bg-surface p-4 transition-colors hover:border-border-strong hover:bg-surface-raised focus-within:border-border-strong"
    >
      <span aria-hidden="true" data-accent-bar className="absolute inset-x-0 top-0 h-[3px] bg-[var(--profile-accent)]" />
      <div className="flex items-start gap-3">
        <ProfileMark p={p} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            {/* Stretched link: the whole card opens the profile; the ⋯ menu sits above it. */}
            <a href={hashFor({ kind: "profile", profile: p.name, view: "overview" })} className="truncate font-mono text-title font-semibold after:absolute after:inset-0 focus-visible:outline-2 focus-visible:outline-accent" title={p.configPath ?? undefined}>
              {profileLabel(p)}
            </a>
            {p.fullAuto && <FullAutoShield />}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1">
            <ReceiverStatus p={p} />
            {p.paused === true && (
              <Pill tone="held" title={t("home.pausedTitle")}>
                {t("home.paused")}
              </Pill>
            )}
            {p.quotaPaused && (
              <Pill tone="held" title={quotaPausedTitle(p.quotaPaused, lang)}>
                {t("home.quotaPaused")}
              </Pill>
            )}
            {badge && (
              <Pill tone={badge.kind === "missing" ? "held" : "neutral"} title={badge.title}>
                {badge.text}
              </Pill>
            )}
            {p.tracker && <Pill>{p.tracker}</Pill>}
          </div>
        </div>
        <div className="relative z-10">
          <Menu label={t("common.actions", { name: p.label || p.name })} items={items} />
        </div>
      </div>

      <div className="mt-4">
        <NeedsYou n={summary.needsYou} hasFailed={hasFailed} />
      </div>

      <dl className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-label text-muted">
        <Stat label={t("common.agents")}>{formatAgents(p)}</Stat>
        <Stat label={t("common.queued")}>{p.queued ?? "—"}</Stat>
        {summary.costToday + summary.estToday > 0 && <Stat label={t("home.costToday")}>{formatSpend({ reported: summary.costToday, est: summary.estToday })}</Stat>}
      </dl>

      {p.lastEvent && (
        <p className="mt-3 truncate text-label text-muted" title={last.title}>
          {last.text}
        </p>
      )}
      {note && <p className="mt-1 text-label text-status-held">{note}</p>}
    </article>
  );
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-1.5">
      <dt>{label}</dt>
      <dd className="font-mono text-fg">{children}</dd>
    </div>
  );
}

function InactiveRow({ p, now, items, note }: { p: ProfileView; now: number; items: MenuItem[]; note: string }) {
  const { t, lang } = useT();
  const badge = profileBadge(p, lang);
  return (
    <li data-inactive-row={p.name} className="relative flex items-center gap-3 px-3 py-2 text-body text-muted hover:bg-surface-raised">
      <ProfileMark p={p} size="sm" />
      <a href={hashFor({ kind: "profile", profile: p.name, view: "overview" })} className="font-mono text-fg after:absolute after:inset-0 focus-visible:outline-2 focus-visible:outline-accent">
        {profileLabel(p)}
      </a>
      <ReceiverStatus p={p} />
      {badge && (
        <Pill tone={badge.kind === "missing" ? "held" : "neutral"} title={badge.title}>
          {badge.text}
        </Pill>
      )}
      <span className="text-label">{t("home.lastSeen", { when: formatRelative(p.lastSeenAt, now, lang) })}</span>
      {note && <span className="text-label text-status-held">{note}</span>}
      <div className="relative z-10 ml-auto">
        <Menu label={t("common.actions", { name: p.label || p.name })} items={items} />
      </div>
    </li>
  );
}
