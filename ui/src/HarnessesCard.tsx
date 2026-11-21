import { useEffect, useState } from "react";
import type { ProfileView, StatsGroup, StatsResult } from "./contract";
import { formatCost, formatSpend } from "./format";
import { harnessStatsUrl } from "./stats";
import { useT } from "./i18n/react";

/** "25s"/"1.4m" — a run_end-joined wall time; "—" when the group has none. */
function fmtWallMs(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  return s < 60 ? `${s.toFixed(1)}s` : `${(s / 60).toFixed(1)}m`;
}

/**
 * Which backend is worth routing to (#646): per-harness success rate, wall time, output
 * throughput and cost over the last 7 days. Shown when the profile configures named harnesses
 * (its slots chip is up, even with the receiver down), or when the 7-day result already has a
 * group other than `(none)` (a harness ran before `harnesses` was removed from config, or before
 * the receiver booted this session — data is read straight from the state dir, so it's available
 * even then). Otherwise there's nothing to route between, so it stays hidden. Pulled out as a
 * pure function so both branches are unit-testable without waiting on the fetch effect below.
 */
export function harnessesVisible(configured: boolean, groups: StatsGroup[]): boolean {
  return configured || groups.some((g) => g.key !== "(none)");
}

/**
 * The Statistics page's Harnesses card (moved off Overview, #754; the table itself is #646):
 * per-harness slots in use (live from the profile, #788), success rate, wall time, output
 * throughput and cost. It fetches
 * `GET /api/harness-stats` itself — that endpoint has no range parameter, so the window is a
 * fixed 7 days, whatever the range selector above says — and returns `null` (no card frame at
 * all) when `harnessesVisible` says there's nothing to route between.
 */
export function HarnessesCard({ profile }: { profile: ProfileView }) {
  const { t, lang } = useT();
  const [data, setData] = useState<StatsResult | null>(null);
  useEffect(() => {
    let live = true;
    fetch(harnessStatsUrl(profile.name))
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((b: StatsResult) => live && setData(b))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [profile.name]);

  const configured = !!profile.harnesses && Object.keys(profile.harnesses).length > 0;
  const groups = data?.groups ?? [];
  if (!harnessesVisible(configured, groups)) return null;

  // One row per 7-day group, plus every configured harness without one yet (no runs in the
  // window) so its live slots stay visible even before its first run (#788).
  const groupByKey = new Map(groups.map((g) => [g.key, g]));
  const rows: { key: string; g: StatsGroup | null }[] = [
    ...groups.map((g) => ({ key: g.key, g })),
    ...Object.keys(profile.harnesses ?? {})
      .filter((key) => !groupByKey.has(key))
      .map((key) => ({ key, g: null })),
  ];

  // The same frame as StatsView's Card (kept local to avoid an import cycle).
  return (
    <section className="min-w-0 rounded-lg border border-border bg-surface px-3 py-3 lg:col-span-2 2xl:col-span-1" data-harnesses-card>
      <h2 className="text-label font-semibold uppercase tracking-wide text-muted">{t("statsView.harnesses")}</h2>
      <p className="mb-2 text-meta text-muted">{t("statsView.harnessesNote")}</p>
      {/* overflow-x-auto so a narrow viewport scrolls the card, not the page. */}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm" data-harnesses-table>
          <thead className="text-left text-muted">
            <tr>
              <th className="px-3 py-2">{t("statsView.harnessesCol.harness")}</th>
              <th className="px-3 py-2">{t("statsView.harnessesCol.slots")}</th>
              <th className="px-3 py-2">{t("statsView.harnessesCol.runs")}</th>
              <th className="px-3 py-2">{t("statsView.harnessesCol.success")}</th>
              <th className="px-3 py-2">{t("statsView.harnessesCol.p50")}</th>
              <th className="px-3 py-2">{t("statsView.harnessesCol.outPerMin")}</th>
              <th className="px-3 py-2">{t("statsView.harnessesCol.cost")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-subtle">
            {rows.map(({ key, g }) => {
              // Live slots only while the receiver is up and the harness is still configured;
              // `(none)`, an unconfigured harness, or a down receiver reads —.
              const slot = profile.up ? profile.harnesses?.[key] ?? null : null;
              return (
                <HarnessRow
                  key={key}
                  name={key}
                  g={g}
                  lang={lang}
                  slotText={slot ? `${slot.active}/${slot.max ?? "∞"}` : "—"}
                  slotTitle={slot ? (slot.max === null ? t("overview.harnessUncapped", { name: key, active: slot.active }) : t("overview.harnessTitle", { name: key, active: slot.active, max: slot.max })) : null}
                />
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function HarnessRow({ name, g, lang, slotText, slotTitle }: { name: string; g: StatsGroup | null; lang: string; slotText: string; slotTitle: string | null }) {
  // Reported and estimated cost are shown apart, never summed (formatSpend, src/pricing.js).
  const spend = g ? formatSpend({ reported: g.costUsd, est: g.estUsd }) || formatCost(0, lang) : "—";
  return (
    <tr>
      <td className="whitespace-nowrap px-3 py-2 font-mono">{name}</td>
      <td className="whitespace-nowrap px-3 py-2 font-mono" {...(slotTitle ? { title: slotTitle } : {})}>{slotText}</td>
      <td className="whitespace-nowrap px-3 py-2 font-mono">{g ? g.runs : 0}</td>
      <td className="whitespace-nowrap px-3 py-2 font-mono">{g === null || g.successRate === null ? "—" : `${Math.round(g.successRate * 100)}%`}</td>
      <td className="whitespace-nowrap px-3 py-2 font-mono">{fmtWallMs(g?.wallP50Ms ?? null)}</td>
      <td className="whitespace-nowrap px-3 py-2 font-mono">{g === null || g.outPerMin === null ? "—" : Math.round(g.outPerMin).toLocaleString(lang)}</td>
      <td className="whitespace-nowrap px-3 py-2 font-mono">{spend}</td>
    </tr>
  );
}
